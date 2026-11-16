import { open, stat } from "node:fs/promises";
import { FLOW, publicText } from "./flow.js";
import { validFlow } from "./flow-store.js";

const BLOCK_BYTES = 64 * 1024;
const HEADER_BYTES = 64 * 1024;
const PREFIX_BYTES = 4096;
const ANCHOR_BYTES = 256;
const terminal = new Set(["completed", "failed", "cancelled", "skipped", "interrupted", "incomplete"]);
class ChangedFile extends Error {}

function check(signal) {
  signal?.throwIfAborted();
}

async function bytes(file, start, length, signal) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    check(signal);
    const result = await file.read(buffer, offset, length - offset, start + offset);
    if (!result.bytesRead) throw new ChangedFile();
    offset += result.bytesRead;
  }
  return buffer;
}

/** Inspect envelope metadata only, before deciding whether to decode a public body. */
function kind(buffer) {
  const text = buffer.toString("utf8");
  const stack = [];
  let type;
  let customType;
  let role;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      let closed = false;
      while (++i < text.length) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') { closed = true; break; }
      }
      if (!closed) return;
      const frame = stack.at(-1);
      let next = i + 1;
      while (/\s/.test(text[next] ?? "") && next < text.length) next++;
      const metadata = stack.length === 1 || (stack.length === 2 && frame?.parent === "message");
      if (metadata && (text[next] === ":" || (stack.length === 1 && ["type", "customType"].includes(frame?.key)) ||
          (stack.length === 2 && frame?.key === "role"))) {
        let value;
        try { value = JSON.parse(text.slice(start, i + 1)); }
        catch { return; }
        if (text[next] === ":") frame.key = value;
        else if (stack.length === 1 && frame?.key === "type") type = value;
        else if (stack.length === 1 && frame?.key === "customType") customType = value;
        else if (stack.length === 2 && frame?.key === "role") role = value;
      }
      if (type === "title" || type === "session") return type;
      if (type === "custom" && customType !== undefined) return customType === FLOW ? "flow" : undefined;
      if (type === "message" && role !== undefined) return role === "user" ? "user" : undefined;
      if (type !== undefined && type !== "custom" && type !== "message") return;
    } else if (char === "{" || char === "[") {
      stack.push({ parent: stack.at(-1)?.key });
    } else if (char === "}" || char === "]") {
      stack.pop();
    }
  }
}

function decode(buffer) {
  try { return JSON.parse(buffer.toString("utf8")); }
  catch (error) { if (error instanceof SyntaxError) return; throw error; }
}

async function header(file, size, signal) {
  const leading = await bytes(file, 0, Math.min(size, HEADER_BYTES), signal);
  let session;
  let title;
  let start = 0;
  for (let end = leading.indexOf(10); end !== -1; end = leading.indexOf(10, start)) {
    const line = leading.subarray(start, end);
    start = end + 1;
    const type = kind(line.subarray(0, PREFIX_BYTES));
    if (type !== "title" && type !== "session") break;
    const entry = decode(line);
    if (type === "title" && entry?.type === "title" && typeof entry.title === "string") title = publicText(entry.title);
    if (type === "session" && entry?.type === "session" && Number.isInteger(entry.version) && entry.version > 0 &&
        typeof entry.id === "string" && entry.id.trim() && typeof entry.cwd === "string") session = entry;
  }
  if (!session) return;
  return { sessionId: session.id, cwd: session.cwd, title: title ?? publicText(session.title) };
}

async function publicEntry(file, start, end, prefix, signal) {
  if (start === end) return;
  const length = end - start;
  const type = kind(prefix?.length >= Math.min(length, PREFIX_BYTES)
    ? prefix.subarray(0, Math.min(length, PREFIX_BYTES))
    : await bytes(file, start, Math.min(length, PREFIX_BYTES), signal));
  if (type !== "flow" && type !== "user" && type !== "title") return;
  const entry = decode(await bytes(file, start, length, signal));
  if (type === "flow" && entry?.type === "custom" && entry.customType === FLOW && validFlow(entry.data)) {
    return { type, offset: start, flow: entry.data };
  }
  if (type === "title" && entry?.type === "title" && typeof entry.title === "string") {
    return { type, title: publicText(entry.title) };
  }
  if (type !== "user" || entry?.type !== "message" || entry.message?.role !== "user" ||
      typeof entry.id !== "string" || !entry.id) return;
  const content = entry.message.content;
  const text = publicText(content);
  const images = Array.isArray(content) ? content.filter(part => part?.type === "image").length : 0;
  if (!text.trim() && !images) return;
  return { type, offset: start, requestId: entry.id, request: text.trim() ? text : `[Image input: ${images}]` };
}

