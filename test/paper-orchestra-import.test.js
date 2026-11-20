import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm, symlink, link, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const bridge = fileURLToPath(new URL("../skills/strataa-paper-orchestra/bridge.py", import.meta.url));
const pdf = Buffer.from("%PDF-1.7\nmaterialized fixture, not a typesetting check\n%%EOF\n");
const finalTex = "\\documentclass{article}\n\\input{preamble}\n\\begin{document}\nFinal claim \\citep[Section 2]{known,missing}.\n\\includegraphics{figures/chart.png}\n\\bibliography{references}\n\\end{document}\n";

async function put(root, filename, content) {
  const target = path.join(root, filename);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function fixture(t, tex = finalTex) {
  const root = await mkdtemp(path.join(tmpdir(), "strataa-orchestra-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = path.join(root, "run");
  const out = path.join(root, "handoff");
  await put(run, "final_paper.pdf", pdf);
  await put(run, "content_refinement_workdir/final_refined_paper.tex", tex);
  await put(run, "content_refinement_workdir/references.bib", "@article{known,title={Primary paper}}\n@article{unused,title={Unused registry}}\n");
  await put(run, "content_refinement_workdir/preamble.tex", "\\usepackage{graphicx}\n");
  await put(run, "content_refinement_workdir/conference.sty", "% local style\n");
  await put(run, "content_refinement_workdir/figures/chart.png", Buffer.from([137, 80, 78, 71, 13, 10]));
  await put(run, "content_refinement_workdir/raw_draft_paper.tex", "Historic \\cite{historic}.\n");
  await put(run, "content_refinement_workdir/refined_paper_v1.tex", "Rejected \\cite{rejected}.\n");
  await put(run, "content_refinement_workdir/peer_reviews/review_v1.json", '{"Overall":10,"verdict":"APPROVED"}\n');
  await put(run, "content_refinement_workdir/content_refinement_worklog.json", '{"generated":"log"}\n');
  await put(run, "raw_materials/experimental_log.md", "Narrative accuracy = 0.99.\n");
  return { root, run, out };
}

async function literature(run) {
  await put(run, "literature_agent_output/outline_v1.json", '{"sections":["Related work"]}\n');
  await put(run, "literature_agent_output/citation_map.json", '{"known":{"title":"Candidate"},"unused":{"title":"Not cited"}}\n');
  await put(run, "literature_agent_output/references.bib", "@article{known,title={Candidate}}\n@article{unused,title={Not cited}}\n");
  await put(run, "literature_agent_output/updated_template.tex", "\\section{Related work} Candidate \\cite{known}.\n");
}

async function cli(run, out, extra = [], mode = "draft") {
  try {
    const result = await exec("python3", [bridge, "import", "--mode", mode, "--run", run, "--out", out, ...extra], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

async function files(root, prefix = "") {
  const entries = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name);
    if (item.isDirectory()) entries.push(...await files(path.join(root, item.name), relative));
    else entries.push(relative);
  }
  return entries.sort();
}

async function failedCleanly(f, extra = [], mode = "draft") {
  const result = await cli(f.run, f.out, extra, mode);
  assert.notEqual(result.code, 0, result.stdout);
  await assert.rejects(access(f.out), { code: "ENOENT" });
  assert.equal((await readdir(f.root)).some(name => name.startsWith(".handoff.import-")), false);
  return result;
}

test("draft import selects final artifacts, keeps relative assets, and exposes real evidence gaps", async t => {
  const f = await fixture(t);
  await literature(f.run);
  const raw = await put(f.root, "original/measurements.csv", "seed,accuracy\n1,0.72\n2,0.71\n");
  const source = await put(f.root, "primary/paper.txt", "Actual offline primary-source excerpt.\n");
  const registry = await put(f.root, "primary/sources.json", JSON.stringify({
    known: { id: "10.1234/example", file: "paper.txt", locator: "Section 2, paragraph 3" },
    unused: { id: "arXiv:2401.12345", file: "paper.txt", locator: "p. 7" },
  }));
  const result = await cli(f.run, f.out, ["--raw-result", raw, "--sources", registry]);
  assert.equal(result.code, 0, result.stderr);
  const handoff = JSON.parse(await readFile(path.join(f.out, "HANDOFF.json"), "utf8"));
  assert.deepEqual(JSON.parse(result.stdout), handoff);
  assert.equal(handoff.mode, "draft");
  assert.equal(handoff.artifacts.paper.tex, "paper/main.tex");
  assert.equal(await readFile(path.join(f.out, "paper/main.tex"), "utf8"), finalTex);
  assert.deepEqual(await readFile(path.join(f.out, "paper/main.pdf")), pdf);
  assert.deepEqual(await readFile(path.join(f.out, "results/measurements.csv")), await readFile(raw));
  assert.equal(handoff.sources.known.locator, "Section 2, paragraph 3");
  assert.equal(handoff.sources.known.file, handoff.sources.unused.file);
  assert.deepEqual(await readFile(path.join(f.out, handoff.sources.known.file)), await readFile(source));
  assert.equal((await files(path.join(f.out, "sources/documents"))).length, 1);
  assert.deepEqual(handoff.audits.citations.cited_keys, ["known", "missing"]);
  assert.deepEqual(handoff.audits.citations.unresolved_keys, ["missing"]);
  assert.equal(handoff.audits.citations.evidence_state, "missing_sources");
  assert.equal(handoff.audits.claims.status, "not_reviewed");
  assert.equal(handoff.audits.citations.status, "not_reviewed");
  assert.deepEqual(handoff.audits.claims.gaps, []);
  const imported = await files(f.out);
  for (const required of ["paper/preamble.tex", "paper/conference.sty", "paper/figures/chart.png", "literature/citation_map.json"]) assert.ok(imported.includes(required), required);
  assert.equal(imported.some(name => /raw_draft|refined_paper_v|peer_reviews|worklog|experimental_log/.test(name)), false);
  assert.ok(handoff.gaps.some(gap => /generated review scores are not evidence/.test(gap)));
  assert.equal(await readFile(path.join(f.run, "content_refinement_workdir/raw_draft_paper.tex"), "utf8"), "Historic \\cite{historic}.\n");
});

test("literature import is reusable candidate material, never a manufactured full paper", async t => {
  const f = await fixture(t);
  await literature(f.run);
  const result = await cli(f.run, f.out, [], "literature");
  assert.equal(result.code, 0, result.stderr);
  const handoff = JSON.parse(result.stdout);
  assert.deepEqual(await files(f.out), ["HANDOFF.json", "literature/citation_map.json", "literature/outline_v1.json", "literature/references.bib", "literature/updated_template.tex"]);
  assert.equal("paper" in handoff.artifacts, false);
  assert.equal(handoff.audits.citations.scope, "literature_candidates_only");
  assert.equal(handoff.audits.citations.evidence_state, "not_applicable");
  assert.ok(handoff.audits.claims.gaps.some(gap => /No original raw result/.test(gap)));
});

test("no citations is distinct from missing evidence; commented and historic citations do not leak", async t => {
  const f = await fixture(t, "\\begin{document}No citations. % \\cite{commented}\n\\end{document}\n");
  const result = await cli(f.run, f.out);
  assert.equal(result.code, 0, result.stderr);
  const handoff = JSON.parse(result.stdout);
  assert.equal(handoff.audits.citations.evidence_state, "no_citations");
  assert.deepEqual(handoff.audits.citations.cited_keys, []);
  assert.deepEqual(handoff.audits.citations.unresolved_keys, []);
});

test("wildcards without literal citations are not reported as a citation-free paper", async t => {
  const f = await fixture(t, "\\begin{document}\\nocite{*}\\end{document}");
  const result = await cli(f.run, f.out);
  assert.equal(result.code, 0, result.stderr);
  const audit = JSON.parse(result.stdout).audits.citations;
  assert.equal(audit.evidence_state, "partial_static_scan");
  assert.ok(audit.gaps.some(gap => /wildcard/i.test(gap)));
});

test("reachable final TeX citations are audited, without requiring unused registry entries", async t => {
  const f = await fixture(t, "\\input{sections/result}\n");
  await put(f.run, "content_refinement_workdir/sections/result.tex", "Evidence \\cite{actual}.\n");
  const source = await put(f.root, "sources/paper.md", "# Actual paper\nPrimary passage.\n");
  const registry = await put(f.root, "sources/index.json", JSON.stringify({ actual: { id: "https://publisher.example/paper", file: path.basename(source), locator: "Results" } }));
  const result = await cli(f.run, f.out, ["--sources", registry]);
  assert.equal(result.code, 0, result.stderr);
  const handoff = JSON.parse(result.stdout);
  assert.deepEqual(handoff.audits.citations.cited_keys, ["actual"]);
  assert.deepEqual(handoff.audits.citations.unresolved_keys, []);
  assert.equal(handoff.audits.citations.evidence_state, "sources_supplied");
  assert.deepEqual(handoff.audits.citations.missing_bib_keys, ["actual"]);
  assert.equal(await readFile(path.join(f.out, "paper/sections/result.tex"), "utf8"), "Evidence \\cite{actual}.\n");
});

test("missing, empty, invalid and incomplete materialized outputs fail without a handoff", async t => {
  const cases = [
    ["missing final TeX", f => rm(path.join(f.run, "content_refinement_workdir/final_refined_paper.tex"))],
    ["blank final TeX", f => put(f.run, "content_refinement_workdir/final_refined_paper.tex", " \n")],
    ["missing canonical PDF", f => rm(path.join(f.run, "final_paper.pdf"))],
    ["invalid canonical PDF", f => put(f.run, "final_paper.pdf", "not a PDF")],
    ["missing matching bibliography", f => rm(path.join(f.run, "content_refinement_workdir/references.bib"))],
    ["missing figure dependency", f => rm(path.join(f.run, "content_refinement_workdir/figures/chart.png"))],
    ["missing TeX dependency", f => rm(path.join(f.run, "content_refinement_workdir/preamble.tex"))],
  ];
  for (const [name, change] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    await change(f);
    await failedCleanly(f);
  });
  await t.test("incomplete literature outputs", async t => {
    const f = await fixture(t);
    await literature(f.run);
    await rm(path.join(f.run, "literature_agent_output/updated_template.tex"));
    await failedCleanly(f, [], "literature");
  });
  await t.test("malformed candidate JSON", async t => {
    const f = await fixture(t);
    await literature(f.run);
    await put(f.run, "literature_agent_output/citation_map.json", "not json");
    await failedCleanly(f, [], "literature");
  });
  for (const [name, file, content] of [
    ["empty candidates", "citation_map.json", "{}"],
    ["no candidate BibTeX entries", "references.bib", "% bibliography not generated"],
    ["candidate missing from bibliography", "references.bib", "@article{unrelated,title={Different work}}"],
  ]) await t.test(name, async t => {
    const f = await fixture(t);
    await literature(f.run);
    await put(f.run, `literature_agent_output/${file}`, content);
    await failedCleanly(f, [], "literature");
  });
});

test("fresh destinations reject even existing empty directories without modifying them", async t => {
  const f = await fixture(t);
  await mkdir(f.out);
  const result = await cli(f.run, f.out);
  assert.notEqual(result.code, 0);
  assert.deepEqual(await readdir(f.out), []);
  await put(f.out, "sentinel", "keep");
  const retry = await cli(f.run, f.out);
  assert.notEqual(retry.code, 0);
  assert.equal(await readFile(path.join(f.out, "sentinel"), "utf8"), "keep");
});

test("run symlinks, TeX traversal and asset destination collisions are rejected", async t => {
  for (const kind of ["symlink", "traversal", "collision"]) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === "symlink") {
      const external = await put(f.root, "external.png", "external");
      await symlink(external, path.join(f.run, "content_refinement_workdir/figures/linked.png"));
    } else if (kind === "traversal") {
      await put(f.root, "outside.tex", "outside");
      await put(f.run, "content_refinement_workdir/final_refined_paper.tex", "\\input{../outside}\n");
    } else {
      await put(f.run, "content_refinement_workdir/final_refined_paper.tex", "\\input{main.tex}\n");
      await put(f.run, "content_refinement_workdir/main.tex", "another manuscript\n");
    }
    await failedCleanly(f);
  });
});

