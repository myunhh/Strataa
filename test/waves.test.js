import test from "node:test";
import assert from "node:assert/strict";
import { parseWaves, prepareWaveCall, waveComplete } from "../waves.js";
import { createFlow, expectNative, finishFlow, observeNative, planFlow } from "../flow.js";
import { parseRoute, DEFAULTS } from "../protocol.js";

const stages = () => [
  { id: "Inspect", title: "Inspect", goal: "Inspect the requested inputs", parallel: 2, dependsOn: [] },
  { id: "Check", title: "Check", goal: "Check the collected evidence", parallel: 1, dependsOn: ["Inspect"] },
  { id: "Report", title: "Report", goal: "Produce the requested artifact", parallel: 1, dependsOn: ["Check"] },
];
function run(waves = stages()) {
  const flow = createFlow("waves");
  planFlow(flow, { route: "solo", reason: "Scoped work", waves: parseWaves(waves) }, DEFAULTS);
  return flow;
}
function admit(flow, names) {
  const prepared = prepareWaveCall(flow, { tasks: names.map(name => ({ name, task: "Read the assigned input only." })) });
  flow.nextWaveTask = prepared.nextName;
  prepared.input.tasks.forEach((task, index) => expectNative(flow, "task", task.name, { ...task, waveId: prepared.bindings[index].waveId, parentId: "final" }));
  return prepared.input.tasks;
}
function complete(flow, id, more = {}) {
  observeNative(flow, { details: { results: [{ id, status: "completed", output: `Evidence from ${id}`, ...more }] } });
}

test("Terra requires a bounded, unambiguous execution-stage plan", () => {
  const catalog = [{ name: "research-review" }];
  assert.throws(() => parseRoute('{"route":"solo","reason":"work"}', catalog), /waves/);
  for (const waves of [null, {}, [null], [{ ...stages()[0], id: ["Inspect"] }],
    [stages()[0], stages()[0]], [{ ...stages()[0], parallel: 0 }], [{ ...stages()[0], parallel: 5 }],
    [{ ...stages()[0], goal: " " }], Array.from({ length: 13 }, (_, i) => ({ ...stages()[0], id: `Stage${i}` }))]) {
    assert.throws(() => parseWaves(waves), JSON.stringify(waves));
  }
  assert.equal(parseRoute(JSON.stringify({ route: "solo", reason: "work", waves: stages() }), catalog).waves.length, 3);
});

test("a stage barrier requires every full successful result, not lifecycle completion", () => {
  const flow = run();
  admit(flow, ["Inspect__First", "Inspect__Second"]);
  assert.throws(() => admit(flow, ["Check__Early"]), /finish successfully/);
  assert.throws(() => admit(flow, ["Inspect__Third"]), /concurrent/);
  complete(flow, "Inspect__First");
  observeNative(flow, { details: { progress: [{ id: "Inspect__Second", status: "completed" }] } });
  assert.equal(waveComplete(flow, 0), false);
  assert.throws(() => admit(flow, ["Check__StillEarly"]), /full public results/);
  complete(flow, "Inspect__Second");
  admit(flow, ["Check__Now"]);
  const check = flow.rows.find(row => row.jobIds.includes("Check__Now"));
  assert.equal(check.wave, 3);
  assert.equal(check.parentId, "final", "a later execution Wave does not invent a nested parent");
  assert.throws(() => admit(flow, ["Inspect__Late"]), /closed/);
});

test("mixed/skipped/unknown stages and duplicate names cannot partially advance a plan", () => {
  const flow = run();
  for (const names of [["Inspect__A", "Check__B"], ["Report__Skip"], ["Unknown__A"], ["Inspect__A", "Inspect__A"]]) {
    assert.throws(() => admit(flow, names));
    assert.deepEqual(flow.rows.flatMap(row => row.jobIds), []);
  }
  admit(flow, ["Inspect__A"]);
  complete(flow, "Inspect__A");
  assert.throws(() => admit(flow, ["Inspect__A"]), /already used/);
});

test("failure, cancellation and missing public output do not unlock later stages", () => {
  for (const more of [{ status: "failed", error: "failed" }, { status: "cancelled" }, { output: "" }]) {
    const flow = run();
    admit(flow, ["Inspect__A"]);
    complete(flow, "Inspect__A", more);
    assert.equal(waveComplete(flow, 0), false);
    assert.throws(() => admit(flow, ["Check__A"]), /finish successfully/);
  }
});

