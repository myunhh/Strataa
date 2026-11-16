import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverSessionFiles } from "../live-hosts.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "strataa-live-hosts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const procDirectory = path.join(directory, "proc");
  mkdirSync(procDirectory);
  return {
    directory, procDirectory,
    process(pid, comm = "omp\n") {
      const processDirectory = path.join(procDirectory, String(pid));
      mkdirSync(path.join(processDirectory, "fd"), { recursive: true });
      writeFileSync(path.join(processDirectory, "comm"), comm);
      return processDirectory;
    },
    session(name) {
      const file = path.join(directory, "sessions", name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "Session contents must not be read or parsed.\n");
      return file;
    },
    fd(pid, number, target) {
      const descriptor = path.join(procDirectory, String(pid), "fd", String(number));
      symlinkSync(target, descriptor);
      return descriptor;
    },
  };
}

const discover = fixture => discoverSessionFiles({ procDirectory: fixture.procDirectory });
const uidAvailable = typeof process.getuid === "function";

test("only exact OMP processes contribute open JSONL roots, not history or brokers", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  host.process(20);
  host.process(21, "omp daemon brok\n");
  host.process(22, "node\n");
  host.process(23, "omp \n");
  host.process("not-a-pid");
  const root = host.session("root.jsonl");
  const broker = host.session("broker.jsonl");
  const unrelated = host.session("unrelated.jsonl");
  const trailingSpace = host.session("trailing-space.jsonl");
  const nonPid = host.session("non-pid.jsonl");
  host.session("unopened-history.jsonl");
  const credentials = host.session("credentials.json");
  host.fd(20, 3, root);
  host.fd(20, 4, credentials);
  host.fd(20, "not-an-fd", host.session("invalid-descriptor.jsonl"));
  writeFileSync(path.join(host.procDirectory, "20", "fd", "5"), root);
  host.fd(21, 3, broker);
  host.fd(22, 3, unrelated);
  host.fd(23, 3, trailingSpace);
  host.fd("not-a-pid", 3, nonPid);
  symlinkSync(path.join(host.procDirectory, "20"), path.join(host.procDirectory, "24"));

  const readFile = fs.readFile;
  t.mock.method(fs, "readFile", async (file, ...args) => {
    assert.equal(path.basename(String(file)), "comm", "discovery must not read session or credential bodies");
    return readFile.call(fs, file, ...args);
  });
  assert.deepEqual(await discover(host), [{ pid: 20, sessionFile: root }]);
});

test("deduplicates paths and excludes nested children across owning processes", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  host.process(30);
  host.process(10);
  host.process(40);
  const root = host.session("root.jsonl");
  const child = host.session("root/Child.jsonl");
  const nestedChild = host.session("root/Child/Grandchild.jsonl");
  const sibling = host.session("root-other/Independent.jsonl");
  const standalone = host.session("standalone/Nested.jsonl");
  host.fd(30, 3, root);
  host.fd(10, 4, root);
  host.fd(10, 5, root);
  host.fd(10, 6, child);
  host.fd(40, 3, nestedChild);
  host.fd(30, 4, sibling);
  host.fd(40, 4, standalone);
  assert.deepEqual(await discover(host), [
    { pid: 10, sessionFile: root },
    { pid: 30, sessionFile: sibling },
    { pid: 40, sessionFile: standalone },
  ]);
});

test("isolates foreign process and fd owners without suppressing same-user roots", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  host.process(10);
  const foreignProcess = host.process(20);
  const foreignFdDirectory = path.join(host.process(30), "fd");
  const root = host.session("root.jsonl");
  host.fd(10, 3, root);
  const foreignDescriptor = host.fd(10, 4, host.session("foreign-fd.jsonl"));
  host.fd(20, 3, host.session("foreign-process.jsonl"));
  host.fd(30, 3, host.session("foreign-fd-directory.jsonl"));
  const foreignPaths = new Set([foreignProcess, foreignFdDirectory, foreignDescriptor]);
  const lstat = fs.lstat;
  // UID metadata is injected because unprivileged test users cannot chown fixture files.
  t.mock.method(fs, "lstat", async (file, ...args) => {
    const metadata = await lstat.call(fs, file, ...args);
    if (foreignPaths.has(String(file))) metadata.uid = process.getuid() + 1;
    return metadata;
  });
  assert.deepEqual(await discover(host), [{ pid: 10, sessionFile: root }]);
});

test("rejects deleted, relative, dangling and non-file descriptor targets", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  host.process(10);
  const root = host.session("root.jsonl");
  host.fd(10, 3, root);
  const removed = host.session("removed.jsonl");
  host.fd(10, 4, `${removed} (deleted)`);
  host.fd(10, 5, "relative.jsonl");
  host.fd(10, 6, path.join(host.directory, "missing.jsonl"));
  const directory = path.join(host.directory, "directory.jsonl");
  mkdirSync(directory);
  host.fd(10, 7, directory);
  unlinkSync(removed);
  assert.deepEqual(await discover(host), [{ pid: 10, sessionFile: root }]);
});

