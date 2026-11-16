import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

export class ResearchError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function createStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "dashboard.sqlite");
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS research (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS originals (id TEXT PRIMARY KEY, bytes BLOB NOT NULL); CREATE TABLE IF NOT EXISTS analysis_job (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);");
  db.prepare("INSERT OR IGNORE INTO research VALUES (1, ?)").run(JSON.stringify({ version: 1, revision: 0, papers: [], concepts: [], buildUps: [] }));
  const read = () => JSON.parse(db.prepare("SELECT data FROM research WHERE id=1").get().data);
  return {
    job() {
      const row = db.prepare("SELECT data FROM analysis_job WHERE id=1").get();
      return row ? JSON.parse(row.data) : { status: "idle", paperIds: [], error: null };
    },
    saveJob(job) { db.prepare("INSERT OR REPLACE INTO analysis_job VALUES (1, ?)").run(JSON.stringify(job)); },
    file,
    read,
    update(revision, change, original) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = read();
        if (revision !== state.revision) throw new ResearchError("다른 저장이 먼저 반영되었습니다. 새로고침 후 다시 저장하세요. 입력은 유지됩니다.", 409);
        const result = change(state);
        state.revision++;
        db.prepare("UPDATE research SET data=? WHERE id=1").run(JSON.stringify(state));
        if (original) db.prepare("INSERT INTO originals VALUES (?, ?)").run(original.id, original.bytes);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    original(id) { return db.prepare("SELECT bytes FROM originals WHERE id=?").get(id)?.bytes; },
    close() { db.close(); },
  };
}

export const LEVELS = ["field", "problem", "method", "technique"];
const KINDS = ["question", "hypothesis", "decision", "experiment", "result"];
const STATUSES = ["draft", "active", "accepted", "rejected", "superseded"];
const now = () => new Date().toISOString();
const normalized = value => value.normalize("NFC").replace(/\s+/gu, " ").trim();
const key = value => normalized(value).toLocaleLowerCase("en");

function text(value, field, { required = false, max = 20000 } = {}) {
  if (value === undefined || value === null) value = "";
  if (typeof value !== "string" || value.length > max) throw new ResearchError(`${field}: 문자열 길이는 ${max}자 이하여야 합니다.`);
  value = value.trim();
  if (required && !value) throw new ResearchError(`${field}을(를) 입력하세요.`);
  return value;
}
function choose(value, choices, field) {
  if (!choices.includes(value)) throw new ResearchError(`${field}: ${choices.join(", ")} 중 하나를 선택하세요.`);
  return value;
}
function find(items, id, label) {
  const item = items.find(item => item.id === id);
  if (!item) throw new ResearchError(`${label}을(를) 찾을 수 없습니다: ${id}`, 404);
  return item;
}
function references(value, items, field) {
  if (!Array.isArray(value) || value.some(id => typeof id !== "string")) throw new ResearchError(`${field}: ID 목록이 필요합니다.`);
  if (new Set(value).size !== value.length) throw new ResearchError(`${field}: 중복 연결입니다.`);
  for (const id of value) find(items, id, field);
  return value;
}
function sourceUrl(value) {
  const url = text(value, "출처 URL", { max: 4000 });
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new ResearchError("출처는 http(s) URL로 입력하세요."); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw new ResearchError("출처는 http(s) URL로 입력하세요.");
  }
  return url;
}

export function validateHierarchy(concepts) {
  const byId = new Map(concepts.map(concept => [concept.id, concept]));
  if (byId.size !== concepts.length) throw new ResearchError("중복 개념 ID입니다.");
  const names = new Set();
  for (const concept of concepts) {
    const depth = LEVELS.indexOf(concept.level);
    if (depth < 0) throw new ResearchError("알 수 없는 개념 계층입니다.");
    if (depth === 0 ? concept.parentId !== null : byId.get(concept.parentId)?.level !== LEVELS[depth - 1]) {
      throw new ResearchError("분야 → 문제 → 방법 → 기법 순서로 바로 위 단계의 개념을 연결하세요.");
    }
    const nameKey = `${concept.level}\0${concept.parentId ?? ""}\0${key(concept.name)}`;
    if (names.has(nameKey)) throw new ResearchError("같은 상위 개념 아래에 동일한 이름이 있습니다. 기존 개념을 연결하세요.");
    names.add(nameKey);
  }
}

function linksFor(value, paper, concepts) {
  if (!Array.isArray(value)) throw new ResearchError("개념 연결 목록이 필요합니다.");
  const seen = new Set();
  const source = normalized(paper.text);
  return value.map(link => {
    if (!link || typeof link !== "object") throw new ResearchError("개념 연결 형식이 잘못되었습니다.");
    find(concepts, link.conceptId, "개념");
    if (seen.has(link.conceptId)) throw new ResearchError("같은 개념은 한 번만 연결하세요.");
    seen.add(link.conceptId);
    const quote = text(link.quote, "원문 인용", { required: true, max: 12000 });
    if (!source.includes(normalized(quote))) throw new ResearchError("인용문이 이 논문 원문에 없습니다. 공백을 제외한 원문을 그대로 인용하세요.");
    return { conceptId: link.conceptId, quote, note: text(link.note, "연결 설명", { max: 6000 }) };
  });
}

export function addPaper(store, input, source) {
  const id = `paper-${randomUUID()}`;
  return store.update(input.revision, state => {
    const timestamp = now();
    const paper = {
      id, title: text(input.title || source.name, "논문 제목", { required: true, max: 1000 }),
      authors: text(input.authors, "저자", { max: 4000 }), year: text(input.year, "연도", { max: 100 }),
      sourceUrl: sourceUrl(input.sourceUrl), text: text(source.text, "논문 원문", { required: true, max: 20 * 1024 * 1024 }),
      notes: text(input.notes, "읽기 노트"), originalName: source.name || "", hasPdf: !!source.pdf,
      analysis: null, conceptLinks: [], createdAt: timestamp, updatedAt: timestamp,
    };
    state.papers.push(paper);
    return paper;
  }, source.pdf ? { id, bytes: source.pdf } : undefined);
}