test("repeated rounds stay in their stage and all planned stages must run before completion", () => {
  const flow = run();
  admit(flow, ["Inspect__Round1"]);
  complete(flow, "Inspect__Round1");
  admit(flow, ["Inspect__Round2"]);
  complete(flow, "Inspect__Round2");
  admit(flow, ["Check__Round1"]);
  complete(flow, "Check__Round1");
  const premature = structuredClone(flow);
  finishFlow(premature, "completed");
  assert.equal(premature.status, "incomplete");
  admit(flow, ["Report__Artifact"]);
  complete(flow, "Report__Artifact");
  finishFlow(flow, "completed");
  assert.equal(flow.status, "completed");
});

test("main-only plans cannot start delegates, and generated names reserve real stage capacity", () => {
  const direct = run([]);
  assert.throws(() => admit(direct, ["Extra"]), /without delegated Waves/);
  finishFlow(direct, "completed");
  assert.equal(direct.status, "completed");
  const flow = run();
  const first = admit(flow, [undefined])[0].name;
  const second = admit(flow, [undefined])[0].name;
  assert.notEqual(first, second);
  assert.throws(() => admit(flow, [undefined]), /concurrent/);
});

test("dependency validation groups independent stages and rejects unschedulable plans", () => {
  const plan = [
    { ...stages()[1], dependsOn: ["Inspect", "Data"] },
    stages()[0],
    { ...stages()[0], id: "Data" },
  ];
  assert.deepEqual(parseWaves(plan).map(stage => [stage.id, stage.wave]), [["Check", 3], ["Inspect", 2], ["Data", 2]]);
  for (const dependsOn of [undefined, null, ["Missing"], ["Inspect"], ["Data", "Data"]]) {
    assert.throws(() => parseWaves([{ ...stages()[0], dependsOn }, { ...stages()[0], id: "Data" }]));
  }
  assert.throws(() => parseWaves([
    { ...stages()[0], dependsOn: ["Data"] },
    { ...stages()[0], id: "Data", dependsOn: ["Inspect"] },
  ]), /Cyclic/);
});

test("independent stages share a native batch and only declared prerequisites block consumers", () => {
  const flow = run([stages()[0], { ...stages()[0], id: "Data" }, stages()[1]]);
  const tasks = admit(flow, ["Inspect__Code", "Data__Evidence"]);
  assert.deepEqual(tasks.map(task => task.name), ["Inspect__Code", "Data__Evidence"]);
  assert.deepEqual(flow.rows.filter(row => row.jobIds.length).map(row => [row.waveId, row.wave]), [["Inspect", 2], ["Data", 2]]);
  complete(flow, "Inspect__Code");
  admit(flow, ["Check__Code"]);
  assert.equal(flow.rows.find(row => row.waveId === "Check").wave, 3);
  assert.equal(flow.rows.find(row => row.waveId === "Data").state, "pending", "unrelated active branch is not an implicit barrier");
  assert.throws(() => admit(flow, ["Inspect__New"]), /closed/);
});

test("a join waits for both branches and cannot reopen a producer in the consumer batch", () => {
  const flow = run([stages()[0], { ...stages()[0], id: "Data" }, { ...stages()[1], dependsOn: ["Inspect", "Data"] }]);
  admit(flow, ["Inspect__Code", "Data__Evidence"]);
  complete(flow, "Inspect__Code");
  assert.throws(() => admit(flow, ["Check__Early"]), /Dependency Data/);
  complete(flow, "Data__Evidence");
  const before = structuredClone(flow);
  assert.throws(() => admit(flow, ["Inspect__Again", "Check__Unsafe"]), /Dependent stages/);
  assert.deepEqual(flow, before, "rejected mixed batch reserves no work");
  admit(flow, ["Check__Join"]);
});

test("global concurrency is reserved across stages and ambiguous names never guess a stage", () => {
  const flow = run([
    { ...stages()[0], parallel: 4 },
    { ...stages()[0], id: "Data", parallel: 4 },
  ]);
  assert.throws(() => admit(flow, [undefined]), /unambiguous/);
  admit(flow, ["Inspect__A", "Inspect__B", "Data__A", "Data__B"]);
  assert.throws(() => admit(flow, ["Data__Overflow"]), /across all Waves/);
  complete(flow, "Inspect__A");
  admit(flow, ["Data__Next"]);
  assert.equal(flow.rows.filter(row => row.jobIds.length && row.state !== "completed").length, 4);
});

test("received empty results block dependents without occupying live concurrency slots", () => {
  const flow = run([
    { ...stages()[0], parallel: 1 },
    { ...stages()[0], id: "Data", parallel: 4 },
    stages()[1],
  ]);
  admit(flow, ["Inspect__Empty"]);
  complete(flow, "Inspect__Empty", { output: "" });
  assert.equal(waveComplete(flow, 0), false);
  assert.throws(() => admit(flow, ["Check__Unsupported"]), /full public results/);
  admit(flow, ["Data__A", "Data__B", "Data__C", "Data__D"]);
  assert.equal(flow.rows.filter(row => row.waveId === "Data").length, 4);
});
