import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectProject } from "../dashboard/projects.js";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../project-cli.mjs", import.meta.url));
const quote = "The saved offline analysis reports a negative result on the Dense trace only.";

function manifest() {
  return {
    schemaVersion: 1,
    project: { name: "Recorded investigation", summary: `[Observed] ${quote} [Unknown] User adoption of the proposal is not recorded.`, nextStep: "[Inferred] Proposed: read the missing acceptance record; do not run a new experiment." },
    sources: [{ id: "report", title: "Saved report", path: "report.md", summary: "[Observed] Historical report, not a new run.", authors: "", year: "", url: "" }],
    concepts: [{ id: "field", name: "Caching", level: "field", parentId: null, description: "[Inferred] Classification of the investigation.", sourceIds: ["report"] }],
    buildUps: [
      { id: "result", title: "Limited negative finding", kind: "result", status: "active", parentId: null, body: `[Observed] ${quote}`, alternatives: "", rationale: "[Unknown] Generalization beyond this trace.", evidence: [{ sourceId: "report", quote }], nextStep: "[Inferred] Read recorded scope before proposing work.", sourceIds: ["report"], conceptIds: ["field"], skillNames: [] },
      { id: "proposal", title: "Unapproved proposal", kind: "hypothesis", status: "draft", parentId: "result", body: "[Inferred] Proposal only; [Unknown] acceptance.", alternatives: "", rationale: "[Unknown] No acceptance evidence.", evidence: [], nextStep: "[Inferred] Find a documented decision before claiming adoption.", sourceIds: ["report"], conceptIds: ["field"], skillNames: [] }
    ]
  };
}

async function fixture(t, data = manifest()) {
  const root = await mkdtemp(path.join(tmpdir(), "strataa-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (data) {
    await mkdir(path.join(root, ".strataa"));
    await writeFile(path.join(root, ".strataa/project.json"), JSON.stringify(data));
    await writeFile(path.join(root, "report.md"), quote);
  }
  return root;
}

async function run(root, args = [], env = {}) {
  try {
    const result = await exec(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, HOME: root, XDG_DATA_HOME: root, ...env } });
    return { ...result, code: 0 };
  } catch (error) {
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
}

async function tree(root) {
  const result = {};
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const filename = path.join(root, entry.name);
    const metadata = await stat(filename);
    result[entry.name] = entry.isDirectory() ? { mtime: metadata.mtimeMs, files: await tree(filename) } : { mtime: metadata.mtimeMs, content: await readFile(filename, "utf8") };
  }
  return result;
}

test("JSON defaults to cwd, retains full hierarchy/history, and neither CLI nor inspector writes", async t => {
  const data = manifest();
  const root = await fixture(t, data);
  const before = await tree(root);
  const result = await run(root, ["--json"]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.root, root);
  assert.deepEqual(snapshot.project, data.project);
  assert.deepEqual(snapshot.sources, data.sources);
  assert.deepEqual(snapshot.concepts, data.concepts);
  assert.deepEqual(snapshot.buildUps, data.buildUps);
  assert.deepEqual(snapshot.counts, { sources: 1, concepts: 1, buildUps: 2, gaps: 1 });
  assert.deepEqual(await inspectProject(root), snapshot);
  assert.deepEqual(await tree(root), before);
});

test("human output preserves negative scope and unknown approval and makes gaps actionable", async t => {
  const root = await fixture(t);
  const result = await run(root, [root]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /negative result on the Dense trace only/);
  assert.match(result.stdout, /\[Unknown\] User adoption/);
  assert.match(result.stdout, /not scientific verification or approval/);
  assert.match(result.stdout, /Next step: \[Inferred\] Proposed:/);
  assert.match(result.stdout, /Evidence gap \[proposal\].*Read report\.md.*Do not infer acceptance/);
});

test("unknown references and unsupported quotes fail without stale success or writes", async t => {
  for (const [change, expected] of [
    [data => { data.buildUps[0].conceptIds = ["missing"]; }, /Unknown buildUp\.conceptIds/],
    [data => { data.buildUps[0].evidence[0].quote = "The method was approved and succeeded."; }, /Evidence quote not found/]
  ]) {
    const data = manifest();
    change(data);
    const root = await fixture(t, data);
    const before = await tree(root);
    const result = await run(root, ["--json"]);
    assert.equal(result.code, 1);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.status, "error");
    assert.match(failure.error, expected);
    assert.equal(failure.buildUps, undefined);
    assert.deepEqual(await tree(root), before);
  }
});

test("missing marker fails with opt-in bootstrap guidance and creates nothing", async t => {
  const root = await fixture(t, null);
  const result = await run(root);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /explicitly request strataa-project bootstrap/);
  assert.match(result.stderr, /inspection never creates/);
  assert.deepEqual(await readdir(root), []);
});

test("inspector reuses quoted-path and same-distribution WSL normalization", { skip: process.platform !== "linux" }, async t => {
  const root = await fixture(t);
  const result = await run(root, [`"\\\\wsl.localhost\\TestDistro${root.replaceAll("/", "\\")}"`, "--json"], { WSL_DISTRO_NAME: "TestDistro" });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).root, root);
});
