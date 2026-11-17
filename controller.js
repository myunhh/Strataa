import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ARIS_ROUTES, DEFAULT_REVIEW_SKILL, collectContext, routeRequest } from "./protocol.js";
import { FLOW, createFlow, expectNative, finishFlow, flowText, nativeReference, observeNative, planFlow, publicText, restoreFlow, reviewProblem, startExecution, updateStage } from "./flow.js";
import { REVIEWER_AGENT, WORKER_AGENT, arisHandoff, arisSpawnPolicy, createArisRun, escapeHarnessTags, hydrateReview, prepareArisCall, recordReview } from "./aris-runtime.js";
import { prepareWaveCall, waveHandoff } from "./waves.js";
import { DEFAULT_MODELS, MODEL_ROLES, ROLE_LABELS, normalizeModelConfig, supportedReasoning, validateModelChoice, uniformModelConfig, taskModelSelector } from "./model-config.js";
import { projectHandoff } from "./project-context.js";
import { getPstackCatalog, pstackHandoff, validatePstackInstall } from "./pstack-runtime.js";

const STATE = "agent-dialogue-state";
const CARD = "agent-dialogue";
const AGENTS_DIR = fileURLToPath(new URL("./agents/", import.meta.url));
const HELP = [
  "/strataa on · off · status · stop",
  "/strataa skills — 설치된 ARIS 스킬 목록과 실행 준비 상태",
  "/strataa pstack — CLI 엔지니어링 스킬 58개·에이전트 2개·원본 무결성",
  "/strataa flow — Wave 카드 그래프 · 노드 선택 · 공개 작업/결과 상세",
  "/strataa watch — 연결된 모든 OMP 세션의 공개 Flow 모니터",
  "/strataa models — 전체 모델 · 전체 역할 일괄 선택 · 역할별 선택 · 추천 기본 조합",
  "/strataa models all <provider/model> [effort] · models default",
  `/strataa <${MODEL_ROLES.join("|")}> [provider/model] [effort] — 생략하면 선택창`,
  "ON = AUTO: 설정한 Router가 Solo / ARIS 검토 / ARIS 연구를 선택합니다.",
  `ARIS: Brain이 조정하고 ${WORKER_AGENT}가 실행하며 별도 ${REVIEWER_AGENT} 세션이 검토합니다. 같은 모델 선택은 교차 모델 검증이 아닙니다.`,
  "라우팅에는 최근 텍스트(최대 24,000자)와 요청/이미지를 전송하며 추가 사용량이 발생합니다.",
].join("\n");

function restoredState(entries) {
  let result = { enabled: false, models: DEFAULT_MODELS };
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE) continue;
    const data = entry.data;
    if (![1, 2, 3, 4, 5].includes(data?.version) || typeof data.enabled !== "boolean") continue;
    try {
      if (data.version === 5) {
        if (!data.models) continue;
        result = { enabled: data.enabled, models: normalizeModelConfig(data.models) };
        continue;
      }
      const required = data.version === 1 ? [] : data.version < 4 ? ["astra", "opus"] : ["fable", "opus", "astra"];
      if (!required.every(role => typeof data[role] === "string" && /^[^\s/]+\/\S+$/.test(data[role]))) continue;
      const models = { ...DEFAULT_MODELS };
      if (data.version > 1) {
        const worker = data.version < 4 && data.opus === "anthropic/claude-opus-4-6" ? DEFAULT_MODELS.worker.model : data.opus;
        models.worker = { ...models.worker, model: worker };
        models.reviewer = { ...models.reviewer, model: data.astra };
        models.solo = { ...models.solo, model: data.astra };
        if (data.version === 4) models.brain = { ...models.brain, model: data.fable };
      }
      result = { enabled: data.enabled, models: normalizeModelConfig(models) };
    } catch { /* An invalid saved entry does not erase the last valid branch state. */ }
  }
  return result;
}


function assertModel(ctx, config, role) {
  return validateModelChoice(ctx.models.list(), config[role], ROLE_LABELS[role]);
}

/** Readiness of the ARIS path: installed bundle, native task tool, owned agents and all three models. */
function arisReadiness(pi, ctx, config, validateArisInstall) {
  let install;
  let problem;
  try { install = validateArisInstall(); }
  catch (error) { problem = error instanceof Error ? error.message : String(error); }
  const task = pi.getActiveTools().includes("task") && pi.getAllTools().find(tool => tool.name === "task");
  if (!problem && !task) problem = "native task 도구가 비활성화되어 있습니다";
  if (!problem) {
    const missing = [WORKER_AGENT, REVIEWER_AGENT].find(agent => !task.description.includes(`- \`${agent}\``));
    if (missing) problem = `${missing} 에이전트가 native task 목록에 없습니다. /reload-plugins가 필요합니다`;
  }
  for (const role of ["brain", "worker", "reviewer"]) {
    if (problem) break;
    try { assertModel(ctx, config, role); }
    catch (error) { problem = error.message; }
  }
  return { install, problem };
}

const routeTitle = decision => decision.route === "solo" ? (decision.waves.length ? "Solo 주도" : "Solo 단독")
  : `${decision.route === "dialogue" ? "ARIS 검토" : "ARIS 연구"} · ${decision.skills.join(", ")}`;

const isRecord = value => !!value && typeof value === "object" && !Array.isArray(value);

// Factories are rebound by the host in each child session. Only live root runs
// enter this bridge; a child factory binds once to an already admitted host job.
const observedRuns = new Set();

/**
 * Factory-local state: subagents never inherit the main session's active run.
 * `skills` is the installed-bundle accessor ({ getArisCatalog, loadArisSkills, validateArisInstall }).
 * `readAgentOutput(id, ctx)` resolves a published `agent://<id>` document through the host; a host
 * without one fails every detached round instead of guessing at files.
 * `monitor` optionally supplies a publisher, watch component factory and original-prompt summarizer.
 */