test("every call reflects new processes, navigation and closed descriptors", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  const processDirectory = host.process(10);
  const first = host.session("first.jsonl");
  const descriptor = host.fd(10, 3, first);
  assert.deepEqual(await discover(host), [{ pid: 10, sessionFile: first }]);
  const next = host.session("next.jsonl");
  const second = host.session("second.jsonl");
  unlinkSync(descriptor);
  host.fd(10, 3, next);
  host.process(20);
  host.fd(20, 3, second);
  assert.deepEqual(await discover(host), [{ pid: 10, sessionFile: next }, { pid: 20, sessionFile: second }]);
  rmSync(processDirectory, { recursive: true });
  assert.deepEqual(await discover(host), [{ pid: 20, sessionFile: second }]);
});

test("ignores processes and descriptors disappearing after directory enumeration", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  const exiting = host.process(10);
  const remaining = host.process(20);
  host.fd(10, 3, host.session("exiting.jsonl"));
  const closed = host.fd(20, 3, host.session("closed.jsonl"));
  const root = host.session("root.jsonl");
  host.fd(20, 4, root);
  const readdir = fs.readdir;
  t.mock.method(fs, "readdir", async (directory, ...args) => {
    const entries = await readdir.call(fs, directory, ...args);
    if (directory === host.procDirectory) rmSync(exiting, { recursive: true });
    if (directory === path.join(remaining, "fd")) unlinkSync(closed);
    return entries;
  });
  assert.deepEqual(await discover(host), [{ pid: 20, sessionFile: root }]);
});

test("rejects an fd that closes or changes targets after readlink", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  host.process(10);
  const closed = host.fd(10, 3, host.session("closed.jsonl"));
  const changed = host.fd(10, 4, host.session("previous.jsonl"));
  const replacement = host.session("replacement.jsonl");
  const root = host.session("root.jsonl");
  host.fd(10, 5, root);
  const readlink = fs.readlink;
  const changedOnce = new Set();
  t.mock.method(fs, "readlink", async (descriptor, ...args) => {
    const target = await readlink.call(fs, descriptor, ...args);
    if (!changedOnce.has(descriptor) && (descriptor === closed || descriptor === changed)) {
      changedOnce.add(descriptor);
      unlinkSync(descriptor);
      if (descriptor === changed) symlinkSync(replacement, descriptor);
    }
    return target;
  });
  assert.deepEqual(await discover(host), [{ pid: 10, sessionFile: root }]);
  assert.deepEqual(await discover(host), [{ pid: 10, sessionFile: replacement }, { pid: 10, sessionFile: root }]);
});

test("rejects descriptors and processes that cease to have matching ownership or comm", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  const changingProcess = host.process(10);
  host.process(20);
  host.fd(10, 3, host.session("changed-process.jsonl"));
  const changedFd = host.fd(20, 3, host.session("changed-owner.jsonl"));
  const root = host.session("root.jsonl");
  host.fd(20, 4, root);
  const readlink = fs.readlink;
  const lstat = fs.lstat;
  let fdChanged = false;
  t.mock.method(fs, "readlink", async (descriptor, ...args) => {
    const target = await readlink.call(fs, descriptor, ...args);
    if (String(descriptor).startsWith(`${changingProcess}${path.sep}`)) {
      writeFileSync(path.join(changingProcess, "comm"), "omp daemon brok\n");
    }
    if (descriptor === changedFd) fdChanged = true;
    return target;
  });
  t.mock.method(fs, "lstat", async (file, ...args) => {
    const metadata = await lstat.call(fs, file, ...args);
    if (file === changedFd && fdChanged) metadata.uid = process.getuid() + 1;
    return metadata;
  });
  assert.deepEqual(await discover(host), [{ pid: 20, sessionFile: root }]);
});

test("permission races are local to one process while unexpected failures propagate", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  const denied = host.process(10);
  host.process(20);
  host.fd(10, 3, host.session("denied.jsonl"));
  const root = host.session("root.jsonl");
  host.fd(20, 3, root);
  const readdir = fs.readdir;
  const mocked = t.mock.method(fs, "readdir", async (directory, ...args) => {
    if (directory === path.join(denied, "fd")) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return readdir.call(fs, directory, ...args);
  });
  assert.deepEqual(await discover(host), [{ pid: 20, sessionFile: root }]);
  mocked.mock.mockImplementation(async () => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); });
  await assert.rejects(discover(host), { code: "EIO" });
});

test("missing proc mounts are empty and unsupported real platforms do not touch proc", { skip: !uidAvailable }, async t => {
  const host = fixture(t);
  assert.deepEqual(await discoverSessionFiles({ procDirectory: path.join(host.directory, "missing-proc") }), []);
  host.process(10);
  const root = host.session("root.jsonl");
  host.fd(10, 3, root);
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    assert.deepEqual(await discoverSessionFiles(), []);
    assert.deepEqual(await discover(host), [{ pid: 10, sessionFile: root }]);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});
