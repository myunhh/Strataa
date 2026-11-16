import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULT_MODELS, MODEL_ROLES, readModelConfig, writeModelConfig, uniformModelConfig, validateModelChoice, taskModelSelector } from "../model-config.js";

function profileFile(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "strataa-models-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "config", "models.json");
}

test("shared profiles round-trip without mutating an already captured run", t => {
  const file = profileFile(t);
  const selected = uniformModelConfig("custom/model@route", "auto");
  const original = writeModelConfig(selected, { file });
  assert.deepEqual(readModelConfig({ file }), selected);
  const changed = writeModelConfig({ ...selected, reviewer: { model: "other/reviewer", reasoning: "high" } }, { file });
  assert.equal(readModelConfig({ file }).reviewer.model, "other/reviewer");
  assert.equal(original.reviewer.model, "custom/model@route");
  assert.throws(() => { original.reviewer.model = changed.reviewer.model; }, TypeError);
  assert.deepEqual(readdirSync(path.dirname(file)), ["models.json"]);
  assert.equal(taskModelSelector(original.worker), "custom/model@route:auto", "auto must override an agent's previous fixed effort");
});

test("invalid saves preserve the previous profile and invalid persisted profiles never silently fall back", t => {
  const file = profileFile(t);
  writeModelConfig(uniformModelConfig("custom/model", "auto"), { file });
  const previous = readFileSync(file, "utf8");
  assert.throws(() => writeModelConfig({ reviewer: { model: "bare-id", reasoning: "high" } }, { file }));
  assert.equal(readFileSync(file, "utf8"), previous);
  for (const corrupt of ["{", JSON.stringify({ version: 2, roles: DEFAULT_MODELS }), JSON.stringify({ version: 1, roles: { solo: DEFAULT_MODELS.solo } })]) {
    writeFileSync(file, corrupt);
    assert.throws(() => readModelConfig({ file, fallback: DEFAULT_MODELS }));
  }
  writeModelConfig(DEFAULT_MODELS, { file });
  assert.deepEqual(readModelConfig({ file }), DEFAULT_MODELS, "restoring the recommended profile repairs invalid saved settings");
});

test("legacy fallback applies only before a shared profile exists", t => {
  const file = profileFile(t);
  const legacy = uniformModelConfig("legacy/model", "high");
  assert.deepEqual(readModelConfig({ file, fallback: legacy }), legacy);
  const shared = uniformModelConfig("shared/model", "auto");
  writeModelConfig(shared, { file });
  assert.deepEqual(readModelConfig({ file, fallback: legacy }), shared);
});

test("catalog choices accept arbitrary families but reject aliases and unsupported explicit efforts", () => {
  const model = { provider: "custom", id: "non-reasoning", reasoning: false };
  const roles = uniformModelConfig("custom/non-reasoning", "auto");
  for (const role of MODEL_ROLES) assert.equal(validateModelChoice([model], roles[role]), model);
  assert.throws(() => validateModelChoice([model], { model: "custom/non-reasoning", reasoning: "high" }), /자동 대체하지 않습니다/);
  assert.throws(() => validateModelChoice([model], { model: "alias/non-reasoning", reasoning: "auto" }), /사용할 수 없습니다/);
});
