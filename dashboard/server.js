import http from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStore, addPaper, savePaper, saveConcept, saveBuildUp, applyAnalysis, ResearchError } from "./store.js";
import { paperSource, MAX_FILE_BYTES, pdfAvailable } from "./uploads.js";
import { paperMarkdown, buildUpMarkdown } from "./export.js";
import { getArisCatalog, loadArisSkills } from "../aris-skills.js";
import { readFlowSessions } from "../flow-store.js";
import { readModelConfig } from "../model-config.js";
import { extractPaperMetadata, metadataSource, METADATA_CAPABILITY } from "./metadata.js";
import { createProjectRegistry } from "./projects.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_SKILL = { name: "strataa-project", description: "프로젝트의 근거·Top-down·BuildUp을 .strataa/project.json에 기록하고 디렉터리로 연결합니다." };
const PUBLIC = new Map([
  ["/", ["project.html", "text/html"]], ["/project-app.js", ["project-app.js", "text/javascript"]], ["/project.css", ["project.css", "text/css"]],
  ["/library", ["index.html", "text/html"]], ["/app.js", ["app.js", "text/javascript"]], ["/style.css", ["style.css", "text/css"]],
]);

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function download(res, name, type, body) {
  res.writeHead(200, { "Content-Type": type, "Content-Disposition": `attachment; filename="${name}"` });
  res.end(body);
}
async function requestBody(req) {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new ResearchError("application/json 요청이 필요합니다.", 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 1024 * 1024) throw new ResearchError("요청 본문이 너무 큽니다. 파일별로 추가하세요.", 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ResearchError("JSON 본문을 읽을 수 없습니다."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ResearchError("JSON 객체가 필요합니다.");
  return body;
}
function lookup(items, id) {
  const value = items.find(item => item.id === id);
  if (!value) throw new ResearchError("기록을 찾을 수 없습니다.", 404);
  return value;
}

export function createDashboard({ directory, analyzer, metadataExtractor, flowDirectory, modelConfig = readModelConfig } = {}) {
  const dataDirectory = directory || process.env.STRATAA_RESEARCH_DIR || path.join(process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "omp-agent-dialogue", "research");
  const store = createStore(dataDirectory);
  const projects = createProjectRegistry(dataDirectory);
  const skills = [...getArisCatalog(), LOCAL_SKILL];
  const capabilities = { pdf: pdfAvailable(), maxFileBytes: MAX_FILE_BYTES, maxAnalysisChars: 180000, metadata: METADATA_CAPABILITY };
  const flows = () => readFlowSessions(flowDirectory ? { directory: flowDirectory } : {});
  let pending = null, abort = null;
  let metadataPending = null, metadataAbort = null;
  if (store.job().status === "running") store.saveJob({ ...store.job(), status: "failed", error: "이전 서버가 분석 도중 종료되었습니다. 자동 재실행하지 않았습니다.", finishedAt: new Date().toISOString() });
  const stateResponse = () => ({ ...store.read(), skills, flows: flows(), analysisJob: store.job(), capabilities: { ...capabilities, ...modelConfig().analysis } });
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const host = req.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) throw new ResearchError("로컬 Dashboard 주소로 접속하세요.", 403);
      if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers["sec-fetch-site"] === "cross-site") throw new ResearchError("다른 출처의 요청을 허용하지 않습니다.", 403);
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      if (req.method === "GET") {
        if (route === "/api/projects") return json(res, 200, { projects: await projects.list() });
        const projectMatch = route.match(/^\/api\/projects\/([^/]+)$/);
        if (projectMatch) return json(res, 200, await projects.get(projectMatch[1]));
        if (route === "/api/state") return json(res, 200, stateResponse());
        if (route === "/api/export") return download(res, "strataa-research.json", "application/json; charset=utf-8", JSON.stringify({ ...store.read(), analysisJob: store.job() }, null, 2));
        const match = route.match(/^\/api\/(papers|buildup|skills)\/([^/]+)(?:\/(export|pdf))?$/);
        if (match) {
          const [, kind, id, action] = match;
          if (kind === "skills" && !action) {
            if (!skills.some(skill => skill.name === id)) throw new ResearchError("알 수 없는 스킬입니다.", 404);
            const content = id === LOCAL_SKILL.name ? await readFile(path.join(root, "../skills/strataa-project/SKILL.md"), "utf8") : loadArisSkills([id])[0].content;
            return json(res, 200, { name: id, content });
          }
          const state = store.read();
          if (kind === "papers" && action) {
            const paper = lookup(state.papers, id);
            if (action === "pdf") {
              const bytes = store.original(id);
              if (!bytes) throw new ResearchError("저장된 PDF 원본이 없습니다.", 404);
              return download(res, `${id}.pdf`, "application/pdf", Buffer.from(bytes));
            }
            return download(res, `${id}.md`, "text/markdown; charset=utf-8", paperMarkdown(paper, state));
          }
          if (kind === "buildup" && action === "export") return download(res, `${id}.md`, "text/markdown; charset=utf-8", buildUpMarkdown(lookup(state.buildUps, id), state));
        }
        if (PUBLIC.has(route)) {
          const [file, type] = PUBLIC.get(route);
          const bytes = await readFile(path.join(root, "public", file));
          res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
          return res.end(bytes);
        }
      } else if (req.method === "DELETE" && /^\/api\/projects\/[^/]+$/.test(route)) {
        await requestBody(req);
        await projects.disconnect(route.split("/").at(-1));
        return json(res, 200, { ok: true });
      } else if (["POST", "PUT"].includes(req.method)) {
        const input = await requestBody(req);
        if (route === "/api/projects") {
          if (req.method !== "POST") throw new ResearchError("프로젝트 연결은 POST 요청이 필요합니다.", 405);
          return json(res, 201, await projects.connect(input.path));
        }
        if (route === "/api/metadata") {
          if (req.method !== "POST") throw new ResearchError("메타데이터 추출은 POST 요청이 필요합니다.", 405);
          if (metadataPending) throw new ResearchError("메타데이터 추출이 이미 진행 중입니다.", 409);
          const controller = new AbortController();
          metadataAbort = controller;
          const disconnected = () => { if (!res.writableEnded) controller.abort(); };
          res.once("close", disconnected);
          metadataPending = Promise.resolve().then(async () => {
            const source = await metadataSource(input);
            if (controller.signal.aborted) throw new ResearchError("메타데이터 추출 요청이 중단되었습니다.");
            return (metadataExtractor || extractPaperMetadata)({ ...source, signal: controller.signal });
          });
          try {
            const result = await metadataPending;
            if (!res.destroyed) return json(res, 200, result);
            return;
          } finally {
            res.removeListener("close", disconnected);
            metadataPending = null;
            metadataAbort = null;
          }
        }
        const before = store.read();
        if (input.revision !== before.revision) throw new ResearchError("다른 저장이 먼저 반영되었습니다. 새로고침 후 다시 저장하세요. 입력은 유지됩니다.", 409);
        if (route === "/api/papers" && req.method === "POST") return json(res, 201, addPaper(store, input, await paperSource(input)));
        const match = route.match(/^\/api\/(papers|concepts|buildup)(?:\/([^/]+))?$/);
        if (match) {
          const [, kind, id] = match;
          if ((id && req.method !== "PUT") || (!id && req.method !== "POST")) throw new ResearchError("잘못된 저장 방식입니다.", 405);
          if (kind === "papers" && id) return json(res, 200, savePaper(store, id, input));
          if (kind === "concepts") return json(res, id ? 200 : 201, saveConcept(store, id, input));
          if (kind === "buildup") {
            const flow = input.flowKey ? flows().find(item => item.key === input.flowKey) : null;
            return json(res, id ? 200 : 201, saveBuildUp(store, id, input, { skills, flow }));
          }
        }
        if (route === "/api/analyze" && req.method === "POST") {
          if (pending) throw new ResearchError("분석이 이미 진행 중입니다.", 409);
          if (!Array.isArray(input.paperIds) || !input.paperIds.length || new Set(input.paperIds).size !== input.paperIds.length) throw new ResearchError("분석할 논문을 중복 없이 선택하세요.");
          const papers = input.paperIds.map(id => lookup(before.papers, id));
          const analysis = await import("./analysis.js");
          if (pending || store.read().revision !== before.revision) throw new ResearchError("분석 준비 중 저장 상태가 바뀌었습니다. 새로고침 후 다시 시도하세요.", 409);
          analysis.buildAnalysisPrompt(papers, before.concepts); // Fail before acknowledging an oversized request.
          const { model, reasoning } = modelConfig().analysis;
          if (input.model !== model || input.reasoning !== reasoning) throw new ResearchError("분석 모델 설정이 바뀌었습니다. 새로고침 후 모델·추론 강도를 확인하고 다시 동의하세요.", 409);
          const job = { status: "running", model, reasoning, paperIds: input.paperIds, startedAt: new Date().toISOString(), error: null };
          store.saveJob(job);
          abort = new AbortController();
          pending = Promise.resolve().then(() => (analyzer || analysis.analyzePapers)({ papers, concepts: before.concepts, model, reasoning, signal: abort.signal }))
            .then(result => {
              applyAnalysis(store, before.revision, result);
              store.saveJob({ ...job, status: "completed", finishedAt: new Date().toISOString() });
            })
            .catch(error => store.saveJob({ ...job, status: "failed", error: error.message, finishedAt: new Date().toISOString() }))
            .finally(() => { pending = null; abort = null; });
          return json(res, 202, job);
        }
      }
      throw new ResearchError("페이지 또는 API를 찾을 수 없습니다.", 404);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) json(res, error.status || 500, { error: error.message });
      else if (!res.destroyed) res.end();
    }
  });
  const close = server.close;
  server.close = function (...args) {
    metadataAbort?.abort();
    return close.apply(this, args);
  };
  server.on("close", () => {
    abort?.abort();
    metadataAbort?.abort();
    if (pending) pending.finally(() => store.close()); else store.close();
  });
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.STRATAA_DASHBOARD_PORT || 4310);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("STRATAA_DASHBOARD_PORT must be 1–65535");
  const { server, store } = createDashboard();
  server.on("error", error => { console.error(error.message); process.exitCode = 1; server.close(); });
  server.listen(port, "127.0.0.1", () => console.log(`Strataa Dashboard: http://127.0.0.1:${server.address().port}\nStore: ${store.file}`));
  process.once("SIGINT", () => server.close());
  process.once("SIGTERM", () => server.close());
}