/** Frame backwards by offsets: even multi-GB nonpublic lines never get concatenated. */
async function latest(file, size, state, signal) {
  let end = null;
  state.partialStart = 0;
  for (let position = size; position > 0;) {
    check(signal);
    const start = Math.max(0, position - BLOCK_BYTES);
    const block = await bytes(file, start, position - start, signal);
    for (let i = block.length - 1; i >= 0; i--) {
      if (block[i] !== 10) continue;
      const offset = start + i;
      if (end === null) {
        state.partialStart = offset + 1;
      } else {
        const event = await publicEntry(file, offset + 1, end, block.subarray(i + 1), signal);
        if (event?.type === "flow" && !state.flow) state.flow = event;
        if (event?.type === "user" && !state.user) state.user = event;
        if (state.flow && (publicText(state.flow.flow.request).trim() || state.user)) return;
      }
      end = offset;
    }
    position = start;
  }
  if (end !== null) {
    const event = await publicEntry(file, 0, end, undefined, signal);
    if (event?.type === "flow" && !state.flow) state.flow = event;
    if (event?.type === "user" && !state.user) state.user = event;
  }
}

/** Consume new bytes only; an unfinished line is decoded once its newline arrives. */
async function appended(file, size, state, signal) {
  let lineStart = state.partialStart;
  for (let position = state.size; position < size;) {
    check(signal);
    const block = await bytes(file, position, Math.min(BLOCK_BYTES, size - position), signal);
    for (let i = block.indexOf(10); i !== -1; i = block.indexOf(10, i + 1)) {
      const end = position + i;
      const prefix = lineStart >= position ? block.subarray(lineStart - position, i) : undefined;
      const event = await publicEntry(file, lineStart, end, prefix, signal);
      if (event?.type === "flow") state.flow = event;
      if (event?.type === "user") state.user = event;
      if (event?.type === "title") state.header.title = event.title;
      lineStart = end + 1;
    }
    position += block.length;
  }
  state.partialStart = lineStart;
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function unchanged(a, b) {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function record(source, state) {
  if (!state.header) return;
  const stored = state.flow;
  const flow = stored && !(terminal.has(stored.flow.status) && state.user?.offset > stored.offset) ? stored.flow : null;
  const flowRequest = flow && publicText(flow.request);
  const request = flowRequest?.trim() ? flowRequest : state.user?.request || "";
  if (!flow && !request) return;
  const { sessionId, cwd, title } = state.header;
  return { version: 1, key: `session-${source.pid}-${sessionId}`, pid: source.pid, sessionId,
    sessionFile: source.sessionFile, cwd, updatedAt: state.mtimeMs, source: "session", title,
    request, requestId: flow ? flow.id : state.user.requestId, flow };
}

/** Read only the open session sources supplied by live-host discovery. */
export function createSavedFlowReader({ signal } = {}) {
  const cache = new Map();
  return async function readSavedFlows(sources) {
    check(signal);
    const present = new Set(sources.map(source => source.sessionFile));
    for (const key of cache.keys()) if (!present.has(key)) cache.delete(key);
    const records = [];
    for (const source of sources) {
      check(signal);
      if (!Number.isSafeInteger(source.pid) || source.pid <= 0 || typeof source.sessionFile !== "string") continue;
      let file;
      try {
        const observed = await stat(source.sessionFile);
        let state = cache.get(source.sessionFile);
        if (!state || !unchanged(state, observed)) {
          file = await open(source.sessionFile, "r");
          const current = await file.stat();
          let incremental = state?.header && sameIdentity(state, current) && current.size > state.size;
          if (incremental && state.anchor.length) {
            const anchor = await bytes(file, state.size - state.anchor.length, state.anchor.length, signal);
            incremental = anchor.equals(state.anchor);
          }
          if (incremental) {
            state = { ...state, header: { ...state.header } };
            await appended(file, current.size, state, signal);
          } else {
            state = { header: await header(file, current.size, signal) };
            if (state.header) await latest(file, current.size, state, signal);
          }
          state.anchor = await bytes(file, Math.max(0, current.size - ANCHOR_BYTES), Math.min(current.size, ANCHOR_BYTES), signal);
          Object.assign(state, { dev: current.dev, ino: current.ino, size: current.size,
            mtimeMs: current.mtimeMs, ctimeMs: current.ctimeMs });
          cache.set(source.sessionFile, state);
        }
        const info = record(source, state);
        if (info) records.push(info);
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ENOTDIR" && !(error instanceof ChangedFile)) throw error;
        cache.delete(source.sessionFile);
      } finally {
        await file?.close();
      }
    }
    check(signal);
    return records.sort((a, b) => a.key.localeCompare(b.key));
  };
}
