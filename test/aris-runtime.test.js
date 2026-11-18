import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODELS, MODEL_ROLES, taskModelSelector, uniformModelConfig } from "../model-config.js";
import { REVIEWER_AGENT, WORKER_AGENT, arisHandoff, arisSpawnPolicy, createArisRun, hydrateReview, isLegacyAgent, prepareArisCall, recordReview, reviewOutput, reviewReference, reviewRequired } from "../aris-runtime.js";

const install = { root: "/opt/aris/", commit: "2927b40b" };
const reviewSkill = { name: "research-review", path: "/opt/aris/skills/research-review/SKILL.md",
  content: "---\nname: research-review\nallowed-tools: Bash(*), mcp__codex__codex, mcp__codex__codex-reply\n---\n\nBODY mentions mcp__codex__codex-reply" };
const searchSkill = { name: "arxiv", path: "/opt/aris/skills/arxiv/SKILL.md",
  content: "---\nname: arxiv\nallowed-tools: Bash(*)\n---\n\nBody text that merely says mcp__codex__codex in prose" };
const decision = { route: "dialogue", reason: "review", skills: ["research-review"] };
const config = DEFAULT_MODELS;
const run = () => createArisRun("run-1", decision, config, [reviewSkill], install);

test("review requirement comes from the skill frontmatter transports, not prose", () => {
  assert.equal(reviewRequired([reviewSkill]), true);
  assert.equal(reviewRequired([searchSkill]), false);
  assert.equal(reviewRequired([searchSkill, reviewSkill]), true);
  assert.equal(run().reviewRequired, true);
  assert.equal(run().install.root, "/opt/aris");
  assert.deepEqual(run().config, config);
  assert.throws(() => createArisRun("r", decision, DEFAULT_MODELS, [], install), /not loaded/);
  assert.throws(() => createArisRun("r", decision, DEFAULT_MODELS, [{ name: "x", path: "p" }], install), /not loaded/);
  assert.throws(() => createArisRun("r", decision, DEFAULT_MODELS, [reviewSkill], {}), /install root/);
});

