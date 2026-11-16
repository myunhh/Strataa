// Read-only local dashboard: only the producer owns snapshot files and model calls.
import { theme as liveTheme, matchesKey, truncateToWidth } from "@oh-my-pi/pi-tui";
import { createFlowView } from "./flow-view.js";
import { readFlowSessions } from "./flow-store.js";
import { discoverSessionFiles } from "./live-hosts.js";
import { createSavedFlowReader } from "./saved-flow.js";

const CONTROL_RE = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;
const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[@-Z\\-_])/g;
const STATES = {
  running: ["●", "accent", "실행"], completed: ["●", "success", "완료"],
  failed: ["!", "error", "실패"], cancelled: ["■", "warning", "취소"],
  incomplete: ["!", "warning", "미완료"],
  interrupted: ["!", "warning", "중단"], skipped: ["−", "muted", "건너뜀"],
  planned: ["○", "dim", "예정"], optional: ["○", "dim", "필요 시"],
  pending: ["○", "muted", "대기"], unobserved: ["?", "warning", "미관측"],
};
function clean(value) {
  if (typeof value !== "string") return "";
  return value.toWellFormed().replaceAll("\ufffd", "").replace(ANSI_RE, "")
    .replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
}
function fit(value, width) { return truncateToWidth(value, Math.max(0, width), "", true); }
function dimension(value, fallback) { return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback; }
function runKey(record) { return JSON.stringify([record.sessionId, record.flow?.id ?? record.requestId, record.flow?.startedAt]); }
function displayFlow(record) {
  if (!record) return undefined;
  return record.flow ?? { id: record.requestId ?? record.sessionId, status: "unobserved", rows: [],
    request: record.request, note: "Strataa Flow 기록이 저장되지 않은 세션입니다. 입력 원문만 표시하며 실행 상태·위임 관계는 추정하지 않습니다." };
}
function requestLabel(flow) {
  const summary = flow.promptSummary;
  if (summary?.status === "completed" && clean(summary.text)) return `요청 요약: ${clean(summary.text)}`;
  const status = summary?.status === "failed" ? "요약 실패"
    : summary?.status === "running" ? "요약 중" : "요약 없음";
  return `원문 (${status}): ${clean(flow.request) || "요청 없음"}${summary?.status === "failed" && clean(summary.error) ? ` · ${clean(summary.error)}` : ""}`;
}
function summaryInfo(flow) {
  const summary = flow.promptSummary;
  return [summary?.status ? `요약 ${clean(summary.status)}` : "요약 없음", clean(summary?.model)].filter(Boolean).join(" · ");
}
function sessionLabel(record) {
  return `${record.source === "session" ? "저장 기록 · " : ""}${clean(record.title) ? `${clean(record.title)} · ` : ""}${clean(record.sessionId) || "세션 미상"} · ${clean(record.cwd) || "작업 공간 미상"}`;
}

/**
 * @param {import("@oh-my-pi/pi-tui").Theme | undefined} theme
 * @param {{getHeight?: () => number, requestRender?: () => void,
 * onClose?: () => void, directory?: string, readLiveSessions?: () => Promise<object[]>}} options
 */
