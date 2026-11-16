import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDashboard } from "../dashboard/server.js";
import { createStore } from "../dashboard/store.js";
import { pdfAvailable } from "../dashboard/uploads.js";

async function serve(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "strataa-dashboard-test-"));
  const app = createDashboard({ directory, flowDirectory: path.join(directory, "flows"), ...options });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await new Promise(resolve => app.server.close(resolve)); } };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  const state = async () => (await fetch(`${base}/api/state`)).json();
  const request = async (route, body, method = "POST", extraHeaders = {}) => {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  };
  const save = async (route, body, method) => {
    const response = await request(route, { revision: (await state()).revision, ...body }, method);
    assert.ok(response.status === 200 || response.status === 201, JSON.stringify(response));
    return response.value;
  };
  return { ...app, base, directory, state, request, save, stop };
}
const source = "We study machine learning and retrieval. We compare dense retrieval using contrastive learning. We report recall improvements on our dataset.";
const levels = ["field", "problem", "method", "technique"];
async function hierarchy(app) {
  const concepts = [];
  for (const [index, level] of levels.entries()) concepts.push(await app.save("/api/concepts", { name: ["Learning", "Retrieval", "Dense retrieval", "Contrastive learning"][index], description: level, level, parentId: concepts.at(-1)?.id || null, review: "draft" }));
  return concepts;
}
function analysisResult(papers) {
  const concepts = levels.map((level, index) => ({ id: `shared-${level}`, name: ["Learning", "Retrieval", "Dense retrieval", "Contrastive learning"][index], description: level, level, parentId: index ? `shared-${levels[index - 1]}` : null }));
  return { model: "openai-codex/gpt-6-astra", concepts, papers: papers.map(paper => ({ id: paper.id, summary: "Retrieval study", problem: "Retrieval quality", method: "Dense retrieval", findings: "Reported recall improvements", limitations: "Dataset-specific; no general claim", conceptLinks: concepts.map(concept => ({ conceptId: concept.id, quote: "We compare dense retrieval using contrastive learning.", note: "Reported method" })) })) };
}
async function waitJob(app) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await app.state();
    if (state.analysisJob.status !== "running") return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("analysis job did not settle");
}

test("paper-specific evidence, shared concepts and versioned BuildUp survive reopening and export", async t => {
  const app = await serve(t);
  const first = await app.save("/api/papers", { title: "First paper", text: source, sourceUrl: "https://example.org/first" });
  const second = await app.save("/api/papers", { file: { name: "second.md", base64: Buffer.from(source + " A separate comparison.").toString("base64") } });
  const concepts = await hierarchy(app);
  for (const paper of [first, second]) await app.save(`/api/papers/${paper.id}`, { conceptLinks: concepts.map(concept => ({ conceptId: concept.id, quote: "We compare dense retrieval using contrastive learning.", note: paper.id })) }, "PUT");
  const question = await app.save("/api/buildup", { title: "Transfer question", body: "Does retrieval generalize?", kind: "question", paperIds: [first.id], conceptIds: [concepts[1].id], skillNames: ["research-refine"] });
  const decision = await app.save("/api/buildup", { title: "Measure transfer", body: "Use held-out data", kind: "decision", parentId: question.id, alternatives: "Same dataset vs held-out dataset", rationale: "Separate memorization from transfer", evidence: "Not yet measured", nextStep: "Define split", paperIds: [first.id, second.id], conceptIds: [concepts[3].id], skillNames: ["experiment-plan"] });
  await app.save(`/api/buildup/${decision.id}`, { title: decision.title, body: "Use held-out-domain data", evidence: "Split defined", status: "active" }, "PUT");
  const md = await (await fetch(`${app.base}/api/papers/${first.id}/export`)).text();
  assert.ok(md.includes("Learning → Retrieval → Dense retrieval → Contrastive learning"));
  assert.ok(md.includes(first.id) && md.includes("Measure transfer") && md.includes(source));
  const exported = await (await fetch(`${app.base}/api/buildup/${decision.id}/export`)).text();
  assert.ok(exported.includes("Same dataset vs held-out dataset") && exported.includes("Not yet measured"));
  await app.stop();
  const reopened = createStore(app.directory);
  try {
    const state = reopened.read();
    assert.equal(state.papers[0].conceptLinks[3].conceptId, state.papers[1].conceptLinks[3].conceptId);
    assert.equal(state.buildUps[1].parentId, question.id);
    assert.equal(state.buildUps[1].history[0].body, "Use held-out data");
    assert.equal(state.buildUps[1].body, "Use held-out-domain data");
    assert.deepEqual(state.buildUps[1].skillNames, ["experiment-plan"]);
  } finally { reopened.close(); }
});