test("raw evidence accepts original structured files only and rejects collisions or generated relabeling", async t => {
  for (const kind of ["narrative", "generated", "hardlinked-generated", "collision", "symlink", "malformed"]) await t.test(kind, async t => {
    const f = await fixture(t);
    let raw;
    let extra = [];
    const generated = path.join(f.run, "content_refinement_workdir/content_refinement_worklog.json");
    if (kind === "narrative") raw = path.join(f.run, "raw_materials/experimental_log.md");
    if (kind === "generated") raw = generated;
    if (kind === "hardlinked-generated") {
      raw = path.join(f.root, "claimed-original.json");
      await link(generated, raw);
    }
    if (kind === "collision") {
      raw = await put(f.root, "first/data.csv", "x\n1\n");
      const other = await put(f.root, "second/data.csv", "x\n2\n");
      extra = ["--raw-result", other];
    }
    if (kind === "symlink") {
      const target = await put(f.root, "data.csv", "x\n1\n");
      raw = path.join(f.root, "linked.csv");
      await symlink(target, raw);
    }
    if (kind === "malformed") raw = await put(f.root, "data.jsonl", '{"x":1}\nnot json\n');
    await failedCleanly(f, ["--raw-result", raw, ...extra]);
  });
});

test("all supported original result formats retain their original bytes", async t => {
  const f = await fixture(t);
  const originals = new Map([
    ["data.csv", "a,b\r\n1,2\r\n"], ["data.tsv", "a\tb\n1\t2\n"],
    ["data.json", '{"runs":[1,2]}\n'], ["data.jsonl", '{"seed":1}\n{"seed":2}\n'],
  ]);
  const extra = [];
  for (const [name, content] of originals) extra.push("--raw-result", await put(f.root, `original/${name}`, content));
  // Independently supplied original data is not rejected merely for matching bytes.
  await put(f.run, "outline.json", '{"runs":[1,2]}\n');
  const result = await cli(f.run, f.out, extra);
  assert.equal(result.code, 0, result.stderr);
  for (const [name, content] of originals) assert.equal(await readFile(path.join(f.out, "results", name), "utf8"), content);
});