export function createFlowWatch(theme, options = {}) {
  let sessions = [];
  let selectedKey;
  let pageSize = 1;
  let closed = false;
  let readError = "";
  let discoveryError = "";
  let liveSessions = [];
  let discovering = false;
  const discoveryController = new AbortController();
  const readSavedFlows = createSavedFlowReader({ signal: discoveryController.signal });
  // Explicit snapshot directories stay isolated; default Linux watches also find older sessions.
  const readLiveSessions = options.readLiveSessions ?? (options.directory === undefined && !process.env.OMP_STRATAA_FLOW_DIR
    ? async () => readSavedFlows(await discoverSessionFiles()) : async () => []);
  const previews = new Map();
  let inspector;
  let inspectedRun;
  const uiTheme = () => theme ?? liveTheme;
  const height = () => dimension(options.getHeight?.() ?? process.stdout.rows, 24);
  const repaint = () => { if (!closed) options.requestRender?.(); };
  const selected = () => sessions.find(record => record.key === selectedKey);

  function back() {
    inspector?.dispose();
    inspector = undefined;
    inspectedRun = undefined;
    repaint();
  }
  function inspect() {
    const record = selected();
    if (!record) return;
    inspector?.dispose();
    inspectedRun = runKey(record);
    inspector = createFlowView(() => displayFlow(selected()), theme, {
      interactive: true,
      initialDetails: !record.flow,
      getHeight: () => Math.max(1, height() - (height() >= 3 ? 2 : height() === 2 ? 1 : 0)),
      requestRender: repaint,
      onClose: back,
      // Deliberately no readOutput: agent:// identities belong to the producer.
    });
  }
  function refresh() {
    if (closed) return;
    try {
      const previousIndex = sessions.findIndex(record => record.key === selectedKey);
      sessions = readFlowSessions({ ...(options.directory === undefined ? {} : { directory: options.directory }), liveSessions });
      for (const [key, preview] of previews) if (!sessions.some(record => record.key === key && record.flow)) {
        preview.view.dispose();
        previews.delete(key);
      }
      readError = discoveryError;
      if (!sessions.some(record => record.key === selectedKey)) {
        selectedKey = sessions[Math.min(Math.max(0, previousIndex), sessions.length - 1)]?.key;
        // An exited source must never leave its old inspector on screen.
        back();
      } else if (inspector && runKey(selected()) !== inspectedRun) inspect();
    } catch (error) {
      readError = clean(error instanceof Error ? error.message : String(error));
    }
    repaint();
  }
  async function discover() {
    if (closed || discovering) return;
    discovering = true;
    try {
      const found = await readLiveSessions();
      if (closed) return;
      liveSessions = found;
      discoveryError = "";
    } catch (error) {
      if (closed) return;
      discoveryError = clean(error instanceof Error ? error.message : String(error));
    } finally {
      discovering = false;
    }
    refresh();
  }
  refresh();
  void discover();
  const timer = setInterval(() => { refresh(); void discover(); }, 500);
  timer.unref?.();

  function dispose() {
    if (closed) return;
    closed = true;
    discoveryController.abort();
    clearInterval(timer);
    inspector?.dispose();
    for (const preview of previews.values()) preview.view.dispose();
    previews.clear();
    inspector = undefined;
  }
  function close() {
    if (closed) return;
    dispose();
    options.onClose?.();
  }
  function move(index) {
    selectedKey = sessions[Math.max(0, Math.min(sessions.length - 1, index))]?.key;
    repaint();
  }
  function renderPreview(record, width, available) {
    if (!record.flow) return [fit(uiTheme().fg("warning", "Strataa Flow 미관측 · Enter 원본 입력 확인"), width)].slice(0, available);
    let preview = previews.get(record.key);
    if (!preview) {
      preview = { record, height: available };
      preview.view = createFlowView(() => preview.record.flow, theme, {
        embedded: true, getHeight: () => preview.height,
      });
      previews.set(record.key, preview);
    }
    preview.record = record;
    preview.height = available;
    return preview.view.render(width);
  }
  function renderBoard(width, available, colors) {
    const headerSize = available >= 5 ? 1 : 0;
    const footerSize = available >= 5 ? 2 : available >= 2 ? 1 : 0;
    const bodyHeight = available - headerSize - footerSize;
    // Reserve enough rows for connected graph columns, not a selectable text list.
    pageSize = Math.max(1, Math.floor(bodyHeight / 7));
    const index = Math.max(0, sessions.findIndex(record => record.key === selectedKey));
    const start = Math.floor(index / pageSize) * pageSize;
    const shown = sessions.slice(start, start + pageSize);
    const range = `${sessions.length ? start + 1 : 0}-${start + shown.length}/${sessions.length}`;
    const page = `${Math.floor(start / pageSize) + 1}/${Math.max(1, Math.ceil(sessions.length / pageSize))}`;
    const lines = [];
    if (headerSize) lines.push(fit(readError ? colors.fg("error", `읽기 오류 · 마지막 스냅샷: ${readError}`)
      : colors.bold(colors.fg("accent", `Strataa Flow Watch · ${sessions.length} 세션 · 완료 기록 유지`)), width));
    if (!shown.length) {
      lines.push(fit(colors.fg(readError ? "error" : "muted", readError ? `읽기 오류: ${readError}` : "게시된 Flow 없음 · 실행 중인 OMP 세션을 기다립니다."), width));
    } else {
      const tileHeight = Math.max(1, Math.floor(bodyHeight / shown.length));
      for (const [offset, record] of shown.entries()) {
        const active = record.key === selectedKey;
        const flow = displayFlow(record);
        const [symbol, color, state] = STATES[flow.status] ?? STATES.pending;
        const position = `${start + offset + 1}/${sessions.length}`;
        const label = `${active ? "›" : " "} ${position} ${symbol} ${state} · ${sessionLabel(record)}`;
        if (tileHeight === 1) {
          lines.push(fit(colors.fg(active ? "accent" : color, `${position} ${active ? "›" : ""}${clean(record.sessionId)} · ${state}`), width));
          continue;
        }
        lines.push(fit(colors.fg(active ? "accent" : color, label), width));
        lines.push(fit(colors.fg("muted", requestLabel(flow)), width));
        const room = tileHeight - 2;
        if (room > 0) lines.push(...renderPreview(record, width, room));
        while (lines.length < headerSize + (offset + 1) * tileHeight) lines.push("");
      }
    }
    while (lines.length < available - footerSize) lines.push("");
    if (footerSize > 1) lines.push(fit(colors.fg("muted", `세션 ${range} · 페이지 ${page}${shown.length < sessions.length ? " · 숨김 있음 · PgUp/PgDn" : ""}`), width));
    if (footerSize) lines.push(fit(colors.fg(readError && !headerSize ? "error" : "dim", readError && !headerSize
      ? `읽기 오류: ${readError}` : footerSize === 1 || width < 48 ? `${range} ↑↓/Tab Pg Enter Esc q/^C`
        : "↑↓←→/Tab 세션 · PgUp/PgDn 페이지 · Home/End · Enter 상세 · q/Ctrl-C 닫기"), width));
    return lines.slice(0, available);
  }

  return {
    render(width) {
      if (closed) return [];
      width = dimension(width, 1);
      const available = height();
      const colors = uiTheme();
      if (readError && available === 1) return [fit(colors.fg("error", `읽기 오류: ${readError}`), width)];
      if (!inspector || !selected()) return renderBoard(width, available, colors);
      const record = selected();
      const flow = displayFlow(record);
      const lines = [];
      if (available >= 2) lines.push(fit(colors.fg(readError ? "error" : "accent", readError
        ? `읽기 오류 · 마지막 스냅샷: ${readError}` : `${sessionLabel(record)} · ${summaryInfo(flow)}`), width));
      lines.push(...inspector.render(width));
      if (available >= 3) lines.push(fit(colors.fg("muted", `Esc 세션 목록 · q/Ctrl-C 닫기 · ${requestLabel(flow)}`), width));
      return lines.slice(0, available);
    },
    handleInput(input) {
      if (closed) return;
      const is = key => matchesKey(input, key);
      if (is("q") || is("ctrl+c")) { close(); return; }
      if (is("escape")) { if (inspector) back(); return; }
      if (inspector) { inspector.handleInput(input); return; }
      if (!sessions.length) return;
      const index = Math.max(0, sessions.findIndex(record => record.key === selectedKey));
      if (is("enter")) { inspect(); repaint(); }
      else if (is("tab") || is("shift+tab")) move((index + (is("shift+tab") ? -1 : 1) + sessions.length) % sessions.length);
      else if (is("up") || is("left")) move(index - 1);
      else if (is("down") || is("right")) move(index + 1);
      else if (is("pageUp")) move(index - pageSize);
      else if (is("pageDown")) move(index + pageSize);
      else if (is("home")) move(0);
      else if (is("end")) move(sessions.length - 1);
    },
    invalidate() { inspector?.invalidate(); },
    dispose,
  };
}
