import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, ftruncateSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlow, FLOW } from "../flow.js";
import { createSavedFlowReader } from "../saved-flow.js";

function temporary(t) {
  const root = mkdtempSync(path.join(tmpdir(), "strataa-saved-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const line = entry => `${JSON.stringify(entry)}\n`;
const metadata = (id, title = "Session title") => line({ type: "title", v: 1, title, updatedAt: 1 }) +
  line({ type: "session", version: 3, id, timestamp: "2026-11-13T00:00:00.000Z", cwd: `/work/${id}`, title: "Older title" });
const user = (id, content) => ({ type: "message", id, parentId: null, timestamp: "2026-11-13T00:01:00.000Z", message: { role: "user", content } });
const saved = flow => ({ type: "custom", id: `entry-${flow.id}`, parentId: null, timestamp: "2026-11-13T00:02:00.000Z", customType: FLOW, data: flow });
const source = (sessionFile, pid = 123) => ({ pid, sessionFile });
function session(t, name, entries = []) {
  const file = path.join(temporary(t), `${name}.jsonl`);
  writeFileSync(file, metadata(name) + entries.map(line).join(""));
  return file;
}

test("latest stored Flow is preserved without restoring or inventing its running status", async t => {
  const first = createFlow("first", "Earlier request");
  const latest = createFlow("latest", "The current original request\nwith exact spacing  ");
  latest.rows[0].summary = "Public observation";
  const file = session(t, "one", [user("original", "An older input"), saved(first), saved(latest),
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE THOUGHT" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE TOOL BODY" }] } }]);
  const [record] = await createSavedFlowReader()([source(file)]);
  assert.equal(record.key, "session-123-one");
  assert.equal(record.pid, 123);
  assert.equal(record.sessionId, "one");
  assert.equal(record.sessionFile, file);
  assert.equal(record.cwd, "/work/one");
  assert.equal(record.source, "session");
  assert.equal(record.title, "Session title");
  assert.equal(record.request, latest.request);
  assert.equal(record.requestId, latest.id);
  assert.equal(record.flow.status, "running");
  assert.equal(record.flow.rows[0].summary, "Public observation");
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE/);
});

test("multi-GB sparse history uses bounded header and backwards reads, then only appended bytes", async t => {
  const file = path.join(temporary(t), "huge.jsonl");
  const flow = createFlow("huge-flow", "A request whose public Flow is at EOF");
  flow.rows[0].output = "public ".repeat(6000);
  const header = Buffer.from(metadata("huge"));
  const tail = Buffer.from(`\n${line(saved(flow))}`);
  const historyBytes = 3_780_000_000;
  const descriptor = openSync(file, "w");
  try {
    writeSync(descriptor, header, 0, header.length, 0);
    ftruncateSync(descriptor, historyBytes);
    writeSync(descriptor, tail, 0, tail.length, historyBytes);
  } finally {
    closeSync(descriptor);
  }
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe);
  const actualRead = prototype.read;
  await probe.close();
  const reads = [];
  t.mock.method(prototype, "read", function (...args) {
    reads.push({ length: args[2], position: args[3] });
    return actualRead.apply(this, args);
  });
  const reader = createSavedFlowReader();
  assert.equal((await reader([source(file)]))[0].flow.rows[0].output, flow.rows[0].output);
  assert.ok(reads.reduce((sum, read) => sum + read.length, 0) < 512 * 1024);
  reads.length = 0;
  assert.equal((await reader([source(file)]))[0].flow.status, "running");
  assert.deepEqual(reads, []);
  const previousSize = historyBytes + tail.length;
  const completed = { ...flow, status: "completed", updatedAt: flow.updatedAt + 1 };
  appendFileSync(file, line(saved(completed)));
  assert.equal((await reader([source(file)]))[0].flow.status, "completed");
  assert.ok(reads.every(read => read.position >= previousSize - 1024));
});

test("no-flow sessions expose exact latest public user text, not assistant or tool content", async t => {
  const original = "  Original\nrequest\u001b[31m red\u001b[0m\n  ";
  const file = session(t, "plain", [user("earlier", "Earlier input"), user("current", [
    { type: "text", text: original }, { type: "thinking", thinking: "PRIVATE USER BLOCK" },
    { type: "image", data: "PRIVATE IMAGE BYTES", mimeType: "image/png" },
    { type: "text", text: "Second text block" },
  ]), { type: "message", message: { role: "assistant", content: [{ type: "text", text: "NOT THE REQUEST" }, { type: "thinking", thinking: "PRIVATE" }] } },
  { type: "message", message: { role: "toolResult", content: [{ type: "text", text: line(saved(createFlow("fake", "PRIVATE TOOL FLOW"))) }] } }]);
  const [record] = await createSavedFlowReader()([source(file)]);
  assert.equal(record.flow, null);
  assert.equal(record.requestId, "current");
  assert.equal(record.request, "  Original\nrequest red\n  \nSecond text block");
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE|NOT THE REQUEST|fake/);
});

