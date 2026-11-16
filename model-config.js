import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const MODEL_ROLES = Object.freeze(["router", "brain", "worker", "reviewer", "solo", "summary", "analysis"]);
export const ROLE_LABELS = Object.freeze({ router: "Router", brain: "Brain", worker: "Worker", reviewer: "Reviewer", solo: "Solo", summary: "요청 요약", analysis: "Dashboard 분석" });
export const REASONING_LEVELS = Object.freeze(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const DEFAULT_MODELS = Object.freeze(Object.fromEntries(Object.entries({
  router: { model: "openai-codex/gpt-6.1-terra", reasoning: "xhigh" },
  brain: { model: "anthropic/claude-fable-5-2", reasoning: "high" },
  worker: { model: "anthropic/claude-opus-5-5", reasoning: "medium" },
  reviewer: { model: "openai-codex/gpt-6-astra", reasoning: "max" },
  solo: { model: "openai-codex/gpt-6-astra", reasoning: "max" },
  summary: { model: "openai-codex/gpt-6-luna", reasoning: "low" },
  analysis: { model: "openai-codex/gpt-6-astra", reasoning: "high" },
}).map(([role, value]) => [role, Object.freeze(value)])));

export function normalizeModelConfig(input = DEFAULT_MODELS) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("모델 설정은 객체여야 합니다.");
  return Object.freeze(Object.fromEntries(MODEL_ROLES.map(role => {
    const spec = input[role] ?? DEFAULT_MODELS[role];
    if (!spec || typeof spec.model !== "string" || !/^[^/\s]+\/\S+$/.test(spec.model)) throw new Error(`${ROLE_LABELS[role]} 모델에는 정확한 provider/model이 필요합니다.`);
    if (!REASONING_LEVELS.includes(spec.reasoning)) throw new Error(`${ROLE_LABELS[role]}의 추론 강도를 확인하세요.`);
    return [role, Object.freeze({ model: spec.model, reasoning: spec.reasoning })];
  })));
}

export function uniformModelConfig(model, reasoning = "auto") {
  return normalizeModelConfig(Object.fromEntries(MODEL_ROLES.map(role => [role, { model, reasoning }])));
}

export function modelConfigPath() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "strataa", "models.json");
}

export function readModelConfig({ file = modelConfigPath(), fallback = DEFAULT_MODELS } = {}) {
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return normalizeModelConfig(fallback); throw error; }
  let saved;
  try { saved = JSON.parse(text); }
  catch { throw new Error(`Strataa 모델 설정을 읽을 수 없습니다: ${file}`); }
  if (saved?.version !== 1 || !saved.roles || !MODEL_ROLES.every(role => Object.hasOwn(saved.roles, role))) throw new Error(`지원하지 않거나 불완전한 Strataa 모델 설정입니다: ${file}`);
  return normalizeModelConfig(saved.roles);
}

export function writeModelConfig(input, { file = modelConfigPath() } = {}) {
  const roles = normalizeModelConfig(input);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, roles }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return roles;
}

export function supportedReasoning(model) {
  return ["auto", ...(model.reasoning && Array.isArray(model.thinking?.efforts) ? model.thinking.efforts.filter(effort => effort !== "auto" && REASONING_LEVELS.includes(effort)) : [])];
}

export function validateModelChoice(models, spec, label = "모델") {
  const model = models.find(item => `${item.provider}/${item.id}` === spec.model);
  if (!model) throw new Error(`${label} 모델을 사용할 수 없습니다: ${spec.model}. /login 또는 /strataa models를 확인하세요.`);
  if (!supportedReasoning(model).includes(spec.reasoning)) throw new Error(`${label} 모델은 추론 강도 ${spec.reasoning}를 지원하지 않습니다: ${spec.model}. 자동 대체하지 않습니다.`);
  return model;
}

export function taskModelSelector(spec) {
  return `${spec.model}:${spec.reasoning}`;
}
