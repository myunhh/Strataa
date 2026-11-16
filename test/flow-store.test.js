import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createFlow, finishFlow, planFlow, startExecution } from "../flow.js";
import { DEFAULTS } from "../protocol.js";
import { createFlowPublisher, flowDirectory, readFlowSessions } from "../flow-store.js";

function temporary(t) {
  const root = mkdtempSync(path.join(tmpdir(), "strataa-flows-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return path.join(root, "flows");
}
const info = (sessionId, flow) => ({ sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, cwd: `/work/${sessionId}`, flow });

test("publisher is lazy and directory overrides resolve without creating files", t => {
  const directory = temporary(t);
  const publisher = createFlowPublisher({ directory });
  assert.equal(existsSync(directory), false);
  assert.deepEqual(readFlowSessions({ directory }), []);
  publisher.close();
  assert.equal(existsSync(directory), false);
  const prior = process.env.OMP_STRATAA_FLOW_DIR;
  try {
    process.env.OMP_STRATAA_FLOW_DIR = directory;
    assert.equal(flowDirectory(), directory);
  } finally {
    if (prior === undefined) delete process.env.OMP_STRATAA_FLOW_DIR;
    else process.env.OMP_STRATAA_FLOW_DIR = prior;
  }
});

test("two publishers retain completed snapshots and replace only their own source", t => {
  const directory = temporary(t);
  const first = createFlowPublisher({ directory });
  const second = createFlowPublisher({ directory });
  t.after(() => { first.close(); second.close(); });
  const flow = createFlow("first-run", "First request");
  first.publish(info("first", flow));
  second.publish(info("second", createFlow("second-run", "Second request")));
  let sessions = readFlowSessions({ directory });
  assert.equal(sessions.length, 2);
  const keys = sessions.map(session => session.key);
  const firstKey = sessions.find(session => session.sessionId === "first").key;
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  for (const file of readdirSync(directory)) {
    assert.match(file, /\.json$/);
    assert.equal(statSync(path.join(directory, file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(path.join(directory, file), "utf8")).version, 1);
  }
  planFlow(flow, { route: "solo", reason: "Direct request", waves: [] }, DEFAULTS);
  startExecution(flow);
  finishFlow(flow, "completed");
  first.publish(info("first", flow));
  // A very old timestamp is still a live producer, not an expired heartbeat.
  const file = path.join(directory, `${firstKey}.json`);
  const completed = JSON.parse(readFileSync(file, "utf8"));
  completed.updatedAt = 1;
  writeFileSync(file, JSON.stringify(completed));
  sessions = readFlowSessions({ directory });
  assert.deepEqual(sessions.map(session => session.key), keys);
  assert.equal(sessions.find(session => session.key === firstKey).flow.status, "completed");
  first.publish(info("first", createFlow("replacement", "Next request")));
  sessions = readFlowSessions({ directory });
  assert.deepEqual(sessions.map(session => session.key), keys);
  assert.equal(sessions.find(session => session.key === firstKey).flow.id, "replacement");
  assert.equal(sessions.find(session => session.key !== firstKey).flow.id, "second-run");
  first.close();
  first.publish(info("first", createFlow("late", "Must not return")));
  assert.deepEqual(readFlowSessions({ directory }).map(session => session.sessionId), ["second"]);
  second.close();
  assert.deepEqual(readFlowSessions({ directory }), []);
});

test("session navigation replaces one record with an empty or restored selected session", t => {
  const directory = temporary(t);
  const publisher = createFlowPublisher({ directory });
  t.after(() => publisher.close());
  publisher.publish(info("old", createFlow("old-run", "Old request")));
  const key = readFlowSessions({ directory })[0].key;
  publisher.publish(info("empty", null));
  assert.deepEqual(readFlowSessions({ directory }), []);
  publisher.publish(info("restored", createFlow("restored-run", "Restored request")));
  assert.equal(readFlowSessions({ directory })[0].key, key);
  assert.equal(readdirSync(directory).length, 1);
});

test("reader skips malformed records and exited producers without dropping live siblings", t => {
  const directory = temporary(t);
  const publisher = createFlowPublisher({ directory });
  t.after(() => publisher.close());
  publisher.publish(info("live", createFlow("live-run", "Visible")));
  const valid = readFlowSessions({ directory })[0];
  writeFileSync(path.join(directory, "partial.tmp"), "{unfinished");
  writeFileSync(path.join(directory, "broken.json"), "{unfinished");
  for (const [name, value] of Object.entries({ null: null, version: { ...valid, version: 99 },
    rows: { ...valid, flow: { ...valid.flow, rows: [null] } },
    jobs: { ...valid, flow: { ...valid.flow, rows: [{ ...valid.flow.rows[0], jobs: [null] }] } },
    waves: { ...valid, flow: { ...valid.flow, waves: [null] } } })) {
    writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(value));
  }
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  assert.equal(exited.status, 0);
  writeFileSync(path.join(directory, "exited.json"), JSON.stringify({ ...valid, key: "exited", pid: Number(exited.stdout) }));
  assert.deepEqual(readFlowSessions({ directory }).map(session => session.key), [valid.key]);
});

test("real filesystem failures propagate instead of masquerading as an empty monitor", t => {
  const directory = temporary(t);
  writeFileSync(path.dirname(directory) + "/not-a-directory", "occupied");
  const occupied = path.dirname(directory) + "/not-a-directory";
  assert.throws(() => readFlowSessions({ directory: occupied }), { code: "ENOTDIR" });
  const publisher = createFlowPublisher({ directory: occupied });
  assert.throws(() => publisher.publish(info("source", createFlow("run", "Question"))));
});

const saved = (sessionId, flow) => ({
  version: 1, key: `session-${process.pid}-${sessionId}`, pid: process.pid,
  ...info(sessionId, flow), updatedAt: 1, source: "session",
  title: "Existing session", request: flow?.request ?? "Original request", requestId: "request-id",
});

test("existing sessions appear before any native publisher creates the registry", t => {
  const directory = temporary(t);
  const observed = saved("observed", createFlow("old-run", "Existing flow request"));
  const unobserved = saved("unobserved", null);
  assert.deepEqual(readFlowSessions({ directory, liveSessions: [observed, unobserved] }), [observed, unobserved]);
  assert.equal(existsSync(directory), false);
});

test("native snapshots win without reviving previous branches or hiding unobserved input", t => {
  const directory = temporary(t);
  const publisher = createFlowPublisher({ directory });
  t.after(() => publisher.close());
  const fallback = saved("same", createFlow("stored-run", "Stored request"));
  publisher.publish(info("same", createFlow("live-run", "Live request")));
  let sessions = readFlowSessions({ directory, liveSessions: [fallback] });
  assert.deepEqual(sessions.map(record => record.flow.id), ["live-run"]);

  publisher.publish(info("same", null));
  assert.deepEqual(readFlowSessions({ directory, liveSessions: [fallback] }), []);
  sessions = readFlowSessions({ directory, liveSessions: [saved("same", null)] });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].flow, null);
  assert.equal(sessions[0].request, "Original request");

  publisher.publish(info("navigated", null));
  assert.deepEqual(readFlowSessions({ directory, liveSessions: [saved("same", null)] }), []);
});