test("image-only genuine requests are explicit without exporting image bodies", async t => {
  const file = session(t, "image", [user("image-request", [{ type: "image", data: "PRIVATE", mimeType: "image/png" }])]);
  const [record] = await createSavedFlowReader()([source(file)]);
  assert.equal(record.flow, null);
  assert.equal(record.requestId, "image-request");
  assert.match(record.request, /image/i);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE/);
});

test("viewer-only, malformed-header and empty-user sessions stay hidden", async t => {
  const viewer = session(t, "viewer", [{ type: "custom", customType: "agent-dialogue-state", data: { enabled: true } }]);
  const empty = session(t, "empty", [user("empty", " \n\t")]);
  const invalid = path.join(temporary(t), "invalid.jsonl");
  writeFileSync(invalid, line({ type: "session", version: 3, id: "invalid" }) + line(user("request", "Must not bypass the header")));
  assert.deepEqual(await createSavedFlowReader()([source(viewer), source(empty, 124), source(invalid, 125)]), []);
});

test("a blank public Flow request falls back to the original user input", async t => {
  const file = session(t, "fallback", [user("original", "  Exact original input\n  "), saved(createFlow("flow-id", ""))]);
  const [record] = await createSavedFlowReader()([source(file)]);
  assert.equal(record.request, "  Exact original input\n  ");
  assert.equal(record.requestId, "flow-id");
  assert.equal(record.flow.id, "flow-id");
});

test("completion is retained until a later request, while running steering keeps the current Flow", async t => {
  const running = createFlow("run", "Original Flow request");
  const file = session(t, "lifecycle", [saved(running)]);
  const reader = createSavedFlowReader();
  const sources = [source(file)];
  assert.equal((await reader(sources))[0].flow.status, "running");
  appendFileSync(file, line(user("steering", "Please adjust the current request")));
  let [record] = await reader(sources);
  assert.equal(record.flow.id, "run");
  assert.equal(record.request, "Original Flow request");
  const completed = { ...running, status: "completed" };
  appendFileSync(file, line(saved(completed)));
  assert.equal((await reader(sources))[0].flow.status, "completed");
  appendFileSync(file, line(user("new-request", "A genuinely new request")));
  [record] = await reader(sources);
  assert.equal(record.flow, null);
  assert.equal(record.request, "A genuinely new request");
  assert.equal(record.requestId, "new-request");
  assert.equal((await createSavedFlowReader()(sources))[0].flow, null);
  appendFileSync(file, line(saved(createFlow("next-run", "A genuinely new request"))));
  [record] = await reader(sources);
  assert.equal(record.flow.id, "next-run");
  assert.equal(record.requestId, "next-run");
});

test("a terminal Flow followed by a request is already unobserved on the first read", async t => {
  for (const status of ["completed", "failed", "cancelled", "interrupted", "incomplete"]) {
    const file = session(t, status, [saved({ ...createFlow("old", "Old request"), status }), user("new", "New request")]);
    const [record] = await createSavedFlowReader()([source(file)]);
    assert.equal(record.flow, null);
    assert.equal(record.request, "New request");
  }
});

test("partial final JSONL entries wait for their newline and complete on a later append", async t => {
  const running = createFlow("partial", "Keep this request");
  const file = session(t, "partial", [saved(running)]);
  const reader = createSavedFlowReader();
  const sources = [source(file)];
  await reader(sources);
  const completion = line(saved({ ...running, status: "completed" }));
  const split = Math.floor(completion.length / 2);
  appendFileSync(file, completion.slice(0, split));
  assert.equal((await reader(sources))[0].flow.status, "running");
  appendFileSync(file, completion.slice(split, -1));
  assert.equal((await reader(sources))[0].flow.status, "running");
  appendFileSync(file, "\n");
  assert.equal((await reader(sources))[0].flow.status, "completed");
  const request = line(user("later", "A new request after the partial completion"));
  appendFileSync(file, request.slice(0, -1));
  assert.equal((await reader(sources))[0].flow.status, "completed");
  appendFileSync(file, "\n");
  assert.equal((await reader(sources))[0].requestId, "later");
  assert.equal((await reader(sources))[0].flow, null);
});

