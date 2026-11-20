import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../skills/strataa-paper-orchestra/bridge.py", import.meta.url));

// Temporary deterministic Python doubles expose the real pinned API signatures.
// These tests do not import Google code, contact providers, or generate a real paper.
const recorder = String.raw`
import json
import os
from pathlib import Path

def record(event, **data):
    with open(os.environ["TEST_ONLY_AUDIT"], "a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": event, **data}) + "\n")

def boundary(idea, log):
    root = Path(idea).parent
    return {
        "files": sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()),
        "idea": Path(idea).read_text(),
        "log": Path(log).read_text(),
        "cwd_resource": Path("resource.txt").read_text(),
    }
`;
const writer = String.raw`
from pathlib import Path
import os
from methods.fixture import record, boundary

record("writer-import")

def write_single_paper(base_dir, latex_template_dir, idea_filename="idea_dense.md",
                       experimental_log_filename="experimental_log.md",
                       writer_model_name="gemini-3.1-pro-preview",
                       reflection_model_name="gemini-3.1-pro-preview",
                       research_cutoff="2024-11"):
    base = Path(base_dir)
    raw = base / "raw_materials"
    record("draft-provider", writer=writer_model_name, reflection=reflection_model_name,
           cutoff=research_cutoff, template=str(Path(latex_template_dir).resolve()),
           **boundary(raw / idea_filename, raw / experimental_log_filename))
    print("test-only upstream writer output")
    behavior = os.environ.get("TEST_ONLY_BEHAVIOR", "success")
    if behavior == "raise":
        raise RuntimeError("TEST_ONLY unavailable provider; do not substitute")
    if behavior == "false":
        return False
    refined = base / "content_refinement_workdir"
    refined.mkdir()
    (base / "final_paper.pdf").write_bytes(b"%PDF-1.4 test-only fixture")
    (refined / "final_refined_paper.pdf").write_bytes(b"%PDF-1.4 test-only fixture")
    if behavior == "wrong-pdf":
        (base / "final_paper.pdf").write_bytes(b"upstream error, not a PDF")
    (refined / "final_refined_paper.tex").write_text(r"\documentclass{article}\begin{document}Test only\end{document}")
    (refined / "references.bib").write_text("@article{Fixture2024, title={Test only}, year={2024}}")
    if behavior == "missing-tex":
        (refined / "final_refined_paper.tex").unlink()
    if behavior == "empty-pdf":
        (base / "final_paper.pdf").write_bytes(b"")
    if behavior == "missing-bib":
        (refined / "references.bib").unlink()
    return True
`;
const outline = String.raw`
from pathlib import Path
import json
from methods.fixture import record, boundary

class OutlineAgent:
    def __init__(self, model_name="gemini-3.1-pro-preview", cutoff_date="2024-10"):
        self.model = model_name
        self.cutoff = cutoff_date

    def run(self, idea_file, experimental_log_file, latex_template_file,
            conference_guidelines_file, output_filepath=None):
        record("outline-provider", writer=self.model, cutoff=self.cutoff,
               template=Path(latex_template_file).read_text(),
               guidelines=Path(conference_guidelines_file).read_text(),
               **boundary(idea_file, experimental_log_file))
        result = {"section_plan": [{"section_title": "Introduction"}]}
        Path(output_filepath).write_text(json.dumps(result))
        return result
`;
const literature = String.raw`
from pathlib import Path
import json
import os
from methods.fixture import record, boundary

class HybridLiteratureAgent:
    def __init__(self, idea_path, experimental_log_path, latex_template_path,
                 conference_guidelines_path, output_dir,
                 model_name="gemini-3.1-pro-preview", max_workers=5):
        self.destination = Path(output_dir)
        self.destination.mkdir()
        self.model = model_name
        self.payload = boundary(idea_path, experimental_log_path)
        self.template = Path(latex_template_path).read_text()
        self.guidelines = Path(conference_guidelines_path).read_text()

    def run(self, outline_path, cutoff_date=None):
        record("literature-provider", writer=self.model, cutoff=cutoff_date,
               outline=json.loads(Path(outline_path).read_text()), **self.payload)
        behavior = os.environ.get("TEST_ONLY_BEHAVIOR", "success")
        if behavior == "raise":
            raise RuntimeError("TEST_ONLY literature provider unavailable")
        dest = self.destination
        (dest / "outline_v1.json").write_text(Path(outline_path).read_text())
        (dest / "citation_map.json").write_text(json.dumps({"Fixture2024": {"citation_key": "Fixture2024", "title": "Test only", "abstract": "Deterministic fixture"}}))
        (dest / "references.bib").write_text("@article{Fixture2024, title={Test only}, year={2024}}")
        (dest / "updated_template.tex").write_text(r"\section{Related Work}Test only \cite{Fixture2024}")
        print("test-only upstream literature output")
        if behavior == "bad-json":
            (dest / "outline_v1.json").write_text("not JSON")
        if behavior == "empty-map":
            (dest / "citation_map.json").write_text("{}")
        if behavior == "empty-bib":
            (dest / "references.bib").write_text("")
        if behavior == "missing-tex":
            (dest / "updated_template.tex").unlink()
`;

