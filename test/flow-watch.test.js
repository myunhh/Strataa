import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowPublisher, readFlowSessions } from "../flow-store.js";

// pi-tui is host-rebound, like pi-ai in transport.test.js. Keep the real
// watcher, inspector and filesystem transport; replace only terminal cosmetics.
const tui = `
export const theme = { fg: (_, text) => text, bold: text => text };
export const matchesKey = (input, key) => input === key;
export const truncateToWidth = (text, width) => Array.from(text).slice(0, width).join("");
export const wrapTextWithAnsi = (text, width) => {
  const chars = Array.from(text), lines = [];
  for (let i = 0; i < chars.length; i += width) lines.push(chars.slice(i, i + width).join(""));
  return lines;
};
`;
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === "@oh-my-pi/pi-tui") return { url: "stub:pi-tui", shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url === "stub:pi-tui") return { format: "module", source: ${JSON.stringify(tui)}, shortCircuit: true };
  return next(url, context);
}
`)}`, import.meta.url);
const { createFlowWatch } = await import("../flow-watch.js");

function flow(id, more = {}) {
  return {
    version: 1, id, request: `original-${id}`, status: "running", startedAt: 1, updatedAt: 2,
    rows: [{ id: "router", label: `node-${id}`, state: "running", jobIds: [], jobs: [], output: `OUTPUT-${id}` }],
    ...more,
  };
}
function fixture(t, count = 1) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const directory = mkdtempSync(path.join(tmpdir(), "strataa-watch-"));
  const publishers = [], watches = [];
  for (let i = 0; i < count; i++) {
    const publisher = createFlowPublisher({ directory });
    publisher.publish({ sessionId: `session-${i}`, cwd: `/workspace-${i}`, flow: flow(`run-${i}`) });
    publishers.push(publisher);
  }
  t.after(() => {
    watches.forEach(watch => watch.dispose());
    publishers.forEach(publisher => publisher.close());
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, publishers,
    watch(options = {}) {
      const watch = createFlowWatch(undefined, { directory, getHeight: () => 24, ...options });
      watches.push(watch);
      return watch;
    },
    tick: () => t.mock.timers.tick(500),
    records: () => readFlowSessions({ directory }),
  };
}
const screen = (watch, width = 160) => watch.render(width).join("\n");

test("dashboard shows concurrent actual nodes, summary success and honest raw fallbacks", t => {
  const f = fixture(t, 3);
  f.publishers[0].publish({ sessionId: "session-0", cwd: "/workspace-0", flow: flow("run-0", {
    promptSummary: { status: "completed", model: "small-model", text: "summarized task" },
  }) });
  f.publishers[1].publish({ sessionId: "session-1", cwd: "/workspace-1", flow: flow("run-1", {
    promptSummary: { status: "running" },
  }) });
  f.publishers[2].publish({ sessionId: "session-2", cwd: "/workspace-2", flow: flow("run-2", {
    status: "incomplete",
    promptSummary: { status: "failed", error: "no credentials" },
  }) });
  const watch = f.watch();
  const text = screen(watch);
  for (let i = 0; i < 3; i++) {
    assert.ok(text.includes(`session-${i}`));
    assert.ok(text.includes(`node-run-${i}`));
  }
  assert.ok(text.includes("요청 요약: summarized task"));
  assert.ok(text.includes("원문 (요약 중): original-run-1"));
  assert.ok(text.includes("원문 (요약 실패): original-run-2 · no credentials"));
  assert.ok(text.includes("! 미완료"));
});

test("small dashboards page every session and retain selection through updates and resize", t => {
  const f = fixture(t, 5);
  let height = 4;
  const watch = f.watch({ getHeight: () => height });
  const ordered = f.records();
  for (let i = 0; i < ordered.length; i++) {
    const text = screen(watch, 64);
    assert.ok(text.includes(`› ${i + 1}/${ordered.length}`));
    assert.ok(text.includes(ordered[i].sessionId));
    assert.ok(text.includes(`${i + 1}-${i + 1}/${ordered.length}`));
    watch.handleInput("tab");
  }
  watch.handleInput("pageDown");
  const selected = ordered[1];
  const producerIndex = Number(selected.sessionId.split("-")[1]);
  f.publishers[producerIndex].publish({ sessionId: selected.sessionId, cwd: selected.cwd, flow: flow("replacement") });
  f.tick();
  assert.ok(screen(watch, 64).includes(`› 2/${ordered.length}`));
  height = 24;
  assert.ok(screen(watch).includes(`› 2/${ordered.length}`));
  height = 1;
  assert.ok(screen(watch, 64).startsWith(`2/${ordered.length} ›${selected.sessionId}`));
  watch.handleInput("end");
  assert.ok(screen(watch, 64).startsWith(`5/${ordered.length}`));
  watch.handleInput("shift+tab");
  assert.ok(screen(watch, 64).startsWith(`4/${ordered.length}`));
});