test("initial partial requests and headers become visible only when complete", async t => {
  const file = session(t, "initial-partial");
  const request = line(user("request", "The eventual input"));
  appendFileSync(file, request.slice(0, -1));
  const reader = createSavedFlowReader();
  assert.deepEqual(await reader([source(file)]), []);
  appendFileSync(file, "\n");
  assert.equal((await reader([source(file)]))[0].request, "The eventual input");
  const partialHeader = path.join(temporary(t), "header.jsonl");
  const content = metadata("header") + request;
  writeFileSync(partialHeader, content.slice(0, 30));
  assert.deepEqual(await reader([source(partialHeader)]), []);
  appendFileSync(partialHeader, content.slice(30));
  assert.equal((await reader([source(partialHeader)]))[0].sessionId, "header");
});

test("large unrelated partial lines do not become public events or lose retained Flow", async t => {
  const flow = createFlow("retained", "Keep the public snapshot");
  const file = session(t, "private", [saved(flow)]);
  const reader = createSavedFlowReader();
  const sources = [source(file)];
  await reader(sources);
  const tool = JSON.stringify({ type: "message", id: "tool", message: { role: "toolResult", content: [{ type: "text", text: "PRIVATE".repeat(200_000) }] } });
  appendFileSync(file, tool.slice(0, 700_000));
  assert.equal((await reader(sources))[0].flow.id, "retained");
  appendFileSync(file, tool.slice(700_000) + "\n");
  assert.equal((await reader(sources))[0].flow.id, "retained");
  appendFileSync(file, line(saved({ ...flow, status: "failed" })));
  assert.equal((await reader(sources))[0].flow.status, "failed");
  assert.doesNotMatch(JSON.stringify(await reader(sources)), /PRIVATE/);
});

test("truncation, same-inode regrowth and atomic replacement reset session identity and history", async t => {
  const file = session(t, "before", [saved(createFlow("before-flow", "Old request"))]);
  const reader = createSavedFlowReader();
  const sources = [source(file)];
  assert.equal((await reader(sources))[0].sessionId, "before");
  writeFileSync(file, metadata("truncated") + line(user("short", "Short request")));
  let [record] = await reader(sources);
  assert.equal(record.sessionId, "truncated");
  assert.equal(record.flow, null);
  assert.equal(record.requestId, "short");
  writeFileSync(file, metadata("regrown") + line(user("regrown-request", "New request ".repeat(500))));
  [record] = await reader(sources);
  assert.equal(record.sessionId, "regrown");
  assert.equal(record.flow, null);
  assert.equal(record.requestId, "regrown-request");
  const replacement = path.join(path.dirname(file), "replacement.jsonl");
  writeFileSync(replacement, metadata("atomic") + line(saved({ ...createFlow("atomic-flow", "Atomic rewrite"), status: "completed" })));
  renameSync(replacement, file);
  [record] = await reader(sources);
  assert.equal(record.key, "session-123-atomic");
  assert.equal(record.flow.id, "atomic-flow");
  assert.equal(record.flow.status, "completed");
});

test("invalid Flow snapshots cannot replace the latest valid stored public snapshot", async t => {
  const flow = createFlow("valid", "Recorded public request");
  const file = session(t, "validation", [saved(flow), saved({ ...flow, id: "invalid", rows: [{ id: "bad" }] })]);
  const reader = createSavedFlowReader();
  assert.equal((await reader([source(file)]))[0].flow.id, "valid");
  appendFileSync(file, line(saved({ ...flow, id: "invalid-again", rows: null })));
  assert.equal((await reader([source(file)]))[0].flow.id, "valid");
});

test("independent sources and removals never borrow another session's state", async t => {
  const first = session(t, "first", [saved(createFlow("first-flow", "First Flow"))]);
  const second = session(t, "second", [user("second-request", "Second plain request")]);
  const reader = createSavedFlowReader();
  const sources = [source(first, 123), source(second, 124)];
  let records = await reader(sources);
  assert.equal(records.length, 2);
  assert.equal(records.find(record => record.pid === 124).flow, null);
  assert.equal(records.find(record => record.pid === 124).requestId, "second-request");
  rmSync(first);
  records = await reader(sources);
  assert.deepEqual(records.map(record => record.sessionId), ["second"]);
  assert.deepEqual(await reader([]), []);
  writeFileSync(first, metadata("recreated") + line(user("recreated-request", "After removal")));
  records = await reader([source(first, 123)]);
  assert.equal(records[0].sessionId, "recreated");
  assert.equal(records[0].flow, null);
});

test("abort stops reading and unexpected filesystem errors remain observable", async t => {
  const file = session(t, "abort", [user("request", "A request")]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createSavedFlowReader({ signal: controller.signal })([source(file)]), { name: "AbortError" });
  await assert.rejects(createSavedFlowReader()([source(path.dirname(file))]), { code: "EISDIR" });
});