async function exists(filename) {
  try { await access(filename); return true; } catch { return false; }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "strataa-orchestra-generation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "trusted-checkout");
  const materials = path.join(root, "approved-materials");
  const template = path.join(root, "template");
  await mkdir(path.join(checkout, "methods/agents"), { recursive: true });
  await mkdir(path.join(materials, "figures"), { recursive: true });
  await mkdir(template);
  await Promise.all([
    writeFile(path.join(checkout, "methods/__init__.py"), "from methods.fixture import record\nrecord('external-import')\n"),
    writeFile(path.join(checkout, "methods/agents/__init__.py"), ""),
    writeFile(path.join(checkout, "methods/fixture.py"), recorder),
    writeFile(path.join(checkout, "methods/paper_writer.py"), writer),
    writeFile(path.join(checkout, "methods/agents/outline_agent.py"), outline),
    writeFile(path.join(checkout, "methods/agents/literature_review_agent.py"), literature),
    writeFile(path.join(checkout, "resource.txt"), "checkout-local-resource"),
    writeFile(path.join(materials, "idea_sparse.md"), "# Approved idea\nAn explicitly supplied idea.\n"),
    writeFile(path.join(materials, "experimental_log.md"), "# Approved experimental log\nNo new experiment is asserted.\n"),
    writeFile(path.join(materials, "figures/info.json"), JSON.stringify([{ name: "approved.png", caption: "Approved supplied figure" }])),
    writeFile(path.join(materials, "figures/approved.png"), Buffer.from("test-only image bytes")),
    writeFile(path.join(materials, "figures/unlisted.png"), "PRIVATE_UNLISTED_FIGURE"),
    writeFile(path.join(materials, "private-results.csv"), "PRIVATE_RAW_RESULTS"),
    writeFile(path.join(materials, "reviewer-source.pdf"), "PRIVATE_REVIEWER_SOURCE"),
    writeFile(path.join(template, "template.tex"), "\\documentclass{article}\n"),
    writeFile(path.join(template, "guidelines.md"), "Use the supplied conference template."),
  ]);
  return { root, checkout, materials, template, audit: path.join(root, "provider-audit.jsonl") };
}

async function run(f, mode, options = {}) {
  const output = options.output ?? path.join(f.root, "output");
  const args = [cli, mode, "--checkout", path.relative(f.root, f.checkout),
    "--materials", path.relative(f.root, f.materials), "--template", path.relative(f.root, f.template),
    "--out", path.relative(f.root, output), "--cutoff", options.cutoff ?? "2024-11",
    ...(options.consent === false ? [] : ["--allow-model-calls"]), ...(options.extra ?? [])];
  try {
    const result = await exec("python3", args, { cwd: f.root, env: { ...process.env,
      PYTHONDONTWRITEBYTECODE: "1", TEST_ONLY_AUDIT: f.audit,
      TEST_ONLY_BEHAVIOR: options.behavior ?? "success" } });
    return { ...result, code: 0, output };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code, output };
  }
}

async function events(f) {
  return (await readFile(f.audit, "utf8")).trim().split("\n").map(line => JSON.parse(line));
}

function assertApprovedPayload(event) {
  assert.deepEqual(event.files, ["experimental_log.md", "figures/approved.png", "figures/info.json", "idea_sparse.md"]);
  assert.match(event.idea, /Approved idea/);
  assert.match(event.log, /Approved experimental log/);
  assert.equal(event.cwd_resource, "checkout-local-resource");
  assert.doesNotMatch(JSON.stringify(event), /PRIVATE_/);
}

test("draft and literature require consent before importing external code or creating a run", async t => {
  for (const mode of ["draft", "literature"]) {
    const f = await fixture(t);
    const result = await run(f, mode, { consent: false });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--allow-model-calls/);
    assert.equal(await exists(result.output), false);
    assert.equal(await exists(f.audit), false);
  }
});

test("generation rejects invalid cutoff, stale destinations and recursive input destinations before providers", async t => {
  const f = await fixture(t);
  for (const cutoff of ["2024-00", "2024-13", "2024-1", "0000-01"]) {
    const result = await run(f, "draft", { cutoff });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cutoff|YYYY-MM/);
    assert.equal(await exists(result.output), false);
  }
  const stale = path.join(f.root, "old-run");
  await mkdir(stale);
  await writeFile(path.join(stale, "keep.txt"), "preserve old run");
  for (const output of [stale, path.join(f.materials, "recursive-run"), path.join(f.template, "recursive-run")]) {
    const result = await run(f, "draft", { output });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /fresh|nested|input/);
  }
  assert.equal(await readFile(path.join(stale, "keep.txt"), "utf8"), "preserve old run");
  assert.equal(await exists(path.join(f.materials, "recursive-run")), false);
  assert.equal(await exists(path.join(f.template, "recursive-run")), false);
  assert.equal(await exists(f.audit), false);
});