export function registerStrataa(pi, runModelTurn, createFlowView, skills, readAgentOutput = async id => {
  throw new Error(`agent://${id} 공개 출력을 읽을 수단이 호스트에 없음`);
}, monitor = {}, modelSettings) {
  const { getArisCatalog, loadArisSkills, validateArisInstall } = {
    getArisCatalog: () => skills.getArisCatalog(),
    loadArisSkills: names => skills.loadArisSkills(names),
    validateArisInstall: () => skills.validateArisInstall(),
  };
  let state = { enabled: false, models: DEFAULT_MODELS };
  let active;
  let unsubscribe;
  let revision = 0;
  let execution;
  let displayedRun;
  let explorer;
  let watcher;
  let monitorErrorReported = false;
  let monitorStopped = false;
  let flowGeneration = 0;
  let observedContext;
  let observationOwner;
  let observationIdentity;
  const observationSubscriptions = [];
  // Host setModel is asynchronous and not abortable. Drain switches before
  // session navigation, and serialize replacement requests through the same gate.
  let handoffTail = Promise.resolve();

  const isMain = ctx => !ctx.agent || ctx.agent.kind === "main";
  const card = (content, details = {}) => pi.sendMessage({
    customType: CARD, content, display: true, details,
  }, { triggerTurn: false });
  const status = ctx => ctx.ui.setStatus(CARD, state.enabled ? "Strataa AUTO · Router → Solo / Brain · Worker · Reviewer" : undefined);
  const persist = ctx => {
    revision++;
    pi.appendEntry(STATE, { version: 5, ...state });
    status(ctx);
  };
  const refreshModels = () => { state.models = modelSettings.read({ fallback: state.models }); };
  const saveModels = async (models, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const startedAtRevision = revision;
    models = normalizeModelConfig(models);
    await modelSettings.approve(models, ctx);
    if (revision !== startedAtRevision || ctx.sessionManager.getSessionId() !== sessionId) {
      throw new Error("모델 승인 중 세션·설정이 변경되어 선택을 저장하지 않았습니다. 다시 선택하세요.");
    }
    state.models = modelSettings.write(models);
  };
  const owns = run => active === run && !run.controller.signal.aborted &&
    run.ctx.sessionManager.getSessionId() === run.sessionId;

  function monitorFailure(ctx, error) {
    if (monitorErrorReported) return;
    monitorErrorReported = true;
    ctx.ui.notify(`Strataa Flow 모니터 오류: ${publicText(error instanceof Error ? error.message : String(error))}`, "error");
  }

  function publish(ctx, flow, run) {
    if (!isMain(ctx) || monitorStopped || !monitor.publisher) return;
    try {
      monitor.publisher.publish({
        sessionId: run?.sessionId ?? ctx.sessionManager.getSessionId(),
        sessionFile: run ? run.sessionFile : ctx.sessionManager.getSessionFile?.(),
        cwd: ctx.cwd, flow,
      });
    } catch (error) { monitorFailure(ctx, error); }
  }
  function abortSummary(reason) {
    if (displayedRun?.flow.promptSummary?.status === "running") {
      displayedRun.controller?.abort(new Error(reason));
    }
  }


  async function summarizePrompt(run) {
    const current = () => !monitorStopped && run.flowGeneration === flowGeneration && displayedRun === run &&
      run.ctx.sessionManager.getSessionId() === run.sessionId;
    try {
      const summary = await monitor.summarizePrompt(run.ctx, {
        text: run.text, imageCount: run.images.length, signal: run.controller.signal, config: run.config.summary,
      });
      if (!current()) return;
      if (run.controller.signal.aborted) throw run.controller.signal.reason;
      run.flow.promptSummary = { status: "completed", model: summary.model, text: publicText(summary.text) };
    } catch (error) {
      if (!current()) return;
      run.flow.promptSummary = { status: "failed", model: run.config.summary.model,
        error: publicText(error instanceof Error ? error.message : String(error)) };
    }
    paint(run, true);
  }

  function paint(run, save = false) {
    // Navigation may already have rebound the host context to another session.
    if (run.sessionId !== run.ctx.sessionManager.getSessionId()) return;
    displayedRun = run;
    if (save) pi.appendEntry(FLOW, structuredClone(run.flow));
    publish(run.ctx, run.flow, run);
    if (run.ctx.mode === "tui") {
      if (run.view) {
        run.view.invalidate();
        run.tui.requestRender();
      } else {
        run.ctx.ui.setWidget(FLOW, (tui, theme) => {
          run.tui = tui;
          run.view = createFlowView(() => run.flow, theme, { getHeight: () => tui.terminal.rows });
          return run.view;
        });
      }
    } else run.ctx.ui.setWidget(FLOW, flowText(run.flow));
    if (explorer?.run === run) {
      explorer.view?.invalidate();
      explorer.tui?.requestRender();
    }
    run.lastPaint = Date.now();
  }

  function endFlow(run, result, note) {
    if (run.flow.status !== "running") return;
    finishFlow(run.flow, result, note);
    observedRuns.delete(run);
    run.toolCalls?.clear();
    run.agentParents?.clear();
    run.publicOutputs?.clear();
    // UI-only: sendMessage during agent_end can queue a new model turn.
    paint(run, true);
  }

  function interruptExecution(note) {
    if (!execution) return;
    endFlow(execution.run, "interrupted", note);
    execution = undefined;
  }

  function cancel(reason, announce = true) {
    const run = active;
    if (!run) return;
    active = undefined;
    run.controller.abort(new Error(reason));
    endFlow(run, "cancelled", reason);
    status(run.ctx);
    if (announce && run.ctx.sessionManager.getSessionId() === run.sessionId) {
      card(`**에이전트 대화 중단** — ${reason}\n\n이번 요청은 실행하지 않았습니다. 다시 입력하면 새 대화를 시작합니다.`, { runId: run.id, phase: "cancelled" });
    }
  }

  function closeExplorer() {
    explorer?.close?.();
  }

  function closeWatcher() {
    watcher?.close?.();
  }

  async function showWatch(ctx) {
    if (!monitor.createWatch) {
      ctx.ui.notify("이 호스트에는 Strataa Flow 모니터가 연결되지 않았습니다.", "error");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/strataa watch는 TUI 터미널에서 사용할 수 있습니다.", "info");
      return;
    }
    if (watcher) return;
    const panel = {};
    const dispose = () => {
      if (panel.disposed) return;
      panel.disposed = true;
      panel.view?.dispose?.();
    };
    watcher = panel;
    try {
      await ctx.ui.custom((tui, theme, _keys, done) => {
        panel.close = () => { dispose(); done(undefined); };
        panel.view = monitor.createWatch(theme, {
          getHeight: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          onClose: panel.close,
        });
        return panel.view;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false } });
    } catch (error) {
      monitorFailure(ctx, error);
    } finally {
      dispose();
      if (watcher === panel) watcher = undefined;
    }
  }

  async function showFlow(ctx) {
    const run = displayedRun;
    if (!run) {
      ctx.ui.notify("아직 자동 라우팅 실행 기록이 없습니다. /strataa on 후 요청하세요.", "info");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.setWidget(FLOW, flowText(run.flow));
      return;
    }
    if (explorer) return;
    const panel = { run };
    const sessionId = ctx.sessionManager.getSessionId();
    const current = () => explorer === panel && displayedRun === run && ctx.sessionManager.getSessionId() === sessionId;
    explorer = panel;
    try {
      await ctx.ui.custom((tui, theme, _keys, done) => {
        panel.tui = tui;
        panel.close = () => done(undefined);
        panel.view = createFlowView(() => run.flow, theme, {
          interactive: true,
          getHeight: () => tui.terminal.rows,
          requestRender: () => tui.requestRender(),
          onClose: panel.close,
          readOutput: async selected => {
            if (!current()) throw new Error("세션 또는 실행이 변경되어 원문 읽기를 중단했습니다.");
            const row = run.flow.rows.find(item => item.id === selected.id);
            if (!row?.jobIds.length) throw new Error("이 노드에는 게시된 native 작업 원문이 없습니다.");
            const outputs = [];
            for (const id of row.jobIds) {
              if (!current()) throw new Error("세션 또는 실행이 변경되어 원문 읽기를 중단했습니다.");
              const text = publicText(await readAgentOutput(id, ctx));
              if (!text) throw new Error(`agent://${id}: 공개 출력이 비어 있습니다.`);
              outputs.push(row.jobIds.length > 1 ? `agent://${id}\n${text}` : text);
            }
            if (!current()) throw new Error("세션 또는 실행이 변경되어 원문 읽기를 중단했습니다.");
            return outputs.join("\n\n");
          },
        });
        return panel.view;
      }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 0, fullscreen: true, mouseTracking: false } });
    } catch (error) {
      if (current()) ctx.ui.notify(`Flow 화면을 열지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally {
      panel.view?.dispose?.();
      if (explorer === panel) explorer = undefined;
    }
  }

  async function pickModels(ctx, role) {
    if (!ctx.hasUI) throw new Error("모델 선택창에는 UI가 필요합니다. /strataa models all <provider/model> [effort] 또는 /strataa <role> <provider/model> [effort]를 사용하세요.");
    const sessionId = ctx.sessionManager.getSessionId();
    const startedAtRevision = revision;
    const previous = state.models;
    const fingerprint = JSON.stringify(previous);
    const assertCurrent = () => {
      if (revision !== startedAtRevision || sessionId !== ctx.sessionManager.getSessionId() || active ||
          JSON.stringify(modelSettings.read({ fallback: state.models })) !== fingerprint) {
        throw new Error("세션·설정 또는 실행 상태가 변경되어 모델 선택을 적용하지 않았습니다. 선택창을 다시 여세요.");
      }
    };
    const select = async (title, options) => {
      assertCurrent();
      const value = await ctx.ui.select(title, options);
      assertCurrent();
      if (value === undefined) return;
      if (!options.some(option => option.label === value)) throw new Error("목록에 없는 항목은 선택할 수 없습니다.");
      return value;
    };
    if (!role) {
      const mode = await select("Strataa Models — 이 호스트의 다음 실행부터 적용", [
        { label: "전체 역할에 같은 모델", description: "Router · Brain · Worker · Reviewer · Solo · 요약 · Dashboard 분석" },
        { label: "역할별 모델 선택", description: "전체 모델 목록과 지원 추론 강도에서 역할별 선택" },
        { label: "추천 기본 조합 복원", description: "Terra · Fable · Opus · Astra · Luna — 기존 기본 조합" },
      ]);
      if (mode === undefined) return false;
      if (mode === "추천 기본 조합 복원") { await saveModels(DEFAULT_MODELS, ctx); return true; }
      if (mode === "역할별 모델 선택") {
        const chosen = await select("변경할 역할", MODEL_ROLES.map(key => ({
          label: ROLE_LABELS[key], description: `${previous[key].model} · ${previous[key].reasoning}`,
        })));
        if (chosen === undefined) return false;
        role = MODEL_ROLES.find(key => ROLE_LABELS[key] === chosen);
      } else role = "all";
    }
    const current = previous[role === "all" ? "solo" : role];
    const options = ctx.models.list().map(model => {
      const selector = `${model.provider}/${model.id}`;
      return { label: selector, description: `${model.name || model.id}${selector === current.model ? " · 현재 선택" : ""}` };
    }).sort((a, b) => Number(b.label === current.model) - Number(a.label === current.model) || a.label.localeCompare(b.label));
    if (!options.length) throw new Error("선택 가능한 모델이 없습니다. /login을 확인하세요.");
    const model = await select(`${role === "all" ? "전체 역할" : ROLE_LABELS[role]} 모델 — 전체 목록`, options);
    if (model === undefined) return false;
    const metadata = ctx.models.list().find(item => `${item.provider}/${item.id}` === model);
    if (!metadata) throw new Error("선택한 모델이 더 이상 제공되지 않습니다.");
    const reasoning = await select("추론 강도 — auto는 모델 기본값, 명시 강도는 자동 하향하지 않음",
      supportedReasoning(metadata).map(level => ({ label: level, description: level === "auto" ? "모델 기본값" : `${level}${model === current.model && level === current.reasoning ? " · 현재 선택" : ""}` })));
    if (reasoning === undefined) return false;
    validateModelChoice(ctx.models.list(), { model, reasoning });
    await saveModels(role === "all" ? uniformModelConfig(model, reasoning) : { ...previous, [role]: { model, reasoning } }, ctx);
    return true;
  }

  async function dispatch(run, decision) {
    const { route } = decision;
    const aris = ARIS_ROUTES.includes(route);
    const operation = handoffTail.then(async () => {
      if (!owns(run)) return;
      if (!run.ctx.isIdle()) throw new Error("다른 작업이 시작되어 실행을 보류했습니다. 완료 후 요청을 다시 입력하세요.");
      if (aris) {
        const { problem } = arisReadiness(pi, run.ctx, run.config, validateArisInstall);
        if (problem) throw new Error(problem);
      }
      const role = aris ? "brain" : "solo";
      const taskLabel = aris ? `Brain · ${decision.skills.join(", ")}` : decision.waves.length ? "Wave 조정" : "단독 처리";
      const model = assertModel(run.ctx, run.config, role);
      run.flow.note = `${ROLE_LABELS[role]} ${taskLabel} 준비 중`;
      paint(run);
      if (!await pi.setModel(model)) throw new Error(`${ROLE_LABELS[role]} 실행 모델로 전환하지 못했습니다.`);
      if (!owns(run)) return;
      const current = run.ctx.models.current();
      if (!run.ctx.isIdle() || current?.provider !== model.provider || current?.id !== model.id) {
        throw new Error("실행 상태 또는 모델이 변경되어 요청을 전달하지 않았습니다.");
      }
      pi.setThinkingLevel(run.config[role].reasoning);
      // The full selected SKILL.md bodies are already loaded in run.aris: the handoff precedes the prompt.
      pi.sendMessage({
        customType: CARD, display: false,
        content: `${aris ? arisHandoff(run.aris, AGENTS_DIR)
          : `Router가 이 요청을 Solo 주도 일반 작업으로 분류했습니다. ARIS 스킬은 필요하지 않습니다. 원본 근거와 제약을 확인하고 필요한 최소 작업을 직접 수행·검증하세요. 위임 작업은 사용자가 설정한 Worker ${run.config.worker.model} · ${run.config.worker.reasoning}로 실행됩니다. 다른 모델·외부 에이전트로 우회하지 마세요. 관측과 추론, 검증하지 못한 부분을 구분하세요.`}${pstackHandoff(aris ? "brain" : "solo")}\n\n${waveHandoff(decision.waves)}${projectHandoff(run.ctx.cwd)}`,
        details: { runId: run.id, phase: "handoff", ...decision, speaker: role, ...run.config[role],
          ...(aris ? { worker: { agent: WORKER_AGENT, ...run.config.worker }, reviewer: { agent: REVIEWER_AGENT, ...run.config.reviewer }, install: run.aris.install, reviewRequired: run.aris.reviewRequired } : {}) },
      }, { triggerTurn: false, deliverAs: "nextTurn" });
      execution = { sessionId: run.sessionId, role, run };
      run.paint = save => paint(run, save);
      run.consume = (details, sourceCtx) => consumeResults(run, details, sourceCtx);
      run.evidence = content => pi.sendMessage({
        customType: CARD, display: false, content, details: { runId: run.id, phase: "evidence" },
      }, { triggerTurn: false, deliverAs: "nextTurn" });
      observedRuns.add(run);
      startExecution(run.flow);
      run.flow.note = "공개 실행 기록 · native 작업 카드는 실행 결과 원문 · Esc 중단";
      paint(run, true);
      run.ctx.ui.setStatus(CARD, `Strataa AUTO · ${ROLE_LABELS[role]} ${taskLabel}`);
      // Programmatic prompts bypass the external input hook: no routing recursion.
      pi.sendUserMessage([{ type: "text", text: run.text }, ...run.images]);
      active = undefined;
    });
    handoffTail = operation.catch(() => {});
    await operation;
  }

  async function perform(run) {
    const args = {
      prompt: run.text, images: run.images, context: run.context, cwd: run.ctx.cwd,
      signal: run.controller.signal, runTurn: options => runModelTurn(run.ctx, options), config: run.config,
    };
    try {
      await modelSettings.approve(run.config, run.ctx);
      if (!owns(run)) return;
      run.ctx.ui.setStatus(CARD, `Strataa AUTO · Router ${run.config.router.model} · ${run.config.router.reasoning}`);
      paint(run, true);
      const decision = await routeRequest({ ...args, catalog: getArisCatalog() });
      if (!owns(run)) return;
      if (ARIS_ROUTES.includes(decision.route)) {
        // Full SKILL.md bodies are loaded now, before any handoff or prompt; a missing file fails the run here.
        run.aris = createArisRun(run.id, decision, run.config, loadArisSkills(decision.skills), validateArisInstall());
        if (run.aris.reviewRequired && !decision.waves.length) throw new Error("선택한 스킬은 독립 검토가 필요하지만 Terra의 실행 Wave 계획이 비어 있습니다.");
      }
      planFlow(run.flow, decision, run.config, { reviewRequired: run.aris?.reviewRequired });
      paint(run, true);
      card(`**Router → ${routeTitle(decision)}**\n\n${decision.reason}\n\n${decision.waves.length ? decision.waves.map(stage => `Wave ${stage.wave} · ${stage.title} · 선행 ${stage.dependsOn.join(", ") || "없음"} · 동시 최대 ${stage.parallel}`).join("\n") : "위임 Wave 없음 · 메인 직접 처리"}`, {
        runId: run.id, phase: "route", ...decision, ...run.config.router,
      });
      if (owns(run)) await dispatch(run, decision);
    } catch (error) {
      if (!owns(run)) return;
      active = undefined;
      run.controller.abort(error);
      endFlow(run, "failed", error instanceof Error ? error.message : String(error));
      status(run.ctx);
      card(`**라우팅·준비 실패 — 자동 실행하지 않음**\n\n${error instanceof Error ? error.message : String(error)}\n\n설정을 확인한 후 요청을 다시 입력하세요.`, { runId: run.id, phase: "error" });
    }
  }

  function restore(_event, ctx) {
    flowGeneration++;
    abortSummary("세션 이동으로 요청 요약을 중단했습니다.");
    observedContext = ctx;
    closeExplorer();
    closeWatcher();
    cancel("세션이 변경되었습니다.", false);
    interruptExecution("세션이 변경되어 이전 실행의 추적을 종료했습니다.");
    unsubscribe?.();
    unsubscribe = undefined;
    if (!isMain(ctx)) return;
    revision++;
    state = restoredState(ctx.sessionManager.getBranch());
    try { refreshModels(); }
    catch (error) { state.enabled = false; ctx.ui.notify(error.message, "error"); }
    status(ctx);
    const flow = restoreFlow(ctx.sessionManager.getBranch());
    if (flow?.promptSummary?.status === "running") {
      flow.promptSummary = { status: "failed", model: flow.promptSummary.model,
        error: "이전 실행의 요청 요약이 완료되지 않았습니다. 세션 복원은 요약을 다시 호출하지 않습니다." };
    }
    displayedRun = undefined;
    ctx.ui.setWidget(FLOW, undefined);
    if (flow) paint({ flow, ctx, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile?.() });
    else publish(ctx, null);
    if (ctx.mode === "tui") {
      unsubscribe = ctx.ui.onTerminalInput(data => {
        if (active && !explorer && !watcher && ["\x1b", "\x03", "\x1b[27u", "\x1b[27;1u"].includes(data)) {
          cancel("사용자가 중단했습니다.");
          return { consume: true };
        }
      });
    }
  }

  pi.on("session_start", restore);
  pi.on("session_switch", restore);
  pi.on("session_branch", restore);
  pi.on("session_tree", restore);
  for (const name of ["session_before_switch", "session_before_branch", "session_before_tree"]) {
    pi.on(name, async () => {
      flowGeneration++;
      abortSummary("세션 이동으로 요청 요약을 중단했습니다.");
      closeExplorer();
      closeWatcher();
      revision++;
      cancel("세션 이동으로 중단했습니다.");
      interruptExecution("세션 이동으로 추적 종료. 미완료 단계는 성공으로 표시하지 않습니다.");
      await handoffTail;
    });
  }
  pi.on("session_before_compact", async () => {
    revision++;
    cancel("문맥 압축으로 라우팅·자문을 중단했습니다.");
    // Compaction rewrites history in place; native jobs and their frozen packet
    // still belong to this session. Navigation/shutdown invalidate them separately.
    await handoffTail;
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    flowGeneration++;
    if (isMain(ctx)) monitorStopped = true;
    abortSummary("세션 종료로 요청 요약을 중단했습니다.");
    for (const dispose of observationSubscriptions.splice(0)) dispose();
    observedContext = undefined;
    observationOwner = undefined;
    observationIdentity = undefined;
    closeExplorer();
    closeWatcher();
    revision++;
    cancel("세션을 종료했습니다.", false);
    interruptExecution("세션이 종료되었습니다. 실행 중이던 단계의 완료를 확인하지 못했습니다.");
    unsubscribe?.();
    await handoffTail;
    if (isMain(ctx)) {
      try { monitor.publisher?.close(); }
      catch (error) { monitorFailure(ctx, error); }
    }
  });
  pi.on("agent_end", (event, ctx) => {
    if (!isMain(ctx) || !execution || execution.sessionId !== ctx.sessionManager.getSessionId()) return;
    if (event.willContinue || event.awaitingAsyncWork) return;
    const run = execution.run;
    const last = [...(event.messages ?? [])].reverse().find(message => message.role === "assistant");
    const reason = last?.stopReason ?? run.lastStopReason;
    const result = reason === "aborted" ? "cancelled" : ["error", "length"].includes(reason) ? "failed"
      : reason === "stop" ? "completed" : "incomplete";
    // finishFlow downgrades "completed" when a reviewer round failed validation or a required round never completed.
    endFlow(run, result, result === "failed" ? "최종 모델 호출이 정상 완료되지 않았습니다." : undefined);
    execution = undefined;
    status(ctx);
  });

  const executing = ctx => isMain(ctx) && execution?.sessionId === ctx.sessionManager.getSessionId()
    && execution.run.flow.status === "running" ? execution.run : undefined;

  function tracking(ctx) {
    const root = executing(ctx);
    if (root || isMain(ctx)) return root;
    if (observationOwner) return observedRuns.has(observationOwner) &&
      observationOwner.flow.status === "running" && !observationOwner.controller.signal.aborted &&
      observationOwner.ctx.sessionManager.getSessionId() === observationOwner.sessionId &&
      ctx.sessionManager.getSessionId() === observationIdentity.sessionId &&
      ctx.agent?.id === observationIdentity.id && ctx.agent?.parentId === observationIdentity.parentId
      ? observationOwner : undefined;
    if (!ctx.agent?.id || !ctx.agent.parentId) return;
    for (const run of observedRuns) {
      const parent = run.agentParents.get(ctx.agent.id);
      if (!parent || parent.identity !== ctx.agent.parentId) continue;
      const file = ctx.sessionManager.getSessionFile?.();
      if (parent.sessionFile && file && parent.sessionFile !== file) continue;
      observationOwner = run;
      observationIdentity = { sessionId: ctx.sessionManager.getSessionId(), id: ctx.agent.id, parentId: ctx.agent.parentId };
      return run;
    }
  }
  const callKey = (ctx, id) => `${ctx.sessionManager.getSessionId()}:${id}`;
  const parentRow = (run, ctx) => isMain(ctx) ? "final"
    : run.flow.rows.find(row => row.jobIds.includes(ctx.agent.id))?.id;
  const knownJob = (run, id) => run.flow.rows.find(row => row.jobIds.includes(id));

  function scopedDetails(run, ctx, details, call) {
    if (!isRecord(details)) return details;
    const scope = item => {
      if (!isRecord(item) || typeof item.id !== "string" || (item.type && item.type !== "task")) return;
      const known = knownJob(run, item.id);
      const canSpawn = call && ["task", "eval"].includes(call.toolName);
      if (!known && (!canSpawn || !call.parentId)) return;
      if (known && call && canSpawn && known.parentId !== call.parentId) return;
      const task = call?.tasks?.find(task => task?.name === item.id) ??
        (call?.tasks?.length === 1 ? call.tasks[0] : undefined);
      const agent = item.agent || task?.agent ||
        (known ? known.review ? REVIEWER_AGENT : known.worker ? WORKER_AGENT : known.agent : canSpawn ? "task" : undefined);
      const result = { ...item, ...(agent ? { agent } : {}), parentId: known?.parentId ?? call?.parentId };
      if (!result.task && task) result.task = [publicText(task.context), publicText(task.task)].filter(Boolean).join("\n\n");
      if (canSpawn && (!known || item.sessionFile)) run.agentParents.set(item.id, {
        identity: ctx.agent?.id, sessionFile: item.sessionFile,
      });
      return result;
    };
    const result = { ...details };
    for (const key of ["progress", "results", "jobs"]) {
      if (Array.isArray(details[key])) result[key] = details[key].map(scope).filter(Boolean);
    }
    if (isRecord(details.evalResult)) result.evalResult = scope(details.evalResult);
    return result;
  }

  pi.on("message_end", async (event, ctx) => {
    const run = tracking(ctx);
    const message = event.message;
    if (!run) return;
    if (message?.role === "custom" && message.customType === "async-result") {
      // Auto-delivery is not a tool_result. Bind typed job IDs to this run and use only
      // previously observed native model metadata, never the delivery's prose.
      const results = [];
      const bodies = [];
      const deliveredText = typeof message.content === "string" ? message.content
        : (message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
      for (const delivery of Array.isArray(message.details?.jobs) ? message.details.jobs : []) {
        if (delivery.type !== "task" || typeof delivery.jobId !== "string") continue;
        const row = run.flow.rows.find(candidate => candidate.jobIds.includes(delivery.jobId));
        if (!row) continue;
        const job = row.jobs.find(candidate => candidate.id === delivery.jobId);
        if (!job || job.resultReceived || job.state === "cancelled") continue;
        const item = { id: delivery.jobId, type: "task", status: delivery.status, resolvedModelIdentity: job.model,
          resolvedThinkingLevel: job.thinkingLevel };
        if (delivery.status === "completed") {
          try {
            if (delivery.agentId && delivery.agentId !== delivery.jobId) throw new Error("전달된 agent ID가 관측한 작업 ID와 다릅니다");
            item.output = await readAgentOutput(delivery.jobId, ctx);
            if ((row.review || row.worker) && item.output.trim() && !deliveredText.includes(escapeHarnessTags(item.output.trim()))) {
              bodies.push({ type: "text", text: `${row.review ? "검토" : "작업"} 전문 (job ${delivery.jobId})\n${escapeHarnessTags(item.output)}` });
            }
          } catch (error) { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); }
        }
        if (tracking(ctx) !== run) return;
        results.push(item);
      }
      if (!results.length) return;
      const processed = await run.consume({ results }, ctx);
      if (processed && (processed.added.length || bodies.length)) run.evidence(
        [...bodies, ...processed.added].map(block => block.text).join("\n\n"));
      return;
    }
    if (!isMain(ctx) || message?.role !== "assistant") return;
    run.lastStopReason = message.stopReason;
    if (publicText(message.content)) updateStage(run.flow, "final", "running", message.content);
    paint(run, true);
  });

  pi.on("tool_call", (event, ctx) => {
    const run = tracking(ctx);
    if (!run || event.toolName !== "task") return;
    if (!isMain(ctx)) return { block: true, reason: "Terra 실행 Wave는 메인 세션이 직접 조정합니다. 자식은 재위임할 수 없습니다." };
    try {
      const prepared = prepareWaveCall(run.flow, event.input);
      if (run.aris) prepared.input = prepareArisCall(run.aris, prepared.input, prepared.bindings);
      const tasks = prepared.input.tasks ?? [prepared.input];
      const workerGuidance = run.aris && tasks.some(task => task.agent === WORKER_AGENT) ? pstackHandoff("worker") : "";
      for (const task of tasks) {
        const role = task.agent === REVIEWER_AGENT ? "reviewer" : "worker";
        assertModel(ctx, run.config, role);
        task.model = taskModelSelector(run.config[role]);
        if (run.aris && task.agent === WORKER_AGENT) task.task += workerGuidance;
      }
      run.flow.nextWaveTask = prepared.nextName;
      // Validate the whole batch before reserving any stage or name.
      tasks.forEach((task, index) => {
        expectNative(run.flow, task.agent || "task", task.name, {
          ...task, waveId: prepared.bindings[index].waveId, context: prepared.input.context, parentId: "final",
        });
      });
      run.paint(true);
      return { input: prepared.input };
    }
    catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
  });
  pi.on("before_subagent_spawn", (event, ctx) => {
    const run = tracking(ctx);
    if (run && (!isMain(ctx) || event.invocationKind !== "task")) return {
      block: true, reason: "Terra Wave의 위임은 메인 세션의 native task만 사용합니다. 재귀·eval·외부 대체 실행은 허용되지 않습니다.",
    };
    if (!run) return;
    const policy = run.aris ? arisSpawnPolicy(run.aris, event) : undefined;
    if (policy?.block) return policy;
    const role = event.agent === REVIEWER_AGENT ? "reviewer" : "worker";
    try { assertModel(ctx, run.config, role); }
    catch (error) { return { block: true, reason: error.message }; }
    return policy ?? { model: taskModelSelector(run.config[role]) };
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const run = tracking(ctx);
    if (!run) return;
    const parentId = parentRow(run, ctx);
    if (!parentId) return;
    const tasks = event.toolName === "task" ? event.args?.tasks ?? [event.args] : [];
    let changed = false;
    const ids = [];
    for (const task of tasks) {
      if (!task || typeof task.name !== "string" || !task.name) continue;
      const agent = typeof task.agent === "string" && task.agent ? task.agent : "task";
      changed = expectNative(run.flow, agent, task.name, { ...task, context: event.args?.context, parentId }) || changed;
      const row = knownJob(run, task.name);
      if (row) {
        ids.push(row.id);
        run.agentParents.set(task.name, { identity: ctx.agent?.id });
      }
    }
    run.toolCalls.set(callKey(ctx, event.toolCallId), {
      ids, parentId, tasks: tasks.map(task => ({ ...task, context: event.args?.context })), toolName: event.toolName,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    if (changed) run.paint(true);
  });

  const nativeItems = details => [
    ...(Array.isArray(details?.results) ? details.results : []),
    ...(Array.isArray(details?.jobs) ? details.jobs : []),
    ...(details?.evalResult && typeof details.evalResult === "object" ? [details.evalResult] : []),
  ];

  function nativeUpdate(event, ctx, result, ended) {
    const run = tracking(ctx);
    const call = run?.toolCalls.get(callKey(ctx, event.toolCallId));
    if (!call) return;
    let changed = observeNative(run.flow, { ...result, details: scopedDetails(run, ctx, result?.details, call) });
    if (ended && event.isError) {
      const error = publicText(result?.content) || "native 호출 실패";
      for (const id of call.ids) changed = updateStage(run.flow, id, "failed", error) || changed;
    }
    if (changed && (ended || Date.now() - run.lastPaint >= 100)) run.paint(ended);
  }
  pi.on("tool_execution_update", (event, ctx) => nativeUpdate(event, ctx, event.partialResult, false));
  pi.on("tool_execution_end", (event, ctx) => nativeUpdate(event, ctx, event.result, true));

  for (const channel of ["task:subagent:progress", "task:subagent:lifecycle", "task:subagent:event"]) {
    const dispose = pi.events?.on(channel, payload => {
      const ctx = observedContext;
      const run = ctx && tracking(ctx);
      if (!run || !isRecord(payload)) return;
      if (channel === "task:subagent:event") {
        const row = knownJob(run, payload.id);
        if (!row || row.parentId !== parentRow(run, ctx)) return;
        const event = payload.event;
        if (!["message_update", "message_end"].includes(event?.type) || event.message?.role !== "assistant") return;
        const text = publicText(event.message.content);
        if (!text) return;
        const output = run.publicOutputs.get(payload.id) ?? { completed: [], current: "" };
        if (event.type === "message_end") { output.completed.push(text); output.current = ""; }
        else output.current = text;
        run.publicOutputs.set(payload.id, output);
        if (observeNative(run.flow, { details: { progress: [{
          id: payload.id, status: "running", publicOutput: [...output.completed, output.current].filter(Boolean).join("\n\n"),
        }] } })) {
          if (event.type === "message_end") run.paint(true);
          else if (Date.now() - run.lastPaint >= 100) run.paint(false);
        }
        return;
      }
      let call = run.toolCalls.get(callKey(ctx, payload.parentToolCallId));
      const id = channel === "task:subagent:progress" ? payload.progress?.id : payload.id;
      const known = knownJob(run, id);
      if (!call && !payload.parentToolCallId && known?.parentId === parentRow(run, ctx) &&
        run.agentParents.get(id)?.identity === ctx.agent?.id) {
        call = { toolName: "eval", parentId: known.parentId, tasks: [] };
      }
      if (!call || !["task", "eval"].includes(call.toolName)) return;
      const item = channel === "task:subagent:progress"
        ? { ...payload.progress, agent: payload.agent, task: payload.task, sessionFile: payload.sessionFile }
        : { id: payload.id, agent: payload.agent, status: payload.status === "started" ? "running" : payload.status,
          sessionFile: payload.sessionFile };
      const details = scopedDetails(run, ctx, { progress: [item] }, call);
      if (observeNative(run.flow, { details }) &&
        (channel === "task:subagent:lifecycle" || Date.now() - run.lastPaint >= 100)) {
        run.paint(channel === "task:subagent:lifecycle");
      }
    });
    if (dispose) observationSubscriptions.push(dispose);
  }
  /**
   * Detached reviewer envelopes that only preview the output are replaced by the published
   * `agent://<id>` document. Returns the rewritten details and the items that gained a full body.
   */
  async function hydrateDetails(run, details, sourceCtx) {
    const filled = [];
    const hydrate = async item => {
      const row = isRecord(item) && knownJob(run, item.id);
      const job = row?.jobs.find(candidate => candidate.id === item.id);
      if (!row || job?.resultReceived || job?.state === "cancelled") return item;
      // Rejected owned-model evidence is final; never read or publish its preview body.
      if ((row.review || row.worker) && job?.state === "failed") return item;
      if (row.review) {
        const result = await hydrateReview(item, id => readAgentOutput(id, sourceCtx));
        if (result !== item && typeof result.output === "string") filled.push(result);
        return result;
      }
      const reference = nativeReference(item);
      if (!reference && !item.truncated) return item;
      try {
        const output = publicText(await readAgentOutput(item.id, sourceCtx));
        if (!output.trim()) throw new Error("공개 출력이 비어 있습니다.");
        if (reference && !escapeHarnessTags(output).trimStart().startsWith(reference.preview.trim())) {
          throw new Error("공개 출력이 결과 미리보기와 일치하지 않습니다.");
        }
        return { ...item, output, truncated: false };
      } catch (error) {
        return { ...item, status: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    };
    if (!isRecord(details)) return { details, filled };
    const hydrated = { ...details };
    if (Array.isArray(details.results)) hydrated.results = await Promise.all(details.results.map(hydrate));
    if (Array.isArray(details.jobs)) hydrated.jobs = await Promise.all(details.jobs.map(hydrate));
    if (isRecord(details.evalResult)) hydrated.evalResult = await hydrate(details.evalResult);
    return { details: hydrated, filled };
  }

  async function consumeResults(run, incoming, sourceCtx = run.ctx) {
    if (observeNative(run.flow, { details: incoming })) paint(run, true);
    const { details, filled } = await hydrateDetails(run, incoming, sourceCtx);
    // The read yielded: a stop, session move or new request may have ended this run meanwhile.
    if (executing(run.ctx) !== run) return;
    if (observeNative(run.flow, { details })) paint(run, true);
    // Tell the Brain, once per owned job, whether it counts; silence or failure is never acceptance.
    const notes = [];
    for (const item of nativeItems(details)) {
      const worker = run.flow.rows.find(candidate => candidate.worker === true && candidate.jobIds.includes(item?.id));
      if (worker && !run.workerNotes.has(item.id)) {
        const job = worker.jobs.find(candidate => candidate.id === item.id);
        if (job && !["pending", "running"].includes(job.state)) {
          run.workerNotes.add(item.id);
          if (job.state !== "completed") notes.push(`WORKER_UNAVAILABLE (job ${item.id}): ${worker.summary || job.state}. 이 작업을 완료했다고 주장하지 말고 미완료 범위를 최종 답변에 명시하세요.`);
        }
      }
      const row = run.flow.rows.find(candidate => candidate.review === true && candidate.jobIds.includes(item?.id));
      if (!row || run.reviewNotes.has(item.id)) continue;
      const job = row.jobs.find(candidate => candidate.id === item.id);
      if (!job || ["pending", "running"].includes(job.state)) continue;
      run.reviewNotes.add(item.id);
      const problem = job.state === "completed" ? undefined : (row.summary || reviewProblem(run.flow, item));
      if (!problem && recordReview(run.aris, item, row.model, row.waveId)) {
        const round = run.aris.reviews.filter(review => review.waveId === row.waveId).length;
        notes.push(`${row.waveId} 검토 라운드 ${round} 인정 (job ${item.id}, 모델 ${row.model}). 검토자의 지적은 자동 승인이 아닙니다: 각 지적에 근거로 응답하고, 후속 라운드는 같은 단계에서 다시 agent "${REVIEWER_AGENT}" task로 호출하세요. 그 단계의 이전 라운드 원문만 확장이 자동으로 덧붙입니다.`);
      } else {
        notes.push(`REVIEW_UNAVAILABLE (job ${item.id}): ${problem || "검토 결과를 인정할 수 없음"}. 이 라운드는 검토로 인정되지 않으며 자동 재시도하지 않습니다. 최종 답변에 검토 미완료를 명시하세요.`);
      }
    }
    // The executor saw only the preview: hand it the whole published output once, with this result.
    const bodies = filled.map(item => `검토 전문 (job ${item.id}, agent://${item.id}) — 아래가 검토자 공개 출력 전체입니다:\n${escapeHarnessTags(item.output)}`);
    const added = [...bodies, ...(notes.length ? [notes.join("\n")] : [])].map(text => ({ type: "text", text }));
    return { added, details };
  }

  pi.on("tool_result", async (event, ctx) => {
    const run = tracking(ctx);
    const call = run?.toolCalls.get(callKey(ctx, event.toolCallId));
    if (!call) return;
    nativeUpdate(event, ctx, { content: event.content, details: event.details }, true);
    const details = scopedDetails(run, ctx, event.details, call);
    const processed = await run.consume(details, ctx);
    if (!processed?.added.length) return;
    return { content: [...(event.content ?? []), ...processed.added], details: processed.details };
  });

  // Cancelled/failed runs stay visible, but never become execution advice.
  pi.on("context", event => {
    const completed = new Set(event.messages
      .filter(message => message.customType === CARD && message.details?.phase === "handoff")
      .map(message => message.details.runId));
    return { messages: event.messages.filter(message => message.customType !== CARD ||
      (completed.has(message.details?.runId) && ["handoff", "evidence"].includes(message.details?.phase))) };
  });

  pi.on("input", (event, ctx) => {
    if (!isMain(ctx) || !state.enabled || event.source === "extension" || event.text.trimStart().startsWith("/")) return;
    if (!event.text.trim() && !event.images?.length) return;
    // Native steering/queued follow-ups retain their semantics during execution.
    if (!ctx.isIdle() && !active) {
      ctx.ui.notify("실행 중 입력은 기존 omp로 전달합니다. 대화 모드는 대기 상태의 새 요청에 적용됩니다.", "info");
      return;
    }
    cancel("새 요청으로 대체되었습니다.");
    closeExplorer();
    interruptExecution("새 요청으로 이전 실행 화면의 추적을 종료했습니다.");
    abortSummary("새 요청으로 이전 요청 요약을 중단했습니다.");
    try {
      refreshModels();
      assertModel(ctx, state.models, "router");
      assertModel(ctx, state.models, "solo");
      validateArisInstall();
    } catch (error) {
      card(`**라우팅 준비 확인 필요 — 실행하지 않음**\n\n${error.message}`, { phase: "error" });
      ctx.ui.setEditorText(event.text);
      return { handled: true };
    }
    const run = {
      id: randomUUID(), ctx, controller: new AbortController(),
      sessionId: ctx.sessionManager.getSessionId(),
      flowGeneration,
      sessionFile: ctx.sessionManager.getSessionFile?.(),
      text: event.text, images: [...(event.images ?? [])],
      context: collectContext(ctx.sessionManager.getBranch()),
      config: state.models, lastPaint: 0, toolCalls: new Map(), reviewNotes: new Set(), workerNotes: new Set(),
      agentParents: new Map(), publicOutputs: new Map(),
    };
    run.flow = createFlow(run.id, run.text, run.config);
    if (monitor.summarizePrompt) run.flow.promptSummary = { status: "running", model: run.config.summary.model };
    active = run;
    paint(run, true);
    card(`**자동 라우팅 요청**\n\n${event.text}\n\nRouter ${run.config.router.model} · ${run.config.router.reasoning} → Solo / ARIS 검토 / ARIS 연구 · /strataa stop 또는 Esc로 중단`, { runId: run.id, phase: "request" });
    if (monitor.summarizePrompt) void summarizePrompt(run);
    // Input hooks have a 30s host budget. Return immediately; manage lifetime
    // ourselves instead of allowing timeout to dispatch the task prematurely.
    ctx.setTimeout(() => perform(run), 0);
    return { handled: true };
  });

  const installSummary = () => {
    try { const install = validateArisInstall(); return `ARIS: ${install.count}개 스킬 · commit ${String(install.commit).slice(0, 12)} · ${install.root}`; }
    catch (error) { return `ARIS 설치 문제: ${error instanceof Error ? error.message : String(error)}`; }
  };
  const describe = () => `**Strataa ${state.enabled ? "AUTO (ON)" : "OFF"}**\n\n${MODEL_ROLES.map(role => `${ROLE_LABELS[role]}: \`${state.models[role].model}\` · ${state.models[role].reasoning}`).join("\n")}\n\n같은 모델을 사용해도 검토 세션은 별도이며, 별도 세션은 교차 모델 검증을 보장하지 않습니다.\nWorker: \`${WORKER_AGENT}\` · 검토자: \`${REVIEWER_AGENT}\` · ${installSummary()} · /strataa skills`;

  pi.registerCommand("strataa", {
    description: "설정한 모델로 자동 라우팅 · 연구 · 실행 · 별도 세션 검토",
    getArgumentCompletions(prefix) {
      return ["models", "skills", "pstack", "flow", "watch", "on", "off", "status", "stop", ...MODEL_ROLES, "help"]
        .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
    },
    async handler(args, ctx) {
      if (!isMain(ctx)) return;
      const [action = state.enabled ? "off" : "on", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (["models", "skills", "status", "on", ...MODEL_ROLES].includes(action) && !(action === "models" && rest[0] === "default")) {
        try { refreshModels(); }
        catch (error) { ctx.ui.notify(error.message, "error"); return; }
      }
      if (action === "help") { card(HELP, { phase: "status" }); return; }
      if (action === "stop") {
        cancel("/strataa stop");
        await handoffTail;
        if (execution?.sessionId === ctx.sessionManager.getSessionId()) {
          const run = execution.run;
          endFlow(run, "cancelled", "사용자가 /strataa stop으로 중단했습니다.");
          execution = undefined;
          if (!ctx.isIdle()) await ctx.abort();
        }
        return;
      }
      if (action === "status") {
        card(`${describe()}\n\n${active ? "라우팅·검토 진행 중" : execution ? `${ROLE_LABELS[execution.role]} 응답 진행 중` : "대기 중"}\n\n${HELP}`, { phase: "status" });
        return;
      }
      if (action === "watch") {
        await showWatch(ctx);
        return;
      }
      if (action === "flow") {
        await showFlow(ctx);
        return;
      }
      if (action === "pstack") {
        try {
          const install = validatePstackInstall();
          const catalog = getPstackCatalog();
          card(`**pstack ${install.count}개 스킬 · ${install.agents}개 에이전트**\n\nv${install.version} · commit ${install.commit}\n${install.root}\n\n${catalog.map(skill => `- \`/${skill.name}\``).join("\n")}\n\nSolo·ARIS Brain·Worker가 필요한 pstack 스킬만 선택합니다. 탐색과 문장 정리는 직접 진행하며, 의미 있는 주장 변경·비용·되돌리기 어려운 행동에 필요한 검사를 붙입니다. 사용자가 요청한 검토와 선택한 ARIS 절차는 유지합니다. Reviewer의 독립성과 기존 모델 설정은 바꾸지 않습니다. Cursor 전용 서비스·원본 helper 의존성은 자동 실행·설치하지 않습니다.`,
            { phase: "status", pstack: install, skills: catalog.map(skill => skill.name) });
        } catch (error) { ctx.ui.notify(error.message, "error"); }
        return;
      }
      if (action === "skills") {
        const { install, problem } = arisReadiness(pi, ctx, state.models, validateArisInstall);
        let catalog = [];
        if (install) {
          try { catalog = getArisCatalog(); }
          catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); return; }
        }
        card(`**ARIS 스킬 ${catalog.length}개 — ${problem ? `실행 불가: ${problem}` : "실행 준비 완료"}**\n\n${installSummary()}\n${["brain", "worker", "reviewer"].map(role => `${ROLE_LABELS[role]}: ${state.models[role].model} · ${state.models[role].reasoning}`).join("\n")}\n\n${catalog.map(skill =>
          `- \`${skill.name}\`${skill.name === DEFAULT_REVIEW_SKILL ? " (검토 기본값)" : ""} — ${String(skill.description ?? "").replace(/\s+/g, " ").trim()}`
        ).join("\n")}\n\nRouter는 필요한 스킬 1–4개만 선택합니다. Brain은 분석·계획·최종 종합, Worker는 구체 실행, Reviewer는 별도 읽기 전용 세션 검토를 맡습니다. 모델과 공개 출력이 확인된 라운드만 검토로 인정하며, 같은 모델의 별도 세션은 교차 모델 검증이 아닙니다. 스킬 선택은 실행 권한을 추가하지 않습니다.`,
        { phase: "status", skills: catalog.map(skill => skill.name), available: !problem, problem, install });
        return;
      }
      if ((action === "models" || MODEL_ROLES.includes(action)) && tracking(ctx)?.flow.status === "running") {
        ctx.ui.notify("실행 중인 작업의 모델 승인을 유지합니다. 작업 완료 후 모델을 변경하세요.", "warning");
        return;
      }
      if (active && action !== "off") {
        ctx.ui.notify("먼저 /strataa stop으로 현재 라우팅·검토를 중단하세요.", "warning");
        return;
      }
      try {
        if (action === "on" || action === "off") {
          if (rest.length) throw new Error(HELP);
          if (action === "on") {
            assertModel(ctx, state.models, "router");
            assertModel(ctx, state.models, "solo");
            validateArisInstall();
            validatePstackInstall();
            await modelSettings.approve(state.models, ctx);
          } else cancel("대화 모드를 껐습니다.");
          state.enabled = action === "on";
        } else if (action === "models") {
          if (!rest.length) { if (!await pickModels(ctx)) return; }
          else if (rest.length === 1 && rest[0] === "default") await saveModels(DEFAULT_MODELS, ctx);
          else if (rest[0] === "all" && rest.length >= 2 && rest.length <= 3) {
            const models = uniformModelConfig(rest[1], rest[2] || "auto");
            validateModelChoice(ctx.models.list(), models.solo);
            await saveModels(models, ctx);
          } else throw new Error("/strataa models · models all <provider/model> [effort] · models default");
        } else if (MODEL_ROLES.includes(action)) {
          if (!rest.length) { if (!await pickModels(ctx, action)) return; }
          else {
            if (rest.length > 2) throw new Error(`/strataa ${action} [provider/model] [effort]`);
            const models = normalizeModelConfig({ ...state.models, [action]: { model: rest[0], reasoning: rest[1] || "auto" } });
            assertModel(ctx, models, action);
            await saveModels(models, ctx);
          }
        } else throw new Error(HELP);
        persist(ctx);
        card(`${describe()}\n\n${state.enabled ? "다음 요청부터 이 설정으로 라우팅·실행합니다. 진행 중인 실행은 시작할 때의 모델 설정을 유지합니다. 추가 모델 사용량이 발생하며 /strataa off로 자동 라우팅을 해제합니다." : "자동 라우팅은 OFF입니다. 모델 설정은 같은 호스트의 Strataa와 Dashboard에 저장되며 /strataa on으로 라우팅을 켭니다. 현재 OMP 모델은 유지합니다."}`, { phase: "status" });
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
