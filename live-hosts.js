import { promises as fs } from "node:fs";
import path from "node:path";

const unavailable = error => ["ENOENT", "ESRCH", "ENOTDIR", "EACCES", "EPERM"].includes(error.code);
const sameFile = (first, second) => first.dev === second.dev && first.ino === second.ino;
const omp = comm => comm === "omp\n" || comm === "omp";

async function sessionTarget(descriptor, uid) {
  try {
    const before = await fs.lstat(descriptor);
    if (!before.isSymbolicLink() || before.uid !== uid) return null;
    const target = await fs.readlink(descriptor);
    if (!path.posix.isAbsolute(target) || !target.endsWith(".jsonl") || target.endsWith(" (deleted)")) return null;

    // Metadata only: the named file must still be the file held by this fd.
    const named = await fs.stat(target);
    const held = await fs.stat(descriptor);
    if (!named.isFile() || !sameFile(named, held)) return null;
    const after = await fs.lstat(descriptor);
    if (!after.isSymbolicLink() || after.uid !== uid || !sameFile(before, after)) return null;
    if (await fs.readlink(descriptor) !== target) return null;
    return target;
  } catch (error) {
    if (unavailable(error)) return null;
    throw error;
  }
}

async function processSessions(directory, uid) {
  try {
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.uid !== uid || !omp(await fs.readFile(path.join(directory, "comm"), "utf8"))) return [];
    const fdDirectory = path.join(directory, "fd");
    const owner = await fs.lstat(fdDirectory);
    if (!owner.isDirectory() || owner.uid !== uid) return [];
    const descriptors = await fs.readdir(fdDirectory);
    const sessions = new Set();
    for (const descriptor of descriptors) {
      if (!/^(0|[1-9]\d*)$/.test(descriptor)) continue;
      const target = await sessionTarget(path.join(fdDirectory, descriptor), uid);
      if (target) sessions.add(target);
    }
    const after = await fs.lstat(directory);
    if (!after.isDirectory() || after.uid !== uid || !sameFile(before, after) ||
      !omp(await fs.readFile(path.join(directory, "comm"), "utf8"))) return [];
    return sessions;
  } catch (error) {
    if (unavailable(error)) return [];
    throw error;
  }
}

/** Discover only currently open, same-user OMP session files; never read their contents. */
export async function discoverSessionFiles({ procDirectory = "/proc" } = {}) {
  if ((path.resolve(procDirectory) === "/proc" && process.platform !== "linux") || typeof process.getuid !== "function") return [];
  const uid = process.getuid();
  let processes;
  try { processes = await fs.readdir(procDirectory, { withFileTypes: true }); }
  catch (error) { if (unavailable(error)) return []; throw error; }

  const pids = processes.filter(entry => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
    .map(entry => Number(entry.name)).filter(Number.isSafeInteger).sort((a, b) => a - b);
  const owners = new Map();
  for (const pid of pids) {
    for (const sessionFile of await processSessions(path.join(procDirectory, String(pid)), uid)) {
      // Multiple descriptors (or processes) can hold the same file. Keep one stable owner.
      if (!owners.has(sessionFile)) owners.set(sessionFile, pid);
    }
  }

  const sessions = [];
  for (const [sessionFile, pid] of owners) {
    let directory = path.posix.dirname(sessionFile);
    let child = false;
    while (directory !== "/") {
      if (owners.has(`${directory}.jsonl`)) { child = true; break; }
      directory = path.posix.dirname(directory);
    }
    if (!child) sessions.push({ pid, sessionFile });
  }
  return sessions.sort((a, b) => a.pid - b.pid || a.sessionFile.localeCompare(b.sessionFile));
}