test("invalid evidence, broken hierarchy and stale edits cannot partially overwrite research", async t => {
  const app = await serve(t);
  const paper = await app.save("/api/papers", { title: "Evidence", text: source, notes: "Keep this" });
  const concepts = await hierarchy(app);
  const revision = (await app.state()).revision;
  const invalid = await app.request(`/api/papers/${paper.id}`, { revision, notes: "Do not save", conceptLinks: [{ conceptId: concepts[0].id, quote: "This text is only in another paper", note: "invalid" }] }, "PUT");
  assert.equal(invalid.status, 400);
  assert.equal((await app.state()).papers[0].notes, "Keep this");
  assert.equal((await app.state()).revision, revision);
  const cycle = await app.request(`/api/concepts/${concepts[0].id}`, { revision, ...concepts[0], parentId: concepts[3].id }, "PUT");
  assert.equal(cycle.status, 400);
  await app.save(`/api/papers/${paper.id}`, { notes: "New version" }, "PUT");
  const stale = await app.request(`/api/papers/${paper.id}`, { revision, notes: "Old tab" }, "PUT");
  assert.equal(stale.status, 409);
  assert.equal((await app.state()).papers[0].notes, "New version");
  const parent = await app.save("/api/buildup", { title: "Parent", body: "Question" });
  const child = await app.save("/api/buildup", { title: "Child", body: "Hypothesis", parentId: parent.id });
  const loop = await app.request(`/api/buildup/${parent.id}`, { revision: (await app.state()).revision, parentId: child.id }, "PUT");
  assert.equal(loop.status, 400);
  assert.equal((await app.state()).buildUps[0].parentId, null);
});

test("local origin and JSON boundaries reject cross-site writes and DNS rebinding", async t => {
  const app = await serve(t);
  const body = { revision: 0, title: "Unwanted", text: source };
  assert.equal((await app.request("/api/papers", body, "POST", { Origin: "https://attacker.example" })).status, 403);
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${app.base}/api/papers`, { method: "POST", headers: { Host: "attacker.example", "Content-Type": "application/json" } }, res => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
  assert.equal(rebindingStatus, 403);
  assert.equal((await app.request("/api/papers", body, "POST", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await app.state()).papers.length, 0);
  const injected = await app.request("/api/papers", { ...body, sourceUrl: "javascript:alert(1)" });
  assert.equal(injected.status, 400);
  assert.equal((await app.state()).revision, 0);
});

test("analysis stores grounded shared paths atomically and does not replace user edits made in flight", async t => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const app = await serve(t, { analyzer: async ({ papers }) => { await delayed; return analysisResult(papers); } });
  const first = await app.save("/api/papers", { title: "A", text: source });
  const second = await app.save("/api/papers", { title: "B", text: source });
  const revision = (await app.state()).revision;
  assert.equal((await app.request("/api/analyze", { revision, paperIds: [first.id, second.id] })).status, 202);
  assert.equal((await app.request("/api/analyze", { revision, paperIds: [first.id] })).status, 409);
  await app.save(`/api/papers/${first.id}`, { notes: "Human edited while model worked" }, "PUT");
  release();
  const rejected = await waitJob(app);
  assert.equal(rejected.analysisJob.status, "failed");
  assert.equal(rejected.concepts.length, 0);
  assert.equal(rejected.papers[0].analysis, null);
  assert.equal(rejected.papers[0].notes, "Human edited while model worked");
  assert.equal((await app.request("/api/analyze", { revision: rejected.revision, paperIds: [first.id, second.id] })).status, 202);
  const finished = await waitJob(app);
  assert.equal(finished.analysisJob.status, "completed", finished.analysisJob.error);
  assert.equal(finished.papers[0].analysis.model, "openai-codex/gpt-6-astra");
  assert.equal(finished.papers[0].conceptLinks[3].conceptId, finished.papers[1].conceptLinks[3].conceptId);
  assert.ok(finished.concepts.every(concept => concept.review === "draft"));
});

test("captured public flow remains linked after its publisher disappears", async t => {
  const app = await serve(t);
  const dir = path.join(app.directory, "flows");
  await mkdir(dir);
  const record = { version: 1, key: "fixture", pid: process.pid, sessionId: "fixture-session", cwd: app.directory, updatedAt: Date.now(), flow: { version: 1, id: "fixture-run", request: "Compare alternatives", status: "completed", rows: [], skills: ["research-refine"] } };
  await writeFile(path.join(dir, "fixture.json"), JSON.stringify(record));
  const entry = await app.save("/api/buildup", { title: "Flow reasoning", body: "Public evidence only", flowKey: "fixture", skillNames: ["research-refine"] });
  await rm(path.join(dir, "fixture.json"));
  const state = await app.state();
  assert.equal(state.flows.length, 0);
  assert.equal(state.buildUps[0].flowRef.id, "fixture-run");
  assert.equal(state.buildUps[0].flowRef.request, "Compare alternatives");
  const edited = await app.save(`/api/buildup/${entry.id}`, { body: "Refined public evidence" }, "PUT");
  assert.equal(edited.flowRef.id, "fixture-run");
  assert.equal(edited.history[0].flowRef.id, "fixture-run");
});

function pdfBytes() {
  const stream = "BT /F1 12 Tf 30 750 Td (Dense retrieval using contrastive learning.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n `).join("\n")}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test("PDF import extracts actual text and preserves original bytes", { skip: !pdfAvailable() && "pdftotext not installed" }, async t => {
  const app = await serve(t);
  const bytes = pdfBytes();
  const paper = await app.save("/api/papers", { file: { name: "retrieval.pdf", base64: bytes.toString("base64") } });
  assert.equal(paper.text, "Dense retrieval using contrastive learning.");
  const original = await fetch(`${app.base}/api/papers/${paper.id}/pdf`);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), bytes);
});
