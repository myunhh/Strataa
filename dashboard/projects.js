import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const MiB = 1024 * 1024;
const LEVELS = ["field", "problem", "method", "technique"];
const KINDS = ["question", "hypothesis", "decision", "experiment", "result"];
const STATUSES = ["draft", "active", "accepted", "rejected", "superseded"];
const normalize = value => value.replace(/\s+/gu, " ").trim();
const clone = value => structuredClone(value);

export class ProjectError extends Error {
  constructor(message, status = 400) { super(message); this.name = "ProjectError"; this.status = status; }
}
const fail = message => { throw new ProjectError(message); };
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}
function keys(value, expected, label) {
  object(value, label);
  if (Object.keys(value).some(key => !expected.includes(key)) || expected.some(key => !Object.hasOwn(value, key))) fail(`${label} has missing or unknown properties`);
}
function text(value, label, required = false) {
  if (typeof value !== "string" || (required && !value.trim())) fail(`${label} must be ${required ? "a nonempty" : "a"} string`);
  return value;
}
function projectPath(input) {
  text(input, "Project path", true);
  let value = input.trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  text(value, "Project path", true);
  const unc = value.replace(/\\/g, "/").match(/^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/iu);
  if (unc) {
    const distro = process.env.WSL_DISTRO_NAME;
    if (process.platform !== "linux" || !distro) fail("WSL 경로를 변환할 서버 배포판을 확인할 수 없습니다. 서버의 Linux 절대 경로를 입력하세요.");
    if (unc[1].toLowerCase() !== distro.toLowerCase()) fail(`다른 WSL 배포판의 경로입니다: ${unc[1]}. 현재 서버는 ${distro}에서 실행 중입니다.`);
    return unc[2] || "/";
  }
  if (/^(?:[a-z]:|\\\\|\/\/)/iu.test(value)) fail("지원하지 않는 Windows/네트워크 경로입니다. 서버의 Linux 절대 경로나 같은 배포판의 WSL 경로를 입력하세요.");
  return value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}
