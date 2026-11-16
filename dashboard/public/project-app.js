const $ = (id) => document.getElementById(id);
const views = ['overview', 'topdown', 'buildup', 'sources'];
const labels = { field: '분야', problem: '문제', method: '방법', technique: '기법', question: '질문', hypothesis: '가설', decision: '결정', experiment: '실험', result: '결과', draft: '초안', active: '진행 중', accepted: '선택됨', rejected: '기각', superseded: '대체됨' };
const state = { projects: [], selectedId: '', view: 'overview', conceptId: '', buildupId: '', sourceId: '', loading: false, busy: false, controller: null, request: 0, rendered: '', listRendered: '', connectionFailed: false };
try { state.selectedId = localStorage.getItem('strataa-project-id') || ''; } catch { /* Storage is optional. */ }

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}
function append(parent, ...children) {
  parent.append(...children.filter(Boolean));
  return parent;
}
function button(text, action, className = 'text-button') {
  const element = node('button', className, text);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}
function badge(text, className = '') { return node('span', `badge ${className}`, text); }
function current() { return state.projects.find((project) => project.id === state.selectedId); }
function items(snapshot, key) { return Array.isArray(snapshot?.[key]) ? snapshot[key] : []; }
function notice(message, isError = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').classList.toggle('is-error', isError);
}
function rememberSelection() {
  try {
    if (state.selectedId) localStorage.setItem('strataa-project-id', state.selectedId);
    else localStorage.removeItem('strataa-project-id');
  } catch { /* The workspace also works without browser storage. */ }
}
function setBusy(value) {
  state.busy = value;
  $('connect-button').disabled = value;
  $('disconnect-button').disabled = value;
  $('refresh-button').disabled = value || state.loading;
  for (const element of $('project-list').querySelectorAll('button')) element.disabled = value;
}
function syncStatus(text) { $('sync-status').textContent = text; }
function dateLabel(value) {
  if (!value) return '기록 갱신 시각 없음';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: 'no-store', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  let data;
  try { data = await response.json(); } catch { throw new Error(`서버 응답을 읽을 수 없습니다 (HTTP ${response.status}).`); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `요청 실패 (HTTP ${response.status})`);
  return data;
}
function cancelRead() {
  state.request += 1;
  state.controller?.abort();
  state.controller = null;
  state.loading = false;
}
async function refresh(detail = false) {
  if (state.busy || state.loading) return;
  const selectedId = state.selectedId;
  const controller = new AbortController();
  const request = ++state.request;
  state.controller = controller;
  state.loading = true;
  $('refresh-button').disabled = true;
  syncStatus('로컬 기록 읽는 중…');
  try {
    const result = await api(detail && selectedId ? `/api/projects/${encodeURIComponent(selectedId)}` : '/api/projects', { signal: controller.signal });
    if (request !== state.request) return;
    if (detail && selectedId) {
      if (state.selectedId !== selectedId) return;
      const index = state.projects.findIndex((project) => project.id === selectedId);
      if (index >= 0) state.projects[index] = result;
      else state.projects.push(result);
    } else {
      state.projects = result.projects;
      if (!current()) {
        state.selectedId = state.projects[0]?.id || '';
        rememberSelection();
      }
    }
    notice('');
    render();
    syncStatus(document.hidden ? '화면 숨김 · 새로고침 일시 중지' : !current() ? '디렉터리를 연결해 주세요' : current().status === 'error' ? '기록 오류 · 마지막 기록 표시' : '로컬 기록 연결됨 · 5초 동기화');
  } catch (error) {
    if (request !== state.request || error.name === 'AbortError') return;
    notice(`새로 읽지 못했습니다. ${error.message} 기존 화면은 최신 상태가 아닐 수 있습니다.`, true);
    syncStatus('연결 오류 · 최신 상태 확인 불가');
    if (!current()) showOnboarding();
  } finally {
    if (request === state.request) {
      state.loading = false;
      state.controller = null;
      $('refresh-button').disabled = state.busy;
    }
  }
}
function selectProject(id) {
  if (state.busy || id === state.selectedId) return;
  cancelRead();
  state.selectedId = id;
  state.conceptId = state.buildupId = state.sourceId = '';
  state.rendered = '';
  state.connectionFailed = false;
  notice('');
  rememberSelection();
  render();
  refresh(true);
}
function setView(view) {
  if (!views.includes(view)) return;
  state.view = view;
  for (const element of document.querySelectorAll('[data-view]')) {
    const active = element.dataset.view === view;
    element.classList.toggle('active', active);
    if (active) element.setAttribute('aria-current', 'page');
    else element.removeAttribute('aria-current');
  }
  $('view-breadcrumb').textContent = { overview: 'Overview', topdown: 'Top-down', buildup: 'BuildUp', sources: 'Sources' }[view];
  updateVisibility();
}
function updateVisibility() {
  const snapshot = current();
  for (const view of views) $(`view-${view}`).hidden = !snapshot || state.view !== view;
  $('onboarding').hidden = Boolean(snapshot && !state.connectionFailed && (items(snapshot, 'sources').length || items(snapshot, 'concepts').length || items(snapshot, 'buildUps').length));
}
function bootstrapPrompt() {
  const root = state.connectionFailed ? $('project-path').value.trim() : current()?.root || $('project-path').value.trim();
  const target = root ? JSON.stringify(root) : '현재 작업 중인 프로젝트 디렉터리';
  return `strataa-project 스킬을 사용해 ${target}의 연구 맥락을 정리해 주세요.\n프로젝트 내 관련 문서와 논문 텍스트를 읽고 .strataa/project.json (schemaVersion: 1)을 생성하거나 갱신해 주세요. project의 요약과 다음 행동, sources의 짧은 요약, 분야→문제→방법→기법 Top-down concepts, 부모 기록으로 연결된 BuildUp을 작성해 주세요.\nBuildUp에는 질문·가설·결정·실험·결과, 대안, 선택 이유, 다음 행동을 남기고 evidence에는 프로젝트 내 텍스트 원문과 일치하는 sourceId와 quote를 인용해 주세요. 근거가 없으면 빈틈으로 명시하고 사실을 만들어 내지 마세요. 기존 판단과 rationale은 보존하고 대체 시 superseded로 남겨 주세요.\n프로젝트 외부 파일·비밀 파일·심볼릭 링크는 읽지 말고, 기존 소스와 데이터베이스는 수정하지 마세요. 엄격한 JSON 및 참조·부모 계층·인용 일치를 확인한 뒤 원자적으로 저장해 주세요. Dashboard는 이 기록을 읽기만 하며 LLM을 자동 실행하지 않습니다.`;
}
function showOnboarding() {
  $('bootstrap-prompt').value = bootstrapPrompt();
  $('onboarding-title').textContent = state.connectionFailed ? '아직 프로젝트 기록이 없거나 읽을 수 없나요?' : '프로젝트를 이해하는 일은 에이전트에게.';
  $('onboarding').hidden = false;
}
function renderProjects() {
  const signature = JSON.stringify([state.selectedId, state.projects.map(({ id, name, root, status }) => ({ id, name, root, status }))]);
  if (signature === state.listRendered) return;
  state.listRendered = signature;
  const list = $('project-list');
  list.replaceChildren();
  if (!state.projects.length) list.append(node('p', 'sidebar-empty', '아직 연결된 프로젝트가 없습니다.'));
  for (const project of state.projects) {
    const element = button('', () => selectProject(project.id), `project-item${project.id === state.selectedId ? ' selected' : ''}`);
    append(element, node('span', `project-indicator${project.status === 'error' ? ' error' : ''}`), append(node('span', 'project-item-copy'), node('strong', '', project.name || project.project?.name || '이름 없는 프로젝트'), node('small', '', project.root)), node('span', 'project-state', project.status === 'error' ? '오류' : ''));
    element.title = project.root;
    element.disabled = state.busy;
    if (project.id === state.selectedId) element.setAttribute('aria-current', 'true');
    list.append(element);
  }
}
function render() {
  renderProjects();
  const snapshot = current();
  $('disconnect-button').hidden = !snapshot;
  $('project-breadcrumb').textContent = snapshot?.name || '프로젝트';
  $('project-title').textContent = snapshot?.project?.name || snapshot?.name || '논문을 넘어, 프로젝트의 맥락으로.';
  $('project-root').textContent = snapshot?.root || '프로젝트 디렉터리를 연결해 연구의 큰 그림과 다음 행동을 확인하세요.';
  $('project-error').hidden = snapshot?.status !== 'error';
  $('project-error-message').textContent = snapshot?.error || '';
  $('concept-count').textContent = snapshot?.counts?.concepts ?? 0;
  $('buildup-count').textContent = snapshot?.counts?.buildUps ?? 0;
  $('source-count').textContent = snapshot?.counts?.sources ?? 0;
  $('bootstrap-prompt').value = bootstrapPrompt();
  updateVisibility();
  if (!snapshot) {
    $('connect-panel').open = true;
    showOnboarding();
    state.rendered = '';
    return;
  }
  const signature = JSON.stringify(snapshot);
  if (signature === state.rendered) return;
  state.rendered = signature;
  renderOverview(snapshot);
  renderConcepts(snapshot);
  renderBuildUps(snapshot);
  renderSources(snapshot);
}
function empty(parent, message) { parent.append(node('p', 'empty-state', message)); }
function openRecord(view, id) {
  if (view === 'topdown') { state.conceptId = id; renderConcepts(current()); }
  if (view === 'buildup') { state.buildupId = id; renderBuildUps(current()); }
  if (view === 'sources') { state.sourceId = id; renderSources(current()); }
  setView(view);
}
function renderOverview(snapshot) {
  $('updated-at').textContent = `기록 갱신 · ${dateLabel(snapshot.updatedAt)}${snapshot.status === 'error' ? ' · 마지막 정상 기록' : ''}`;
  $('project-summary').textContent = snapshot.project?.summary || '프로젝트 요약이 아직 없습니다. 작업 에이전트에게 연구 맥락 정리를 요청하세요.';
  $('project-next').textContent = snapshot.project?.nextStep || '다음 행동이 아직 기록되지 않았습니다.';
  const stats = $('stats');
  stats.replaceChildren();
  for (const [key, label] of [['sources', '자료 요약'], ['concepts', '연결된 개념'], ['buildUps', '연구 기록'], ['gaps', '근거 빈틈']]) stats.append(append(node('div', 'stat'), node('strong', '', snapshot.counts?.[key] ?? 0), node('span', '', label)));
  const diagnostics = $('diagnostics');
  diagnostics.replaceChildren();
  $('gap-count').textContent = `${snapshot.counts?.gaps ?? 0} gaps`;
  for (const diagnostic of items(snapshot, 'diagnostics')) {
    const row = append(node('div', `diagnostic ${diagnostic.kind === 'warning' ? 'warning' : ''}`), badge(diagnostic.kind === 'warning' ? '주의' : '근거 빈틈'), node('p', '', diagnostic.message));
    if (diagnostic.recordId) {
      const id = diagnostic.recordId;
      const view = items(snapshot, 'buildUps').some((record) => record.id === id) ? 'buildup' : items(snapshot, 'concepts').some((record) => record.id === id) ? 'topdown' : items(snapshot, 'sources').some((record) => record.id === id) ? 'sources' : null;
      if (view) row.append(button('기록 보기 →', () => openRecord(view, id)));
      else row.append(node('span', 'muted', id));
    }
    diagnostics.append(row);
  }
  if (!items(snapshot, 'diagnostics').length) empty(diagnostics, '기록 검증에서 보고된 빈틈이 없습니다. 과학적 주장 자체가 입증되었다는 의미는 아닙니다.');
  const recent = $('recent-records');
  recent.replaceChildren();
  for (const record of items(snapshot, 'buildUps').slice(-4).reverse()) recent.append(preview(record.title, record.nextStep || record.body, () => openRecord('buildup', record.id), labels[record.kind] || record.kind));
  if (!recent.childElementCount) empty(recent, '연구 질문과 판단의 흐름이 아직 없습니다.');
  const sources = $('source-preview');
  sources.replaceChildren();
  for (const source of items(snapshot, 'sources').slice(0, 3)) sources.append(preview(source.title, source.summary || '요약이 아직 없습니다.', () => openRecord('sources', source.id)));
  if (!sources.childElementCount) empty(sources, '에이전트가 자료를 읽고 요약하면 여기에 표시됩니다.');
}
function preview(title, description, action, meta) {
  const element = button('', action, 'preview-item');
  if (meta) element.append(node('small', 'eyebrow', meta));
  return append(element, node('strong', '', title), node('span', 'preview-summary', description));
}
function flatten(records) {
  const children = new Map();
  const ids = new Set(records.map((record) => record.id));
  for (const record of records) {
    const parent = ids.has(record.parentId) ? record.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(record);
  }
  const result = [];
  const seen = new Set();
  const stack = [...(children.get(null) || [])].reverse().map((record) => ({ record, depth: 0 }));
  while (stack.length) {
    const item = stack.pop();
    if (seen.has(item.record.id)) continue;
    seen.add(item.record.id);
    result.push(item);
    for (const child of [...(children.get(item.record.id) || [])].reverse()) stack.push({ record: child, depth: item.depth + 1 });
  }
  return result;
}
function recordRow(record, depth, selected, action, type) {
  const element = button('', action, `record-item${selected ? ' selected' : ''}`);
  element.style.setProperty('--depth', Math.min(depth, 5));
  if (selected) element.setAttribute('aria-current', 'true');
  const meta = node('span', 'record-meta');
  meta.append(badge(labels[record.level || record.kind] || type));
  if (record.status) meta.append(node('span', `record-status status-${record.status}`, labels[record.status] || record.status));
  append(element, meta, node('strong', '', record.name || record.title), node('span', 'record-excerpt', record.description || record.summary || record.body || '내용이 아직 없습니다.'));
  if (depth) element.setAttribute('aria-label', `${record.name || record.title}, ${depth + 1}단계${record.parentId ? ', 상위 기록에 연결됨' : ''}`);
  return element;
}
function detailHeader(parent, eyebrow, title, meta) {
  append(parent, node('div', 'eyebrow', eyebrow), node('h2', '', title));
  if (meta) parent.append(meta);
}
function section(parent, title, text, fallback = '아직 기록되지 않았습니다.') {
  const area = append(node('section', 'detail-section'), node('h3', '', title), node('p', 'prose', text || fallback));
  parent.append(area);
  return area;
}
function sourceLinks(parent, snapshot, sourceIds) {
  const area = append(node('section', 'detail-section'), node('h3', '', '연결된 자료 요약'));
  for (const id of sourceIds || []) {
    const source = items(snapshot, 'sources').find((item) => item.id === id);
    if (source) area.append(preview(source.title, source.summary || '요약이 아직 없습니다.', () => openRecord('sources', id)));
  }
  if (area.childElementCount === 1) empty(area, '연결된 자료가 없습니다.');
  parent.append(area);
}
function ancestry(records, record) {
  const byId = new Map(records.map((item) => [item.id, item]));
  const chain = [];
  const seen = new Set();
  let cursor = record;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = byId.get(cursor.parentId);
  }
  return chain.reverse();
}
function chainSection(parent, records, record, view, title) {
  const chain = ancestry(records, record);
  const area = append(node('section', 'detail-section'), node('h3', '', title));
  const list = node('ol', 'parent-chain');
  for (const [index, item] of chain.entries()) {
    const row = node('li', item.id === record.id ? 'current' : '');
    append(row, node('span', 'chain-number', String(index + 1).padStart(2, '0')), button(item.title || item.name, () => openRecord(view, item.id), 'chain-link'));
    list.append(row);
  }
  append(area, list);
  parent.append(area);
}
function renderConcepts(snapshot) {
  const records = items(snapshot, 'concepts');
  if (!records.some((record) => record.id === state.conceptId)) state.conceptId = records[0]?.id || '';
  const list = $('concept-tree');
  list.replaceChildren();
  for (const { record, depth } of flatten(records)) list.append(recordRow(record, depth, state.conceptId === record.id, () => openRecord('topdown', record.id), '개념'));
  const detail = $('concept-detail');
  detail.replaceChildren();
  const record = records.find((item) => item.id === state.conceptId);
  if (!record) { empty(list, '아직 개념이 없습니다. 에이전트에게 분야부터 기법까지 계층을 정리하도록 요청하세요.'); empty(detail, '개념을 선택하면 설명과 연결된 자료를 볼 수 있습니다.'); return; }
  detailHeader(detail, `TOP-DOWN / ${labels[record.level] || record.level}`, record.name);
  chainSection(detail, records, record, 'topdown', '큰 그림에서 이 개념까지');
  section(detail, '핵심 설명', record.description);
  sourceLinks(detail, snapshot, record.sourceIds);
  const related = append(node('section', 'detail-section'), node('h3', '', '이 개념을 사용한 연구 기록'));
  for (const buildup of items(snapshot, 'buildUps').filter((item) => item.conceptIds?.includes(record.id))) related.append(preview(buildup.title, buildup.rationale || buildup.body, () => openRecord('buildup', buildup.id), labels[buildup.kind]));
  if (related.childElementCount === 1) empty(related, '연결된 BuildUp 기록이 없습니다.');
  detail.append(related);
}
function evidence(parent, snapshot, quotes) {
  const area = append(node('section', 'detail-section evidence-section'), node('h3', '', '원문 인용 근거'));
  if (!quotes?.length) area.append(node('p', 'evidence-gap', '인용 근거가 없습니다. 이 기록의 주장을 검증된 사실로 취급하지 마세요.'));
  for (const quote of quotes || []) {
    const source = items(snapshot, 'sources').find((item) => item.id === quote.sourceId);
    const figure = node('figure', 'quote-card');
    append(figure, node('blockquote', '', quote.quote), append(node('figcaption'), node('span', '', snapshot.status === 'error' ? '마지막 정상 기록의 인용 · ' : '로컬 원문 일치 인용 · '), button(source?.title || quote.sourceId, () => openRecord('sources', quote.sourceId))));
    area.append(figure);
  }
  parent.append(area);
}
function renderBuildUps(snapshot) {
  const records = items(snapshot, 'buildUps');
  if (!records.some((record) => record.id === state.buildupId)) state.buildupId = records[records.length - 1]?.id || '';
  const list = $('buildup-list');
  list.replaceChildren();
  for (const { record, depth } of flatten(records)) list.append(recordRow(record, depth, state.buildupId === record.id, () => openRecord('buildup', record.id), '기록'));
  const detail = $('buildup-detail');
  detail.replaceChildren();
  const record = records.find((item) => item.id === state.buildupId);
  if (!record) { empty(list, '아직 연구 기록이 없습니다. 질문과 판단, 그 이유를 BuildUp으로 남기세요.'); empty(detail, '연구 기록을 선택하면 부모 맥락과 원문 근거를 볼 수 있습니다.'); return; }
  detailHeader(detail, 'RESEARCH BUILDUP', record.title, append(node('div', 'detail-meta'), badge(labels[record.kind] || record.kind), badge(labels[record.status] || record.status, `status-${record.status}`)));
  chainSection(detail, records, record, 'buildup', '이 판단이 만들어진 경로');
  section(detail, '핵심 내용', record.body);
  section(detail, '검토한 대안', record.alternatives);
  section(detail, '이유 · 판단의 근거', record.rationale);
  evidence(detail, snapshot, record.evidence);
  section(detail, '다음 행동', record.nextStep, '다음 행동이 아직 기록되지 않았습니다.');
  if (record.status === 'accepted') detail.append(node('p', 'help accepted-note', '선택됨(accepted)은 프로젝트에서 채택한 판단이라는 뜻이며, 과학적 입증을 뜻하지 않습니다.'));
  const concepts = append(node('section', 'detail-section'), node('h3', '', '연결된 개념'));
  for (const id of record.conceptIds || []) {
    const concept = items(snapshot, 'concepts').find((item) => item.id === id);
    if (concept) concepts.append(button(concept.name, () => openRecord('topdown', id), 'chip-button'));
  }
  if (concepts.childElementCount === 1) empty(concepts, '연결된 개념이 없습니다.');
  detail.append(concepts);
  sourceLinks(detail, snapshot, record.sourceIds);
  const children = records.filter((item) => item.parentId === record.id);
  if (children.length) {
    const area = append(node('section', 'detail-section'), node('h3', '', '이어지는 연구 기록'));
    for (const child of children) area.append(preview(child.title, child.nextStep || child.body, () => openRecord('buildup', child.id), labels[child.kind]));
    detail.append(area);
  }
  if (record.skillNames?.length) section(detail, '사용한 에이전트 스킬', record.skillNames.join(' · '));
}
function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
function renderSources(snapshot) {
  const sources = items(snapshot, 'sources');
  if (!sources.some((source) => source.id === state.sourceId)) state.sourceId = sources[0]?.id || '';
  const list = $('source-list');
  list.replaceChildren();
  for (const source of sources) list.append(recordRow(source, 0, state.sourceId === source.id, () => openRecord('sources', source.id), '자료'));
  const detail = $('source-detail');
  detail.replaceChildren();
  const source = sources.find((item) => item.id === state.sourceId);
  if (!source) { empty(list, '아직 자료 요약이 없습니다. 작업 에이전트에게 프로젝트 내 원문을 읽고 요약하도록 요청하세요.'); empty(detail, '자료를 선택하면 핵심 요약과 이를 인용한 연구 기록을 볼 수 있습니다.'); return; }
  detailHeader(detail, 'SOURCE / AGENT SUMMARY', source.title);
  const meta = node('p', 'source-meta', [source.authors, source.year].filter(Boolean).join(' · '));
  append(detail, meta, node('p', 'source-path', source.path));
  const url = safeUrl(source.url);
  if (url) {
    const link = node('a', 'external-link', '출처 페이지 ↗');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    detail.append(link);
  }
  section(detail, '한 번에 이해하는 핵심', source.summary, '에이전트 요약이 아직 없습니다. 원문을 읽고 요약을 보완하도록 요청하세요.');
  const cited = items(snapshot, 'buildUps').filter((record) => record.evidence?.some((quote) => quote.sourceId === source.id));
  const quotes = append(node('section', 'detail-section'), node('h3', '', '이 자료가 뒷받침하는 판단'));
  for (const record of cited) {
    const group = node('div', 'citation-group');
    group.append(button(record.title, () => openRecord('buildup', record.id), 'citation-title'));
    for (const quote of record.evidence.filter((item) => item.sourceId === source.id)) group.append(node('blockquote', 'source-quote', quote.quote));
    group.append(node('p', 'help', snapshot.status === 'error' ? '마지막 정상 기록의 인용입니다. 현재 원문 상태는 확인되지 않았습니다.' : '인용 문자열이 로컬 원문과 일치합니다. 주장의 타당성은 별도로 판단하세요.'));
    quotes.append(group);
  }
  if (!cited.length) empty(quotes, '이 자료를 직접 인용한 BuildUp이 없습니다. 요약과 실제 판단 사이의 근거 연결을 보완하세요.');
  detail.append(quotes);
  const linked = items(snapshot, 'buildUps').filter((record) => record.sourceIds?.includes(source.id) && !cited.some((item) => item.id === record.id));
  if (linked.length) {
    const area = append(node('section', 'detail-section'), node('h3', '', '자료만 연결된 기록 · 직접 인용 없음'));
    for (const record of linked) area.append(preview(record.title, record.body, () => openRecord('buildup', record.id)));
    detail.append(area);
  }
  const concepts = items(snapshot, 'concepts').filter((record) => record.sourceIds?.includes(source.id));
  if (concepts.length) {
    const area = append(node('section', 'detail-section'), node('h3', '', '연결된 개념'));
    for (const concept of concepts) area.append(button(concept.name, () => openRecord('topdown', concept.id), 'chip-button'));
    detail.append(area);
  }
}

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const path = $('project-path').value.trim();
  if (!path) return;
  cancelRead();
  setBusy(true);
  notice('');
  syncStatus('디렉터리 기록 검증 중…');
  try {
    const snapshot = await api('/api/projects', { method: 'POST', body: JSON.stringify({ path }) });
    state.projects = [...state.projects.filter((project) => project.id !== snapshot.id), snapshot];
    state.selectedId = snapshot.id;
    state.conceptId = state.buildupId = state.sourceId = '';
    state.connectionFailed = false;
    state.rendered = '';
    rememberSelection();
    $('connect-panel').open = false;
    render();
    notice('프로젝트를 연결했습니다. 원본 파일은 수정하지 않습니다.');
    syncStatus('로컬 기록 연결됨 · 5초 동기화');
  } catch (error) {
    state.connectionFailed = true;
    notice(`연결하지 못했습니다. ${error.message}`, true);
    showOnboarding();
    syncStatus('디렉터리 연결 실패');
  } finally { setBusy(false); }
});
$('disconnect-button').addEventListener('click', async () => {
  const snapshot = current();
  if (!snapshot || state.busy) return;
  if (!window.confirm(`“${snapshot.name}” 연결을 해제할까요? 프로젝트 파일과 연구 기록은 삭제되지 않습니다.`)) return;
  cancelRead();
  setBusy(true);
  try {
    await api(`/api/projects/${encodeURIComponent(snapshot.id)}`, { method: 'DELETE', body: '{}' });
    state.projects = state.projects.filter((project) => project.id !== snapshot.id);
    state.selectedId = state.projects[0]?.id || '';
    state.conceptId = state.buildupId = state.sourceId = '';
    state.connectionFailed = false;
    state.rendered = '';
    rememberSelection();
    render();
    notice('로컬 연결만 해제했습니다. 프로젝트 파일은 그대로 보존됩니다.');
    syncStatus(state.selectedId ? '로컬 기록 연결됨 · 5초 동기화' : '디렉터리를 연결해 주세요');
  } catch (error) { notice(`연결 해제 실패. ${error.message}`, true); }
  finally { setBusy(false); }
});
$('copy-bootstrap').addEventListener('click', async () => {
  const prompt = $('bootstrap-prompt');
  prompt.value = bootstrapPrompt();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(prompt.value);
    notice('에이전트 시작 요청을 복사했습니다. 작업 중인 에이전트에 붙여 넣으세요.');
  } catch {
    prompt.focus();
    prompt.select();
    notice('자동 복사를 사용할 수 없습니다. 선택된 요청을 직접 복사하세요.');
  }
});
$('project-path').addEventListener('input', () => { $('bootstrap-prompt').value = bootstrapPrompt(); });
$('refresh-button').addEventListener('click', () => refresh());
for (const element of document.querySelectorAll('[data-view]')) element.addEventListener('click', () => setView(element.dataset.view));
for (const element of document.querySelectorAll('[data-go]')) element.addEventListener('click', () => setView(element.dataset.go));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelRead();
    $('refresh-button').disabled = state.busy;
    syncStatus('화면 숨김 · 새로고침 일시 중지');
  } else refresh();
});
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
render();
if (!document.hidden) refresh();
