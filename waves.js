// Terra plans a stage DAG; equal dependency depths share an execution Wave, not agent recursion depth.
export const MAX_WAVES = 12;
export const MAX_WAVE_PARALLEL = 4;
const ID = /^[A-Z][A-Za-z0-9]{0,15}$/;
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function parseWaves(value) {
  if (!Array.isArray(value) || value.length > MAX_WAVES) throw new Error(`Terra must supply waves: an array of 0–${MAX_WAVES} execution stages; no request was executed.`);
  const byId = new Map();
  const waves = value.map(stage => {
    if (!stage || typeof stage.id !== "string" || !ID.test(stage.id) || byId.has(stage.id) || !text(stage.title, 120) || !text(stage.goal, 1000) ||
      !Number.isInteger(stage.parallel) || stage.parallel < 1 || stage.parallel > MAX_WAVE_PARALLEL ||
      !Array.isArray(stage.dependsOn) || stage.dependsOn.some(id => typeof id !== "string" || !ID.test(id)) ||
      new Set(stage.dependsOn).size !== stage.dependsOn.length) {
      throw new Error("Invalid Terra stage: unique CamelCase id, title, goal, parallel (1–4) and distinct dependsOn stage IDs required; no request was executed.");
    }
    const parsed = { id: stage.id, title: stage.title.trim(), goal: stage.goal.trim(), parallel: stage.parallel, dependsOn: [...stage.dependsOn] };
    byId.set(parsed.id, parsed);
    return parsed;
  });
  const visiting = new Set();
  const level = stage => {
    if (stage.wave !== undefined) return stage.wave;
    if (visiting.has(stage.id)) throw new Error(`Cyclic Terra dependencies at ${stage.id}; no request was executed.`);
    visiting.add(stage.id);
    let wave = 2;
    for (const id of stage.dependsOn) {
      const dependency = byId.get(id);
      if (!dependency) throw new Error(`Unknown Terra dependency ${id} for ${stage.id}; no request was executed.`);
      wave = Math.max(wave, level(dependency) + 1);
    }
    visiting.delete(stage.id);
    return (stage.wave = wave);
  };
  waves.forEach(level);
  return waves;
}

export function waveRows(flow, index) {
  return flow.rows.filter(row => row.waveId === flow.waves[index].id && row.jobIds.length > 0);
}

export function waveComplete(flow, index) {
  const rows = waveRows(flow, index);
  return rows.length > 0 && rows.every(row => row.state === "completed" && row.jobs.length > 0 && typeof row.output === "string" && row.output.trim() &&
    row.jobs.every(job => job.state === "completed" && job.resultReceived === true));
}

export function unfinishedWaves(flow) {
  return (flow.waves ?? []).filter((_wave, index) => !waveComplete(flow, index)).map(wave => wave.id);
}

/** Validate the entire ready batch before reserving any stage names or capacity. */
export function prepareWaveCall(flow, input) {
  if (!flow.waves?.length) throw new Error("Terra selected main-session work without delegated Waves; do not spawn subagents.");
  if (!input || typeof input !== "object" || Array.isArray(input) || (input.tasks !== undefined && !Array.isArray(input.tasks))) throw new Error("Wave task input must be an object with an optional tasks array.");
  const batch = Array.isArray(input.tasks);
  const items = batch ? input.tasks : [input];
  if (!items.length) throw new Error("A Wave task batch must not be empty.");
  const stages = flow.waves;
  const indices = new Map(stages.map((stage, index) => [stage.id, index]));
  const rows = stages.map((_stage, index) => waveRows(flow, index));
  const closed = new Set(stages.filter((_stage, index) => rows[index].length).flatMap(stage => stage.dependsOn));
  const failed = stageRows => stageRows.some(row => ["failed", "cancelled", "interrupted", "skipped"].includes(row.state));
  const pending = row => !["failed", "cancelled", "interrupted", "skipped"].includes(row.state) &&
    (row.state !== "completed" || !row.jobs.length ||
      row.jobs.some(job => job.state !== "completed" || !job.resultReceived));
  const ready = index => !closed.has(stages[index].id) && !failed(rows[index]) &&
    stages[index].dependsOn.every(id => waveComplete(flow, indices.get(id)));
  const eligible = stages.map((_stage, index) => index).filter(ready);
  const names = new Set(flow.rows.flatMap(row => row.jobIds));
  const counts = new Map();
  const bindings = [];
  let nextName = flow.nextWaveTask ?? 1;
  const tasks = items.map(item => {
    if (!item || typeof item !== "object" || !text(item.task, 1000000)) throw new Error("Each Wave task must contain a work packet.");
    let name = item.name;
    if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name))) throw new Error("Wave task names must be 1–32 letters, digits, underscores or hyphens, starting with a letter.");
    const prefix = name?.includes("__") ? name.split("__", 1)[0] : undefined;
    const index = prefix ? indices.get(prefix) : eligible.length === 1 ? eligible[0] : undefined;
    if (index === undefined) throw new Error(prefix ? `Unknown Terra stage prefix: ${prefix}` : "Use <stage ID>__<task> to select an unambiguous ready stage.");
    const stage = stages[index];
    if (closed.has(stage.id)) throw new Error(`Terra stage ${stage.id} is closed: a dependent stage has started.`);
    if (failed(rows[index])) throw new Error(`Terra stage ${stage.id} has a failed or interrupted task; do not retry automatically.`);
    for (const id of stage.dependsOn) {
      if (!waveComplete(flow, indices.get(id))) throw new Error(`Dependency ${id} must finish successfully with full public results before ${stage.id} starts.`);
    }
    if (!name) {
      do { name = `${stage.id}__Task${nextName++}`; } while (names.has(name));
    }
    if (names.has(name)) throw new Error(`Wave task name already used: ${name}. Use a new name for another round.`);
    names.add(name);
    counts.set(index, (counts.get(index) ?? 0) + 1);
    bindings.push({ name, waveId: stage.id });
    return { ...item, name, task: `${item.task}\n\n## Terra Wave ${stage.wave}: ${stage.title} [${stage.id}]\n계획 목표: ${stage.goal}\n선행 결과: ${stage.dependsOn.join(", ") || "없음"}\n위 작업 패킷만 실행하세요. 다른 단계와 모든 추가 에이전트 호출은 메인 세션이 담당합니다. 재위임, 외부 에이전트 대체 호출, 재귀 한도·설정 변경은 하지 마세요. 실제 산출물·공개 결과·실패를 메인 세션에 반환하세요.` };
  });
  // Starting a consumer and reopening its producer in one batch would race the evidence it consumes.
  const selected = new Set(bindings.map(binding => binding.waveId));
  if (bindings.some(binding => stages[indices.get(binding.waveId)].dependsOn.some(id => selected.has(id)))) {
    throw new Error("Dependent stages cannot share a task batch; dispatch only independent ready work.");
  }
  for (const [index, count] of counts) {
    if (rows[index].filter(pending).length + count > stages[index].parallel) {
      throw new Error(`Stage ${stages[index].id} permits at most ${stages[index].parallel} concurrent tasks; wait for existing results.`);
    }
  }
  if (rows.flat().filter(pending).length + tasks.length > MAX_WAVE_PARALLEL) {
    throw new Error(`Strataa permits at most ${MAX_WAVE_PARALLEL} concurrent tasks across all Waves; wait for existing results.`);
  }
  return { input: batch ? { ...input, tasks } : tasks[0], bindings, nextName };
}