test("task calls: legacy helpers refused, owned-agent overrides stripped, reviewer continuity never reaches the worker, others untouched", () => {
  const aris = run();
  const plain = { agent: "scout", task: "map the repo" };
  assert.equal(prepareArisCall(aris, plain), plain);
  const batch = { context: "c", tasks: [{ task: "no agent" }, { agent: "reviewer", task: "x" }] };
  assert.equal(prepareArisCall(aris, batch), batch);
  for (const name of ["rh-critic-method", "dialogue-review", "dialogue-agreement"]) {
    assert.equal(isLegacyAgent(name), true);
    assert.throws(() => prepareArisCall(aris, { agent: name, task: "x" }), /retired helper agent/);
    assert.throws(() => prepareArisCall(aris, { context: "c", tasks: [plain, { agent: name, task: "x" }] }), /retired helper agent/);
  }
  assert.throws(() => prepareArisCall(aris, { agent: REVIEWER_AGENT }), /review task text/);
  assert.throws(() => prepareArisCall(aris, { agent: WORKER_AGENT }), /work packet text/);
  assert.throws(() => prepareArisCall(aris, "nope"), /must be an object/);
  const first = prepareArisCall(aris, { name: "R1", agent: REVIEWER_AGENT, task: "Review /w/brief.md", model: "anthropic/claude-opus-4-6", tools: ["bash"], outputSchema: {}, schemaMode: "strict" }, [{ name: "R1", waveId: "Review" }]);
  assert.equal(first.model, taskModelSelector(config.reviewer));
  assert.match(first.task, /^Review \/w\/brief\.md\n/);
  assert.match(first.task, /별도 읽기 전용 문맥/);
  assert.equal(first.tools, undefined);
  assert.equal(first.outputSchema, undefined);
  assert.equal(first.schemaMode, undefined);
  const packet = prepareArisCall(aris, { name: "W1", agent: WORKER_AGENT, task: "Implement /w/tool.py", model: "x/y", tools: ["task"], outputSchema: {}, schemaMode: "strict", isolated: true });
  assert.deepEqual(Object.keys(packet).sort(), ["agent", "isolated", "model", "name", "task"]);
  assert.equal(packet.model, taskModelSelector(config.worker));

  assert.equal(recordReview(aris, { id: "R1", output: "  " }, config.reviewer.model, "Review"), false);
  assert.equal(recordReview(aris, { id: "R1", output: "Round one findings" }, config.reviewer.model, "Review"), true);
  assert.equal(recordReview(aris, { id: "R1", output: "duplicate" }, config.reviewer.model, "Review"), false);
  assert.equal(recordReview(aris, { id: "R2", structured: { status: "valid", data: { summary: "structured round" } } }, config.reviewer.model, "Review"), true);
  assert.equal(recordReview(aris, { id: "R3", structured: { status: "invalid", data: { summary: "x" } } }, config.reviewer.model, "Review"), false);
  const next = prepareArisCall(aris, { context: "shared", tasks: [plain, { name: "R3", agent: REVIEWER_AGENT, task: "Re-review" }, { name: "W2", agent: WORKER_AGENT, task: "Collect numbers", model: "x/y" }] }, [{ name: "R3", waveId: "Review" }]);
  assert.equal(next.tasks[0], plain);
  assert.equal(next.context, "shared");
  assert.match(next.tasks[1].task, /^Re-review[\s\S]*## 이전 검토 라운드/);
  assert.match(next.tasks[1].task, /### 라운드 1 \(job R1, 모델 openai-codex\/gpt-6\.2-astra\)\nRound one findings/);
  assert.match(next.tasks[1].task, /### 라운드 2 \(job R2[\s\S]*"summary": "structured round"/);
  assert.doesNotMatch(next.tasks[1].task, /작업 패킷 실행 조건/);
  assert.equal(next.tasks[2].model, taskModelSelector(config.worker));
  assert.doesNotMatch(next.tasks[2].task, /이전 검토 라운드|Round one findings|structured round/);
});

test("spawn policy uses selected role specs, blocks retired helpers and leaves other spawns to the host", () => {
  const aris = createArisRun("run-2", decision, { ...config, reviewer: { model: "openai/gpt-6-astra", reasoning: "high" }, worker: { model: "google/gemini-custom", reasoning: "auto" } }, [reviewSkill], install);
  assert.deepEqual(arisSpawnPolicy(aris, { invocationKind: "task", agent: REVIEWER_AGENT, spawnKey: "R1" }), { model: "openai/gpt-6-astra:high" });
  assert.deepEqual(arisSpawnPolicy(aris, { invocationKind: "task", agent: WORKER_AGENT, spawnKey: "W1" }), { model: "google/gemini-custom:auto" });
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "task", agent: "rh-thinker" }).block, true);
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "task", agent: "scout" }), undefined);
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "eval", agent: REVIEWER_AGENT }), undefined);
  assert.equal(arisSpawnPolicy(aris, { invocationKind: "eval", agent: WORKER_AGENT }), undefined);
  assert.equal(arisSpawnPolicy(aris, undefined), undefined);
});


const FULL = `## 검토 범위\n\n<irc from="parent">는 본문 일부\n${"- 항목\n".repeat(400)}END`;
const previewOf = text => text.slice(0, 80).replace(/<(?=\s*\/?\s*(?:irc|system-[a-z][a-z-]*)(?![\w-]))/gi, "&lt;");
const envelope = (id, body, agent = REVIEWER_AGENT, status = "completed") =>
  `<task-result id="${id}" agent="${agent}" status="${status}" duration="9m">\n<meta lines="404" size="3.2KB" />\n${body}\n</task-result>\n\n${id} is now idle`;
const preview = (id, pointer = id, text = FULL) => envelope(id, `<preview full-output="agent://${pointer}">\n${previewOf(text)}\n</preview>`);