test("source registries reject invalid identifiers, missing documents, traversal and symlinks", async t => {
  for (const kind of ["missing", "traversal", "absolute", "symlink", "parent-symlink", "identifier", "locator", "invalid-pdf", "invalid-utf8", "not-object", "duplicate-key"]) await t.test(kind, async t => {
    const f = await fixture(t);
    await put(f.root, "primary/paper.txt", "Primary text.\n");
    let item = { id: "10.1234/example", file: "paper.txt", locator: "p. 2" };
    if (kind === "missing") item.file = "missing.txt";
    if (kind === "traversal") {
      await put(f.root, "outside.txt", "outside");
      item.file = "../outside.txt";
    }
    if (kind === "absolute") item.file = path.join(f.root, "primary/paper.txt");
    if (kind === "symlink") {
      await symlink(path.join(f.root, "primary/paper.txt"), path.join(f.root, "primary/linked.txt"));
      item.file = "linked.txt";
    }
    if (kind === "parent-symlink") {
      await mkdir(path.join(f.root, "external"));
      await put(f.root, "external/paper.txt", "outside");
      await symlink(path.join(f.root, "external"), path.join(f.root, "primary/linked"));
      item.file = "linked/paper.txt";
    }
    if (kind === "identifier") item.id = "a generated paper title";
    if (kind === "locator") item.locator = "";
    if (kind === "invalid-pdf") {
      await put(f.root, "primary/paper.pdf", "not PDF");
      item.file = "paper.pdf";
    }
    if (kind === "invalid-utf8") await put(f.root, "primary/paper.txt", Buffer.from([255, 254]));
    let json = JSON.stringify({ known: item });
    if (kind === "not-object") json = "[]";
    if (kind === "duplicate-key") json = `{"known":${JSON.stringify(item)},"known":${JSON.stringify(item)}}`;
    const registry = await put(f.root, "primary/sources.json", json);
    await failedCleanly(f, ["--sources", registry]);
  });
});