export function waveHandoff(waves) {
  return `## Terra 의존성 기반 Wave 계약
Wave 0=Terra 라우팅, Wave 1=당신(메인)의 조정·최종 답변입니다. Wave 2부터는 선행 결과의 의존 깊이로 묶은 실행 단계이며 재귀 깊이가 아닙니다.
${waves.length ? waves.map(stage => `- Wave ${stage.wave} [${stage.id}] ${stage.title}: ${stage.goal} (선행: ${stage.dependsOn.join(", ") || "없음"}; 단계 동시 최대 ${stage.parallel}개)`).join("\n") : "- 위임 단계 없음: 직접 처리하고 서브에이전트를 호출하지 마세요."}
1. 실행 전 각 작업의 입력 산출물·수정 파일·공유 자원을 확인하세요. 준비된 독립 작업은 역할·모델이 달라도 native task의 한 tasks[] 배치로 함께 시작하세요. 한 작업의 결과가 필요하거나 같은 파일을 수정하거나 변경 중인 산출물을 검토하는 작업은 독립적이지 않습니다. 모델이 다르다는 이유만으로 직렬화하지 말고, 모델이 같다는 이유만으로 병렬화하지 마세요.
2. 이름은 <단계 ID>__<작업명> (총 32자 이하)입니다. 예: ${waves[0]?.id ?? "Inspect"}__Read. 다른 단계 ID도 독립적이고 준비되었으면 같은 배치에 넣을 수 있습니다. 접두사 생략은 준비된 단계가 하나뿐일 때만 허용됩니다. 각 dependsOn의 모든 작업이 성공하고 공개 결과 전문을 받은 뒤 소비 작업을 시작하세요. 무관한 단계의 종료까지 기다릴 필요는 없습니다. 배치 안에서 생산자와 그 결과를 소비하는 작업을 함께 시작하지 마세요.
3. 단계별 parallel과 실행 전체 동시 최대 ${MAX_WAVE_PARALLEL}개를 지키세요. 종속성이 실제 자료와 다르면 작업을 억지로 병렬화하지 말고 해당 결과를 기다리며 이유를 보고하세요. 없는 결과·실패·취소·미수신 결과를 성공으로 간주하지 마세요.
4. 모든 task는 당신이 직접 호출합니다. 자식 재위임, eval agent()/workpool, 외부 대체 에이전트 호출과 재귀 한도·전역 설정 변경은 금지입니다. 작업자와 검토자의 기존 권한·고정 모델을 유지합니다.
5. 반복 검토·내부 루프는 해당 단계에서 새 이름으로 진행합니다. 그 결과를 소비하는 단계가 시작되면 선행 단계는 닫힙니다. 모든 계획 단계에서 실제 성공 결과가 최소 하나 필요합니다. 이 계획은 추가 비용·설치·배포·수정 권한이 아닙니다.`;
}