test("missing trusted entrypoints or template guidelines fail before external imports", async t => {
  for (const missing of ["methods/paper_writer.py", "guidelines.md"]) {
    const f = await fixture(t);
    await rm(path.join(missing.startsWith("methods/") ? f.checkout : f.template, missing));
    const result = await run(f, "draft");
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /entrypoint|guidelines/);
    assert.equal(await exists(f.audit), false);
    assert.equal(await exists(result.output), false);
  }
});

test("draft stages only approved inputs and respects upstream defaults and explicit model choices", async t => {
  for (const extra of [[], ["--writer-model", "operator-writer", "--reflection-model", "operator-reflection"]]) {
    const f = await fixture(t);
    const result = await run(f, "draft", { extra });
    assert.equal(result.code, 0, result.stderr);
    const description = JSON.parse(result.stdout);
    assert.equal(description.mode, "draft");
    assert.equal(description.output, result.output);
    const receipt = JSON.parse(await readFile(path.join(result.output, "strataa-generation.json"), "utf8"));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.writerModelOverride, extra.length ? "operator-writer" : null);
    const review = path.join(f.root, "review");
    await exec("python3", [cli, "import", "--mode", "draft", "--run", result.output, "--out", review]);
    assert.deepEqual(await readFile(path.join(review, "paper/main.tex")), await readFile(path.join(result.output, "content_refinement_workdir/final_refined_paper.tex")));
    const calls = (await events(f)).filter(event => event.event === "draft-provider");
    assert.equal(calls.length, 1);
    assertApprovedPayload(calls[0]);
    assert.equal(calls[0].cutoff, "2024-11");
    assert.equal(calls[0].template, f.template);
    assert.equal(calls[0].writer, extra.length ? "operator-writer" : "gemini-3.1-pro-preview");
    assert.equal(calls[0].reflection, extra.length ? "operator-reflection" : "gemini-3.1-pro-preview");
    assert.ok((await readFile(path.join(result.output, "content_refinement_workdir/final_refined_paper.tex"), "utf8")).length);
    assert.ok((await readFile(path.join(result.output, "final_paper.pdf"))).length);
    assert.equal(await readFile(path.join(f.materials, "private-results.csv"), "utf8"), "PRIVATE_RAW_RESULTS");
  }
});

test("literature calls only outline and literature APIs with isolated approved context", async t => {
  const f = await fixture(t);
  const result = await run(f, "literature", { extra: ["--writer-model", "operator-literature"] });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, "literature");
  const calls = await events(f);
  assert.equal(calls.some(event => event.event === "writer-import" || event.event === "draft-provider"), false);
  for (const eventName of ["outline-provider", "literature-provider"]) {
    const selected = calls.filter(event => event.event === eventName);
    assert.equal(selected.length, 1);
    assertApprovedPayload(selected[0]);
    assert.equal(selected[0].writer, "operator-literature");
    assert.equal(selected[0].cutoff, "2024-11");
  }
  assert.deepEqual((await readdir(path.join(result.output, "literature_agent_output"))).sort(),
    ["citation_map.json", "outline_v1.json", "references.bib", "updated_template.tex"]);
  assert.equal(await exists(path.join(result.output, "final_paper.pdf")), false);
});

test("draft failure and incomplete upstream success stay failures without retries or fallback", async t => {
  for (const behavior of ["false", "missing-tex", "empty-pdf", "wrong-pdf", "missing-bib", "raise"]) {
    const f = await fixture(t);
    const result = await run(f, "draft", { behavior, extra: ["--writer-model", "unavailable-operator-model"] });
    assert.notEqual(result.code, 0, behavior);
    assert.match(result.stderr, /failed|missing|nonempty/i);
    assert.ok(result.stderr.includes(result.output));
    assert.equal(await exists(path.join(result.output, "raw_materials/idea_sparse.md")), true);
    assert.equal(JSON.parse(await readFile(path.join(result.output, "strataa-generation.json"), "utf8")).status, "failed");
    assert.equal(result.stdout.trim(), "");
    const calls = (await events(f)).filter(event => event.event === "draft-provider");
    assert.equal(calls.length, 1, "bridge must not retry paid generation");
    assert.equal(calls[0].writer, "unavailable-operator-model");
  }
});

test("literature requires usable outputs and retains incomplete runs without invoking full writing", async t => {
  for (const behavior of ["bad-json", "empty-map", "empty-bib", "missing-tex", "raise"]) {
    const f = await fixture(t);
    const result = await run(f, "literature", { behavior });
    assert.notEqual(result.code, 0, behavior);
    assert.match(result.stderr, /failed/i);
    assert.ok(result.stderr.includes(result.output));
    assert.equal(result.stdout.trim(), "");
    assert.equal(await exists(path.join(result.output, "outline.json")), true);
    const calls = await events(f);
    assert.equal(calls.filter(event => event.event === "literature-provider").length, 1);
    assert.equal(calls.some(event => event.event === "writer-import" || event.event === "draft-provider"), false);
  }
});