test("copy failures return nonzero and clean staged and destination files", { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  const bibliography = path.join(f.run, "content_refinement_workdir/references.bib");
  await chmod(bibliography, 0);
  await failedCleanly(f);
});

test("failed or interrupted generation receipts prevent import despite complete-looking artifacts", async t => {
  for (const status of ["failed", "in_progress", "unknown"]) await t.test(status, async t => {
    const f = await fixture(t);
    await put(f.run, "strataa-generation.json", JSON.stringify({ status, mode: "draft" }));
    await failedCleanly(f);
  });
  await t.test("literature receipt cannot certify a draft run", async t => {
    const f = await fixture(t);
    await put(f.run, "strataa-generation.json", JSON.stringify({ status: "completed", mode: "literature" }));
    await failedCleanly(f);
  });
  await t.test("malformed receipt", async t => {
    const f = await fixture(t);
    await put(f.run, "strataa-generation.json", "not json");
    await failedCleanly(f);
  });
});

test("a completed draft receipt supports draft and literature handoffs without copying receipt metadata", async t => {
  const f = await fixture(t);
  await literature(f.run);
  const receipt = await put(f.run, "strataa-generation.json", JSON.stringify({ status: "completed", mode: "draft", writerModelOverride: "operator-chosen" }));
  const result = await cli(f.run, f.out);
  assert.equal(result.code, 0, result.stderr);
  const handoff = JSON.parse(result.stdout);
  assert.equal(handoff.generation_receipt, receipt);
  assert.equal(JSON.stringify(handoff).includes("operator-chosen"), false);
  const literatureOut = path.join(f.root, "literature-handoff");
  const candidates = await cli(f.run, literatureOut, [], "literature");
  assert.equal(candidates.code, 0, candidates.stderr);
  assert.equal(JSON.parse(candidates.stdout).generation_receipt, receipt);
});
