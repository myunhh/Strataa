import { findScopedSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { MODEL_ROLES, normalizeModelConfig } from "./model-config.js";

export async function approveModels(config, ctx) {
  const models = normalizeModelConfig(config);
  const settings = findScopedSettings(ctx.cwd);
  const policy = lookup("task.perCallModel");
  const allowlist = lookup("task.perCallModelAllow");
  if (!settings || !policy || !allowlist) throw new Error("OMP 모델 승인 API를 사용할 수 없습니다. OMP를 업데이트하세요.");
  if (ctx.agent && ctx.agent.kind !== "main") throw new Error("Strataa 모델 승인은 메인 세션에서만 변경할 수 있습니다.");

  const selected = [...new Set(MODEL_ROLES.map(role => models[role].model))];
  for (const setting of [policy, allowlist]) {
    const source = setting.provenance(settings);
    if (source === "global" || source === "default") continue;
    const value = setting.get(settings);
    if (setting === policy ? value !== "on" : value.length && selected.some(model => !value.includes(model))) {
      throw new Error(`OMP ${setting.id}의 ${source} 제한이 선택한 모델을 차단합니다. 해당 제한을 변경한 뒤 다시 선택하세요.`);
    }
  }
  for (const role of MODEL_ROLES) {
    const key = `strataa-${role}`;
    const source = settings.getModelRoleProvenance(key);
    if (["overlay", "runtime"].includes(source) && settings.getModelRole(key) !== models[role].model) {
      throw new Error(`OMP ${key}의 ${source} 설정이 선택한 모델과 다릅니다. 해당 설정을 변경한 뒤 다시 선택하세요.`);
    }
  }

  for (const role of MODEL_ROLES) settings.setModelRole(`strataa-${role}`, models[role].model);
  policy.set(settings, "on");
  const allowed = allowlist.get(settings.grantAuthority());
  if (allowed.length) {
    for (const model of selected) if (!allowed.includes(model)) allowlist.setMember(settings, model, { member: true });
  }
  await settings.flush();

  if (policy.get(settings.grantAuthority()) !== "on" || policy.get(settings) !== "on") {
    throw new Error("OMP 모델 지정 정책이 변경되었습니다. /strataa on으로 다시 동기화하세요.");
  }
  for (const role of MODEL_ROLES) {
    if (settings.grantAuthority().getModelRole(`strataa-${role}`) !== models[role].model) {
      throw new Error(`OMP strataa-${role} 등록이 적용되지 않았습니다. /strataa on으로 다시 동기화하세요.`);
    }
  }
}