test("preview envelopes are references to the job's own agent:// output and never inline evidence", () => {
  const item = { id: "R1", resultText: preview("R1") };
  assert.equal(reviewOutput(item), "");
  assert.deepEqual(reviewReference(item), { id: "R1", preview: previewOf(FULL) });
  assert.equal(reviewReference({ id: "R1", resultText: preview("R1", "Other") }), undefined, "foreign pointer");
  assert.equal(reviewReference({ id: "R1", resultText: preview("R2") }), undefined, "envelope for another job");
  assert.equal(reviewReference({ id: "R1", resultText: envelope("R1", `<preview full-output="agent://R1">\nx\n</preview>`, "scout") }), undefined, "other agent");
  assert.equal(reviewReference({ id: "R1", resultText: envelope("R1", `<preview full-output="agent://R1">\nx\n</preview>`, REVIEWER_AGENT, "failed (exit 1)") }), undefined);
  assert.equal(reviewReference({ id: "R1", output: "inline", resultText: preview("R1") }), undefined, "inline output wins");
  assert.equal(reviewReference({ id: "R1", structured: { status: "valid", data: {} }, resultText: preview("R1") }), undefined);
  assert.equal(reviewOutput({ id: "R1", resultText: envelope("R1", "<output>\nshort body\n</output>") }), "short body");
});

test("hydration reads only the referenced id, keeps the whole output and fails on error, emptiness or a different document", async () => {
  const item = { id: "R1", status: "completed", resolvedModelIdentity: DEFAULT_MODELS.reviewer.model, resultText: preview("R1") };
  const reads = [];
  const hydrated = await hydrateReview(item, async id => { reads.push(id); return FULL; });
  assert.deepEqual(reads, ["R1"]);
  assert.equal(hydrated.output, FULL);
  assert.equal(hydrated.resultText, item.resultText);
  assert.equal(hydrated.status, "completed");
  assert.equal(reviewOutput(hydrated), FULL);
  const aris = run();
  assert.equal(recordReview(aris, hydrated, DEFAULT_MODELS.reviewer.model, "Review"), true);
  assert.ok(prepareArisCall(aris, { name: "R2", agent: REVIEWER_AGENT, task: "next" }, [{ name: "R2", waveId: "Review" }]).task.endsWith("END"));

  const plain = { id: "R1", output: "inline" };
  assert.equal(await hydrateReview(plain, async () => { throw new Error("never"); }), plain, "inline items pass through untouched");
  const foreign = { id: "R1", resultText: preview("R1", "Other") };
  assert.equal(await hydrateReview(foreign, async () => { throw new Error("never"); }), foreign);

  const failing = await hydrateReview(item, async () => { throw new Error("Not found: R1"); });
  assert.equal(failing.status, "failed");
  assert.equal(failing.resultText, undefined);
  assert.match(failing.error, /agent:\/\/R1\)을 확인하지 못함: Not found: R1/);
  assert.equal(reviewOutput(failing), "");
  assert.match((await hydrateReview(item, async () => "\n  ")).error, /본문이 비어 있음/);
  assert.match((await hydrateReview(item, async () => "## 다른 문서\n\n내용")).error, /미리보기와 일치하지 않음/);
  assert.equal(recordReview(run(), failing, DEFAULT_MODELS.reviewer.model, "Review"), false);
});

test("independent reviewer stages keep separate histories and require validated bindings", () => {
  const aris = run();
  assert.equal(recordReview(aris, { id: "Left__One", output: "LEFT findings" }, config.reviewer.model, "Left"), true);
  assert.equal(recordReview(aris, { id: "Right__One", output: "RIGHT findings" }, config.reviewer.model, "Right"), true);
  const prepared = prepareArisCall(aris, { tasks: [
    { name: "Left__Two", agent: REVIEWER_AGENT, task: "Re-review left" },
    { name: "Right__Two", agent: REVIEWER_AGENT, task: "Re-review right" },
  ] }, [{ name: "Left__Two", waveId: "Left" }, { name: "Right__Two", waveId: "Right" }]);
  assert.match(prepared.tasks[0].task, /LEFT findings/);
  assert.doesNotMatch(prepared.tasks[0].task, /RIGHT findings/);
  assert.match(prepared.tasks[1].task, /RIGHT findings/);
  assert.doesNotMatch(prepared.tasks[1].task, /LEFT findings/);
  assert.throws(() => prepareArisCall(aris, { name: "Unbound", agent: REVIEWER_AGENT, task: "Review" }), /validated Router stage/);
  assert.equal(recordReview(aris, { id: "Unbound", output: "findings" }, config.reviewer.model), false);
});