test("completed snapshots persist but a new run resets an open old-output inspector", t => {
  const f = fixture(t);
  const watch = f.watch();
  watch.handleInput("enter");
  watch.handleInput("enter");
  screen(watch); // Layout establishes the detail page size before End, as in the TUI.
  watch.handleInput("end");
  assert.ok(screen(watch).includes("OUTPUT-run-0"));
  f.publishers[0].publish({ sessionId: "session-0", cwd: "/workspace-0", flow: flow("run-0", {
    status: "completed", rows: [{ id: "router", label: "completed-node", state: "completed", jobIds: [], jobs: [], output: "OUTPUT-run-0" }],
  }) });
  f.tick();
  assert.ok(screen(watch).includes("OUTPUT-run-0"));
  f.publishers[0].publish({ sessionId: "session-0", cwd: "/workspace-0", flow: flow("new-run", {
    promptSummary: { status: "completed", text: "new task", model: "small-model" },
  }) });
  f.tick();
  assert.ok(!screen(watch).includes("OUTPUT-run-0"));
  assert.ok(screen(watch).includes("node-new-run"));
  assert.ok(screen(watch).includes("small-model"));
  watch.handleInput("enter");
  screen(watch);
  watch.handleInput("end");
  assert.ok(screen(watch).includes("OUTPUT-new-run"));
  assert.ok(screen(watch).includes("original-new-run"));
  watch.handleInput("escape");
  assert.ok(screen(watch).includes("Strataa Flow Watch"));
  watch.handleInput("enter");
  watch.handleInput("enter");
  f.publishers[0].close();
  f.tick();
  assert.ok(screen(watch).includes("게시된 Flow 없음"));
  assert.ok(!screen(watch).includes("OUTPUT-new-run"));
});

test("closing one watcher stops only its timer and cannot mutate producer snapshots", t => {
  const f = fixture(t, 2);
  const bytes = () => readdirSync(f.directory).sort().map(name => [name, readFileSync(path.join(f.directory, name), "utf8")]);
  const before = bytes();
  let firstRenders = 0, secondRenders = 0, closes = 0;
  const first = f.watch({ requestRender: () => firstRenders++, onClose: () => closes++ });
  const second = f.watch({ requestRender: () => secondRenders++ });
  first.handleInput("ctrl+c");
  first.handleInput("q");
  const stoppedAt = firstRenders, secondAt = secondRenders;
  f.tick();
  assert.equal(closes, 1);
  assert.equal(firstRenders, stoppedAt);
  assert.ok(secondRenders > secondAt);
  assert.deepEqual(first.render(80), []);
  assert.deepEqual(bytes(), before);
  assert.equal(f.records().length, 2);
  second.handleInput("q");
  assert.deepEqual(bytes(), before);
});

test("reader failures are visible and stored terminal controls never enter rendered text", t => {
  const f = fixture(t);
  f.publishers[0].publish({ sessionId: "safe\x1b[31m-session", cwd: "/safe\x1b]0;title\x07", flow: flow("safe", {
    request: "hello\x1b[2J\x07\nworld", promptSummary: { status: "completed", text: "clean\x1b[31m-summary" },
  }) });
  const watch = f.watch();
  const text = screen(watch);
  assert.ok(!/[\x00-\x08\x0B-\x1F\x7F-\x9F]/.test(text));
  assert.ok(text.includes("clean-summary"));
  const notDirectory = path.join(f.directory, "not-a-directory");
  writeFileSync(notDirectory, "file");
  const failed = f.watch({ directory: notDirectory });
  assert.ok(screen(failed).includes("읽기 오류"));
});

test("already-running sessions show saved flows or original input without inventing a graph", async t => {
  const f = fixture(t, 0);
  const record = (id, snapshot) => ({
    version: 1, key: id, pid: process.pid, sessionId: id,
    sessionFile: `/sessions/${id}.jsonl`, cwd: "/existing-work", updatedAt: 1,
    source: "session", title: `title-${id}`, request: `original-input-${id}`,
    requestId: `input-${id}`, flow: snapshot,
  });
  let sources = [record("a-observed", flow("saved")), record("b-unobserved", null)];
  sources[1].request += "\n" + "long original context\n".repeat(40) + "ORIGINAL-END";
  const watch = f.watch({ readLiveSessions: async () => sources });
  await new Promise(setImmediate);
  const board = screen(watch);
  assert.ok(board.includes("node-saved"));
  assert.ok(board.includes("title-b-unobserved"));
  assert.ok(board.includes("저장 기록"));
  assert.ok(board.includes("Strataa Flow 미관측"));
  assert.ok(board.includes("original-input-b-unobserved"));

  watch.handleInput("tab");
  watch.handleInput("enter");
  const detail = screen(watch);
  assert.ok(detail.includes("Flow 미관측"));
  assert.ok(detail.includes("[원본 사용자 요청]"));
  assert.ok(detail.includes("original-input-b-unobserved"));
  assert.ok(!detail.includes("node-saved"));
  assert.ok(!detail.includes("가상"));
  watch.handleInput("end");
  assert.ok(screen(watch).includes("ORIGINAL-END"));

  sources = [sources[0]];
  f.tick();
  await new Promise(setImmediate);
  const removed = screen(watch);
  assert.ok(removed.includes("node-saved"));
  assert.ok(!removed.includes("b-unobserved"));
});