function array(value, label, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be an array of at most ${max} entries`);
  return value;
}
function records(value, label, max) {
  const ids = new Map();
  for (const record of array(value, label, max)) {
    object(record, label);
    text(record.id, `${label}.id`, true);
    if (ids.has(record.id)) fail(`Duplicate ${label} ID: ${record.id}`);
    ids.set(record.id, record);
  }
  return ids;
}
function references(value, items, label) {
  const seen = new Set();
  for (const id of array(value, label, 1000)) {
    text(id, label, true);
    if (!items.has(id)) fail(`Unknown ${label} reference: ${id}`);
    if (seen.has(id)) fail(`Duplicate ${label} reference: ${id}`);
    seen.add(id);
  }
}
function sourcePath(value) {
  text(value, "source.path", true);
  const parts = value.split("/");
  if (path.isAbsolute(value) || /[\\\x00-\x1f:]/u.test(value) || parts.some(part => !part || part === "." || part === "..")) fail(`Unsafe source path: ${value}`);
  if (!/\.(md|markdown|txt)$/iu.test(value)) fail(`Source must be Markdown or text: ${value}`);
  if (parts.some((part, index) => (part.startsWith(".") && !(index === 0 && part === ".strataa" && parts[1] === "sources" && parts.length > 2)) || /(?:^|[._-])(?:secrets?|credentials?|passwords?|tokens?|private[-_]?key|api[-_]?key|access[-_]?key)(?:[._-]|$)/iu.test(part) || /^(?:id_rsa|id_ed25519|ssh|node_modules)$/iu.test(part))) fail(`Secret or unsafe source path: ${value}`);
  return parts;
}

// Each path component is opened relative to an already-open directory, never through
// a mutable parent path. Descriptor paths are available on Linux and macOS; fail
// closed on platforms without them rather than following a concurrently swapped link.
async function childPath(handle, name) {
  for (const base of ["/proc/self/fd", "/dev/fd"]) {
    try { await lstat(`${base}/${handle.fd}`); return `${base}/${handle.fd}/${name}`; }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  }
  fail("Secure directory descriptor access is unavailable on this platform");
}
async function openRoot(root) {
  let handle = await open(path.parse(root).root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of root.slice(path.parse(root).root.length).split(path.sep).filter(Boolean)) {
      const next = await open(await childPath(handle, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
async function boundedRead(rootHandle, parts, limit) {
  const directories = [];
  let parent = rootHandle;
  let file;
  try {
    for (const part of parts.slice(0, -1)) {
      const handle = await open(await childPath(parent, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      directories.push(handle);
      parent = handle;
    }
    file = await open(await childPath(parent, parts.at(-1)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile()) fail(`Not a regular file: ${parts.join("/")}`);
    if (before.size > limit) fail(`File exceeds ${limit} byte limit: ${parts.join("/")}`);
    const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1));
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat();
    if (used > limit) fail(`File exceeds ${limit} byte limit: ${parts.join("/")}`);
    if (used !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail(`File changed while reading: ${parts.join("/")}`);
    let content;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)); }
    catch { fail(`Invalid UTF-8: ${parts.join("/")}`); }
    return { content, bytes: used, modified: after.mtimeMs };
  } finally {
    await file?.close();
    for (const handle of directories.reverse()) await handle.close();
  }
}
function parse(content, label) {
  try { return JSON.parse(content); } catch { fail(`Invalid JSON in ${label}`); }
}
async function snapshot(id, root) {
  const rootHandle = await openRoot(root);
  try {
    let manifest;
    try { manifest = await boundedRead(rootHandle, [".strataa", "project.json"], 2 * MiB); }
    catch (error) {
      if (error.code === "ENOENT") fail(`프로젝트 디렉터리는 있지만 .strataa/project.json이 없습니다: ${root}. 이 프로젝트에서 strataa-project 스킬로 기록을 만든 뒤 다시 연결하세요.`);
      throw error;
    }
    const data = parse(manifest.content, ".strataa/project.json");
    keys(data, ["schemaVersion", "project", "sources", "concepts", "buildUps"], "manifest");
    if (data.schemaVersion !== 1) fail("schemaVersion must be 1");
    keys(data.project, ["name", "summary", "nextStep"], "project");
    for (const key of ["name", "summary", "nextStep"]) text(data.project[key], `project.${key}`, key === "name");
    const sources = records(data.sources, "sources", 200);
    const concepts = records(data.concepts, "concepts", 1000);
    const buildUps = records(data.buildUps, "buildUps", 1000);
    const sourceTexts = new Map();
    let total = 0;
    let modified = manifest.modified;
    for (const source of sources.values()) {
      keys(source, ["id", "title", "path", "summary", "authors", "year", "url"], "source");
      for (const key of ["title", "summary", "authors", "year", "url"]) text(source[key], `source.${key}`, key === "title");
      if (source.url) {
        let url;
        try { url = new URL(source.url); } catch { fail(`Invalid source URL: ${source.id}`); }
        if (!["http:", "https:"].includes(url.protocol)) fail(`Source URL must use http(s): ${source.id}`);
      }
      const result = await boundedRead(rootHandle, sourcePath(source.path), Math.min(2 * MiB, 20 * MiB - total));
      total += result.bytes;
      modified = Math.max(modified, result.modified);
      sourceTexts.set(source.id, normalize(result.content));
    }
    for (const concept of concepts.values()) {
      keys(concept, ["id", "name", "level", "parentId", "description", "sourceIds"], "concept");
      for (const key of ["name", "description"]) text(concept[key], `concept.${key}`, key === "name");
      const level = LEVELS.indexOf(concept.level);
      if (level < 0 || (level === 0 ? concept.parentId !== null : concepts.get(concept.parentId)?.level !== LEVELS[level - 1])) fail(`Invalid concept hierarchy: ${concept.id}`);
      references(concept.sourceIds, sources, "concept.sourceIds");
    }
    const diagnostics = [];
    for (const record of buildUps.values()) {
      keys(record, ["id", "title", "kind", "status", "parentId", "body", "alternatives", "rationale", "evidence", "nextStep", "sourceIds", "conceptIds", "skillNames"], "buildUp");
      for (const key of ["title", "body", "alternatives", "rationale", "nextStep"]) text(record[key], `buildUp.${key}`, key === "title");
      if (!KINDS.includes(record.kind) || !STATUSES.includes(record.status)) fail(`Invalid BuildUp kind/status: ${record.id}`);
      if (record.parentId !== null && !buildUps.has(record.parentId)) fail(`Unknown BuildUp parent: ${record.id}`);
      const visited = new Set([record.id]);
      let parent = record.parentId;
      while (parent !== null) {
        if (visited.has(parent)) fail(`BuildUp cycle: ${record.id}`);
        visited.add(parent);
        const ancestor = buildUps.get(parent);
        if (!ancestor) fail(`Unknown BuildUp parent: ${parent}`);
        parent = ancestor.parentId;
      }
      references(record.sourceIds, sources, "buildUp.sourceIds");
      references(record.conceptIds, concepts, "buildUp.conceptIds");
      for (const skill of array(record.skillNames, "buildUp.skillNames", 1000)) text(skill, "skillName", true);
      for (const evidence of array(record.evidence, "buildUp.evidence", 1000)) {
        keys(evidence, ["sourceId", "quote"], "evidence");
        text(evidence.sourceId, "evidence.sourceId", true);
        text(evidence.quote, "evidence.quote", true);
        if (!record.sourceIds.includes(evidence.sourceId)) fail(`Evidence source must be linked to BuildUp: ${record.id}`);
        if (!sourceTexts.get(evidence.sourceId)?.includes(normalize(evidence.quote))) fail(`Evidence quote not found in source: ${record.id}`);
      }
      if (!record.evidence.length) diagnostics.push({ kind: "gap", message: "No source evidence recorded; this record is not verified.", recordId: record.id });
      if (record.status === "accepted") diagnostics.push({ kind: "warning", message: "Accepted records a choice, not proof.", recordId: record.id });
    }
    const currentManifest = await boundedRead(rootHandle, [".strataa", "project.json"], 2 * MiB);
    if (currentManifest.content !== manifest.content) fail("Manifest changed while reading project");
    return { id, root, name: data.project.name, status: "ready", error: null, updatedAt: new Date(modified).toISOString(), project: data.project, sources: data.sources, concepts: data.concepts, buildUps: data.buildUps, diagnostics, counts: { sources: sources.size, concepts: concepts.size, buildUps: buildUps.size, gaps: diagnostics.filter(item => item.kind === "gap").length } };
  } finally { await rootHandle.close(); }
}
function empty(id, root) {
  return { id, root, name: path.basename(root), updatedAt: null, project: { name: path.basename(root), summary: "", nextStep: "" }, sources: [], concepts: [], buildUps: [], diagnostics: [], counts: { sources: 0, concepts: 0, buildUps: 0, gaps: 0 } };
}
const projectId = root => createHash("sha256").update(root).digest("hex");

// Read-only entrypoint: share the snapshot validator without connection storage or cache.
export async function inspectProject(input = process.cwd()) {
  const root = path.resolve(projectPath(input));
  return snapshot(projectId(root), root);
}

export function createProjectRegistry(directory) {
  const storage = path.resolve(directory);
  const filename = "project-connections.json";
  const links = new Map();
  const cache = new Map();
  let queue = Promise.resolve();
  let initialized = false;
  async function initialize() {
    if (initialized) return;
    await mkdir(storage, { recursive: true, mode: 0o700 });
    const handle = await open(storage, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      let stored;
      try { stored = await boundedRead(handle, [filename], 2 * MiB); }
      catch (error) { if (error.code === "ENOENT") { initialized = true; return; } throw error; }
      const data = parse(stored.content, filename);
      object(data, "connections");
      if (data.schemaVersion !== 1) fail("Invalid project connections schemaVersion");
      const roots = array(data.roots, "connections.roots", 1000);
      const loaded = new Map();
      for (const root of roots) {
        text(root, "connection root", true);
        if (!path.isAbsolute(root) || path.resolve(root) !== root) fail("Invalid stored project root");
        const id = projectId(root);
        if (loaded.has(id)) fail("Duplicate stored project root");
        loaded.set(id, root);
      }
      for (const [id, root] of loaded) links.set(id, root);
      initialized = true;
    } finally { await handle.close(); }
  }
  async function persist(next) {
    const content = JSON.stringify({ schemaVersion: 1, roots: [...next.values()] });
    if (next.size > 1000 || Buffer.byteLength(content) > 2 * MiB) fail("Project connection registry is full");
    const temporary = path.join(storage, `.${filename}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path.join(storage, filename));
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }
  function serial(operation) {
    const result = queue.then(async () => { await initialize(); return operation(); });
    queue = result.catch(() => {});
    return result;
  }
  async function refresh(id) {
    if (!links.has(id)) throw new ProjectError("Project connection not found", 404);
    const root = links.get(id);
    try {
      const value = await snapshot(id, root);
      cache.set(id, value);
      return clone(value);
    } catch (error) {
      const previous = cache.get(id);
      const value = clone(previous || empty(id, root));
      value.status = "error";
      value.error = `${previous ? "Stale snapshot; last valid data retained. " : "Project unavailable; no valid snapshot. "}${error.message}`;
      value.diagnostics.push({ kind: "warning", message: value.error });
      return value;
    }
  }
  return {
    list() { return serial(async () => { const values = []; for (const id of links.keys()) values.push(await refresh(id)); return values; }); },
    connect(input) { return serial(async () => {
      const expanded = projectPath(input);
      let root;
      try { root = await realpath(path.resolve(expanded)); }
      catch (error) { throw new ProjectError(`Cannot connect project: ${error.message}`); }
      const id = projectId(root);
      let value;
      try { value = await snapshot(id, root); }
      catch (error) { throw new ProjectError(`Cannot connect project: ${error.message}`); }
      if (!links.has(id)) {
        const next = new Map(links).set(id, root);
        await persist(next);
        links.set(id, root);
      }
      cache.set(id, value);
      return clone(value);
    }); },
    get(id) { return serial(() => refresh(id)); },
    disconnect(id) { return serial(async () => {
      if (!links.has(id)) throw new ProjectError("Project connection not found", 404);
      const next = new Map(links);
      next.delete(id);
      await persist(next);
      links.delete(id);
      cache.delete(id);
    }); },
    close() { return queue; },
  };
}