test("custom identities and efforts survive immutable snapshots and override raw skill recommendations", () => {
  const selected = { ...config, brain: { model: "google/gemini-custom", reasoning: "auto" },
    worker: { model: "openai-codex/gpt-6-astra", reasoning: "low" },
    reviewer: { model: "anthropic/claude-opus-5-5", reasoning: "high" } };
  const skill = { ...reviewSkill, content: `${reviewSkill.content}\nUse Fable high, Opus medium and Astra max.` };
  const aris = createArisRun("custom", decision, selected, [skill], install);
  selected.worker.model = "wrong/replacement";
  selected.reviewer.reasoning = "low";
  assert.equal(Object.isFrozen(aris.config), true);
  assert.equal(Object.isFrozen(aris.config.worker), true);
  assert.equal(aris.config.worker.model, "openai-codex/gpt-6-astra");
  const handoff = arisHandoff(aris, "/agents");
  const contract = handoff.slice(handoff.indexOf("## OMP 실행 계약"));
  for (const role of ["router", "brain", "worker", "reviewer", "solo"]) {
    assert.ok(contract.includes(`${aris.config[role].model} (effort ${aris.config[role].reasoning})`));
  }
  assert.match(contract, /하드코딩된 모델·패밀리·추론 강도 권고보다 우선/);
  assert.match(contract, /교차 모델 독립성의 증명이 아닙니다/);
  const tasks = prepareArisCall(aris, { tasks: [
    { name: "Work", agent: WORKER_AGENT, task: "Execute packet", model: "wrong/model", effort: "max", reasoning: "max", tools: ["task"] },
    { name: "Review", agent: REVIEWER_AGENT, task: "Read /brief", model: "wrong/model", effort: "max" },
  ] }, [{ name: "Review", waveId: "Inspect" }]).tasks;
  for (const [index, role] of ["worker", "reviewer"].entries()) {
    assert.equal(tasks[index].model, taskModelSelector(aris.config[role]));
    assert.deepEqual(arisSpawnPolicy(aris, { invocationKind: "task", agent: tasks[index].agent }), { model: tasks[index].model });
    assert.ok(tasks[index].task.includes(`effort ${aris.config[role].reasoning}`));
    assert.equal(tasks[index].effort, undefined);
    assert.equal(tasks[index].reasoning, undefined);
    assert.equal(tasks[index].tools, undefined);
  }
});

test("all-Astra and non-reasoning auto use exactly the chosen model without a fallback", () => {
  for (const [model, reasoning] of [["openai-codex/gpt-6-astra", "max"], ["local/plain-chat", "auto"]]) {
    const selected = uniformModelConfig(model, reasoning);
    const aris = createArisRun("uniform", decision, selected, [reviewSkill], install);
    for (const role of MODEL_ROLES) assert.deepEqual(aris.config[role], { model, reasoning });
    const packet = prepareArisCall(aris, { agent: WORKER_AGENT, task: "Execute" });
    const review = prepareArisCall(aris, { agent: REVIEWER_AGENT, name: "Review", task: "Read /brief" }, [{ name: "Review", waveId: "Inspect" }]);
    assert.equal(packet.model, taskModelSelector(selected.worker));
    assert.equal(review.model, packet.model);
    assert.deepEqual(arisSpawnPolicy(aris, { invocationKind: "task", agent: REVIEWER_AGENT }), { model: packet.model });
  }
});