export function savePaper(store, id, input) {
  return store.update(input.revision, state => {
    const paper = find(state.papers, id, "논문");
    for (const [field, label, max] of [["title", "논문 제목", 1000], ["authors", "저자", 4000], ["year", "연도", 100], ["notes", "읽기 노트", 20000]]) {
      if (input[field] !== undefined) paper[field] = text(input[field], label, { required: field === "title", max });
    }
    if (input.sourceUrl !== undefined) paper.sourceUrl = sourceUrl(input.sourceUrl);
    if (input.conceptLinks !== undefined) paper.conceptLinks = linksFor(input.conceptLinks, paper, state.concepts);
    paper.updatedAt = now();
    return paper;
  });
}

export function saveConcept(store, id, input) {
  return store.update(input.revision, state => {
    const previous = id ? find(state.concepts, id, "개념") : null;
    const timestamp = now();
    const concept = {
      ...previous, id: id || `concept-${randomUUID()}`,
      name: text(input.name, "개념 이름", { required: true, max: 200 }),
      description: text(input.description, "개념 설명", { max: 6000 }), level: choose(input.level, LEVELS, "계층"),
      parentId: input.parentId || null, review: choose(input.review || previous?.review || "draft", ["draft", "accepted"], "검토 상태"),
      createdAt: previous?.createdAt || timestamp, updatedAt: timestamp,
    };
    const index = state.concepts.findIndex(item => item.id === id);
    if (index < 0) state.concepts.push(concept); else state.concepts[index] = concept;
    validateHierarchy(state.concepts);
    return concept;
  });
}

export function saveBuildUp(store, id, input, { skills, flow } = {}) {
  return store.update(input.revision, state => {
    const previous = id ? find(state.buildUps, id, "BuildUp") : null;
    const timestamp = now();
    const entry = { ...previous, id: id || `buildup-${randomUUID()}`, createdAt: previous?.createdAt || timestamp, updatedAt: timestamp };
    for (const field of ["title", "body", "alternatives", "rationale", "evidence", "nextStep"]) {
      entry[field] = text(input[field] ?? previous?.[field], field, { required: field === "title" || field === "body", max: field === "title" ? 1000 : 20000 });
    }
    entry.kind = choose(input.kind ?? previous?.kind ?? "question", KINDS, "기록 종류");
    entry.status = choose(input.status ?? previous?.status ?? "draft", STATUSES, "상태");
    entry.parentId = input.parentId === undefined ? (previous?.parentId || null) : (input.parentId || null);
    if (entry.parentId) {
      let ancestor = find(state.buildUps, entry.parentId, "상위 BuildUp");
      while (ancestor) {
        if (ancestor.id === entry.id) throw new ResearchError("BuildUp 상위 연결에 순환이 생깁니다.");
        ancestor = ancestor.parentId ? find(state.buildUps, ancestor.parentId, "상위 BuildUp") : null;
      }
    }
    entry.paperIds = references(input.paperIds ?? previous?.paperIds ?? [], state.papers, "논문");
    entry.conceptIds = references(input.conceptIds ?? previous?.conceptIds ?? [], state.concepts, "개념");
    entry.skillNames = references(input.skillNames ?? previous?.skillNames ?? [], (skills || []).map(skill => ({ id: skill.name })), "스킬");
    entry.flowRef = previous?.flowRef || null;
    if (input.flowKey !== undefined) {
      if (input.flowKey && (!flow?.flow || flow.key !== input.flowKey)) throw new ResearchError("선택한 공개 Flow가 더 이상 없습니다. 새로고침 후 선택하세요.", 409);
      entry.flowRef = input.flowKey ? {
        key: flow.key, id: flow.flow.id, request: flow.flow.request, status: flow.flow.status,
        skills: flow.flow.skills || [], rows: flow.flow.rows, waves: flow.flow.waves || [],
      } : null;
    }
    const { history: _history, ...oldVersion } = previous || {};
    entry.history = previous ? [...previous.history, oldVersion] : [];
    const index = state.buildUps.findIndex(item => item.id === id);
    if (index < 0) state.buildUps.push(entry); else state.buildUps[index] = entry;
    return entry;
  });
}

export function applyAnalysis(store, revision, result) {
  return store.update(revision, state => {
    const timestamp = now();
    const otherIds = new Set([...state.papers, ...state.buildUps].map(item => item.id));
    if (result.concepts.some(concept => otherIds.has(concept.id))) throw new ResearchError("분석 결과의 개념 ID가 다른 기록과 충돌합니다.");
    for (const concept of result.concepts) {
      if (!state.concepts.some(item => item.id === concept.id)) {
        state.concepts.push({ ...concept, review: "draft", createdAt: timestamp, updatedAt: timestamp });
      }
    }
    validateHierarchy(state.concepts);
    for (const analyzed of result.papers) {
      const paper = find(state.papers, analyzed.id, "논문");
      paper.analysis = Object.fromEntries(["summary", "problem", "method", "findings", "limitations"].map(field => [field, text(analyzed[field], field, { required: true })]));
      paper.analysis.model = result.model;
      paper.analysis.analyzedAt = timestamp;
      paper.conceptLinks = linksFor(analyzed.conceptLinks, paper, state.concepts);
      paper.updatedAt = timestamp;
    }
    return { papers: result.papers.length, concepts: result.concepts.length };
  });
}
