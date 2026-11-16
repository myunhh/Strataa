import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, truncate, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectRegistry, ProjectError } from "../dashboard/projects.js";
import { createDashboard } from "../dashboard/server.js";
import { addPaper } from "../dashboard/store.js";

const sourceText = "This paper studies retrieval.\nWe compare dense retrieval using contrastive learning.";
function manifest(name = "Retrieval") {
  return {
    schemaVersion: 1,
    project: { name, summary: "Evidence-grounded project", nextStep: "Test transfer" },
    sources: [{ id: "paper", title: "Retrieval paper", path: "papers/paper.md", summary: "Dense retrieval comparison", authors: "", year: "", url: "https://example.org/paper" }],
    concepts: [
      { id: "field", name: "Learning", level: "field", parentId: null, description: "Field", sourceIds: ["paper"] },
      { id: "problem", name: "Retrieval", level: "problem", parentId: "field", description: "Problem", sourceIds: ["paper"] },
    ],
    buildUps: [{ id: "choice", title: "Measure transfer", kind: "decision", status: "accepted", parentId: null, body: "Use a held-out domain", alternatives: "Same-domain evaluation", rationale: "Separate memorization", evidence: [{ sourceId: "paper", quote: "We compare dense retrieval using\n contrastive learning." }], nextStep: "Define split", sourceIds: ["paper"], conceptIds: ["problem"], skillNames: ["experiment-plan"] }],
  };
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "strataa-projects-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = path.join(directory, "storage");
  const root = path.join(directory, "project");
  await mkdir(path.join(root, ".strataa"), { recursive: true });
  await mkdir(path.join(root, "papers"));
  await writeFile(path.join(root, "papers/paper.md"), sourceText);
  const manifestPath = path.join(root, ".strataa/project.json");
  const save = value => writeFile(manifestPath, JSON.stringify(value));
  await save(manifest());
  return { directory, storage, root, manifestPath, save, registry: createProjectRegistry(storage) };
}

test("connections are canonical, idempotent, isolated, persistent and read-only", async t => {
  const f = await fixture(t);
  const original = await readFile(f.manifestPath);
  const first = await f.registry.connect(f.root);
  assert.equal(first.status, "ready");
  assert.equal(first.error, null);
  assert.deepEqual(first.counts, { sources: 1, concepts: 2, buildUps: 1, gaps: 0 });
  assert.ok(first.diagnostics.some(item => /not proof/.test(item.message)));
  const alias = path.join(f.directory, "alias");
  await symlink(f.root, alias);
  assert.equal((await f.registry.connect(alias)).id, first.id);
  assert.equal((await f.registry.connect(path.join(f.root, "."))).id, first.id);
  assert.equal((await f.registry.list()).length, 1);
  first.project.name = "Mutated by caller";
  first.sources.length = 0;
  assert.equal((await f.registry.get(first.id)).project.name, "Retrieval");
  const reopened = createProjectRegistry(f.storage);
  assert.equal((await reopened.list())[0].id, first.id);
  const secondRoot = path.join(f.directory, "second");
  await mkdir(path.join(secondRoot, ".strataa"), { recursive: true });
  const secondData = manifest("Other project");
  secondData.sources = [];
  secondData.concepts = [];
  secondData.buildUps = [];
  await writeFile(path.join(secondRoot, ".strataa/project.json"), JSON.stringify(secondData));
  const second = await reopened.connect(secondRoot);
  assert.notEqual(second.id, first.id);
  assert.deepEqual((await reopened.get(second.id)).counts, { sources: 0, concepts: 0, buildUps: 0, gaps: 0 });
  await reopened.disconnect(first.id);
  assert.deepEqual((await reopened.list()).map(item => item.id), [second.id]);
  assert.deepEqual(await readFile(f.manifestPath), original);
  assert.equal((await reopened.connect(f.root)).id, first.id);
  await assert.rejects(reopened.get("missing"), error => error instanceof ProjectError && error.status === 404);
  await assert.rejects(reopened.disconnect("missing"), error => error.status === 404);
});

test("WSL Explorer paths connect to the same local project and never cross distributions", { skip: process.platform !== "linux" }, async t => {
  const f = await fixture(t);
  const previous = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = "Ubuntu-Test";
  t.after(() => { if (previous === undefined) delete process.env.WSL_DISTRO_NAME; else process.env.WSL_DISTRO_NAME = previous; });
  const local = await f.registry.connect(f.root);
  const windowsPath = f.root.replace(/\//g, "\\");
  for (const input of [
    `\\\\wsl.localhost\\Ubuntu-Test${windowsPath}`,
    `\\\\wsl$\\Ubuntu-Test${windowsPath}`,
    `  "\\\\WSL.LOCALHOST\\ubuntu-test${windowsPath}"  `,
    `//wsl.localhost/Ubuntu-Test${f.root}`,
  ]) {
    const connected = await f.registry.connect(input);
    assert.equal(connected.id, local.id);
    assert.equal(connected.root, local.root);
    assert.equal(connected.status, "ready");
  }
  for (const input of [`\\\\wsl.localhost\\Other-Distro${windowsPath}`, "\\\\server\\share\\project", "C:\\Users\\project"]) {
    await assert.rejects(f.registry.connect(input), error => error instanceof ProjectError && error.status === 400);
  }
  delete process.env.WSL_DISTRO_NAME;
  await assert.rejects(f.registry.connect(`\\\\wsl.localhost\\Ubuntu-Test${windowsPath}`), error => error instanceof ProjectError && error.status === 400);
  assert.equal((await f.registry.list()).length, 1);
});

test("polling rereads sources and manifests, explicitly marks stale data, and recovers", async t => {
  const f = await fixture(t);
  const first = await f.registry.connect(f.root);
  const changed = manifest("New project name");
  changed.buildUps[0].evidence = [];
  await f.save(changed);
  const updated = await f.registry.get(first.id);
  assert.equal(updated.name, "New project name");
  assert.equal(updated.counts.gaps, 1);
  await writeFile(f.manifestPath, "{bad");
  const stale = await f.registry.get(first.id);
  assert.equal(stale.status, "error");
  assert.match(stale.error, /Stale snapshot.*Invalid JSON/);
  assert.equal(stale.project.name, updated.project.name);
  assert.equal(stale.updatedAt, updated.updatedAt);
  assert.equal((await f.registry.get(first.id)).diagnostics.length, stale.diagnostics.length);
  await assert.rejects(f.registry.connect(f.root), error => error.status === 400);
  assert.equal((await f.registry.list()).length, 1);
  await f.save(manifest());
  await writeFile(path.join(f.root, "papers/paper.md"), "Quote no longer present");
  assert.match((await f.registry.get(first.id)).error, /Evidence quote not found/);
  await rm(path.join(f.root, "papers/paper.md"));
  assert.match((await f.registry.get(first.id)).error, /ENOENT/);
  await writeFile(path.join(f.root, "papers/paper.md"), sourceText);
  assert.equal((await f.registry.get(first.id)).status, "ready");
  await rm(f.root, { recursive: true });
  assert.equal((await f.registry.get(first.id)).status, "error");
  const unavailable = (await createProjectRegistry(f.storage).list())[0];
  assert.equal(unavailable.status, "error");
  assert.match(unavailable.error, /no valid snapshot/);
  assert.equal(unavailable.updatedAt, null);
});

test("failed initial connection and concurrent mutations cannot partially persist links", async t => {
  const f = await fixture(t);
  await writeFile(f.manifestPath, "null");
  await assert.rejects(f.registry.connect(f.root), error => error.status === 400);
  assert.deepEqual(await f.registry.list(), []);
  await f.save(manifest());
  const connections = await Promise.all(Array.from({ length: 10 }, () => f.registry.connect(f.root)));
  assert.equal(new Set(connections.map(item => item.id)).size, 1);
  assert.equal((await createProjectRegistry(f.storage).list()).length, 1);
  await Promise.all([f.registry.disconnect(connections[0].id), f.registry.connect(f.root)]);
  assert.equal((await f.registry.list()).length, 1);
  assert.deepEqual((await readdir(f.storage)).sort(), ["project-connections.json"]);
  // Force a rename failure: persistence must succeed before the in-memory link is removed.
  await rm(path.join(f.storage, "project-connections.json"));
  await mkdir(path.join(f.storage, "project-connections.json"));
  await assert.rejects(f.registry.disconnect(connections[0].id));
  assert.equal((await f.registry.list()).length, 1);
  assert.deepEqual((await readdir(f.storage)).sort(), ["project-connections.json"]);
});

test("invalid schemas, graph edges and forged evidence are rejected atomically", async t => {
  const f = await fixture(t);
  const cases = [
    value => { value.schemaVersion = 2; },
    value => { delete value.project.nextStep; },
    value => { value.sources.push({ ...value.sources[0] }); },
    value => { value.sources[0].authors = []; },
    value => { value.sources[0].url = "javascript:alert(1)"; },
    value => { value.concepts[1].parentId = null; },
    value => { value.concepts[0].parentId = "problem"; },
    value => { value.concepts[1].level = "technique"; },
    value => { value.concepts[0].sourceIds = ["missing"]; },
    value => { value.buildUps[0].parentId = "choice"; },
    value => { value.buildUps[0].parentId = "missing"; },
    value => { value.buildUps.push({ ...value.buildUps[0], id: "child", parentId: "choice" }); value.buildUps[0].parentId = "child"; },
    value => { value.buildUps[0].status = "verified"; },
    value => { value.buildUps[0].conceptIds = ["missing"]; },
    value => { value.buildUps[0].sourceIds = ["paper", "paper"]; },
    value => { value.buildUps[0].evidence[0].quote = "Invented result"; },
    value => { value.buildUps[0].evidence[0].quote = " \n "; },
    value => { value.buildUps[0].evidence[0].sourceId = "missing"; },
    value => { value.buildUps[0].sourceIds = []; },
    value => { value.buildUps[0].skillNames = [false]; },
  ];
  for (const mutate of cases) {
    const value = manifest();
    mutate(value);
    await f.save(value);
    await assert.rejects(f.registry.connect(f.root), error => error.status === 400, mutate.toString());
    assert.deepEqual(await f.registry.list(), []);
  }
});

test("traversal, absolute paths, hidden secrets, non-text and symlinks never become sources", async t => {
  const f = await fixture(t);
  const unsafe = ["../outside.txt", "/etc/passwd", "papers/../paper.md", "papers//paper.md", "papers\\paper.md", "C:/secret.txt", ".env.txt", "papers/.secrets/notes.md", "papers/credentials.txt", "papers/private-key.txt", "papers/paper.pdf", "papers/x\u0000.txt"];
  for (const sourcePath of unsafe) {
    const value = manifest();
    value.sources[0].path = sourcePath;
    await f.save(value);
    await assert.rejects(f.registry.connect(f.root), error => error.status === 400, sourcePath);
  }
  await f.save(manifest());
  const outside = path.join(f.directory, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "paper.md"), sourceText);
  await rm(path.join(f.root, "papers"), { recursive: true });
  await symlink(outside, path.join(f.root, "papers"));
  await assert.rejects(f.registry.connect(f.root), error => error.status === 400);
  await rm(path.join(f.root, "papers"));
  await mkdir(path.join(f.root, "papers"));
  await symlink(path.join(outside, "paper.md"), path.join(f.root, "papers/paper.md"));
  await assert.rejects(f.registry.connect(f.root), error => error.status === 400);
  await rm(path.join(f.root, "papers/paper.md"));
  await writeFile(path.join(f.root, "papers/paper.md"), sourceText);
  await rename(f.manifestPath, path.join(f.directory, "manifest.json"));
  await symlink(path.join(f.directory, "manifest.json"), f.manifestPath);
  await assert.rejects(f.registry.connect(f.root), error => error.status === 400);
  await rm(f.manifestPath);
  await f.save(manifest());
  await rename(path.join(f.root, ".strataa"), path.join(f.directory, "records"));
  await symlink(path.join(f.directory, "records"), path.join(f.root, ".strataa"));
  await assert.rejects(f.registry.connect(f.root), error => error.status === 400);
});

test("replaced root ancestors cannot redirect an existing connection", async t => {
  const f = await fixture(t);
  const initial = await f.registry.connect(f.root);
  const relocated = path.join(f.directory, "moved");
  await rename(f.root, relocated);
  await symlink(relocated, f.root);
  const current = await f.registry.get(initial.id);
  assert.equal(current.status, "error");
  assert.match(current.error, /Stale snapshot/);
});

test("strict UTF-8, manifest/source byte budgets and record limits are enforced", async t => {
  const f = await fixture(t);
  await writeFile(f.manifestPath, Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.registry.connect(f.root), /Invalid UTF-8/);
  await truncate(f.manifestPath, 2 * 1024 * 1024 + 1);
  await assert.rejects(f.registry.connect(f.root), /byte limit/);
  await f.save(manifest());
  const source = path.join(f.root, "papers/paper.md");
  await writeFile(source, Buffer.from([0xff]));
  await assert.rejects(f.registry.connect(f.root), /Invalid UTF-8/);
  await truncate(source, 2 * 1024 * 1024 + 1);
  await assert.rejects(f.registry.connect(f.root), /byte limit/);
  await writeFile(source, sourceText);
  for (const [key, count] of [["sources", 201], ["concepts", 1001], ["buildUps", 1001]]) {
    const value = manifest();
    value[key] = Array.from({ length: count }, (_, index) => ({ ...value[key][0], id: String(index) }));
    await f.save(value);
    await assert.rejects(f.registry.connect(f.root), /at most/);
  }
  const value = manifest();
  value.sources = Array.from({ length: 11 }, (_, index) => ({ ...value.sources[0], id: index ? `paper-${index}` : "paper", path: `papers/${index}.txt` }));
  for (let index = 0; index < 11; index++) await writeFile(path.join(f.root, `papers/${index}.txt`), "x".repeat(2 * 1024 * 1024));
  await f.save(value);
  await assert.rejects(f.registry.connect(f.root), /byte limit/);
  assert.deepEqual(await f.registry.list(), []);
});

test("corrupt persisted connections fail explicitly without overwriting stored data", async t => {
  const f = await fixture(t);
  await mkdir(f.storage);
  const filename = path.join(f.storage, "project-connections.json");
  for (const content of ["{broken", JSON.stringify({ schemaVersion: 1, roots: ["relative"] }), JSON.stringify({ schemaVersion: 1, roots: [f.root, f.root] })]) {
    await writeFile(filename, content);
    await assert.rejects(createProjectRegistry(f.storage).connect(f.root));
    assert.equal(await readFile(filename, "utf8"), content);
  }
});

test("project API connects, polls changes and disconnects without modifying the paper database", async t => {
  const f = await fixture(t);
  const app = createDashboard({ directory: f.storage, flowDirectory: path.join(f.directory, "flows") });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  addPaper(app.store, { revision: 0, title: "Preserved legacy paper" }, { text: sourceText, filename: "paper.txt" });
  const original = app.store.read();
  const connect = await fetch(`${base}/api/projects`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: f.root }) });
  assert.equal(connect.status, 201);
  const project = await connect.json();
  const value = manifest("Updated through agent");
  await f.save(value);
  const polled = await fetch(`${base}/api/projects/${project.id}`);
  assert.equal(polled.status, 200);
  assert.equal((await polled.json()).name, "Updated through agent");
  const response = await fetch(`${base}/api/projects/${project.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual((await (await fetch(`${base}/api/projects`)).json()).projects, []);
  assert.equal((await fetch(`${base}/api/projects/${project.id}`)).status, 404);
  assert.deepEqual(app.store.read(), original);
  assert.equal(JSON.parse(await readFile(f.manifestPath, "utf8")).project.name, "Updated through agent");
});

test("bundled skill example and generated .strataa source excerpts validate unchanged", async t => {
  const f = await fixture(t);
  const example = await readFile(new URL("../skills/strataa-project/example.json", import.meta.url), "utf8");
  const source = await readFile(new URL("../skills/strataa-project/example-source.md", import.meta.url), "utf8");
  await writeFile(f.manifestPath, example);
  await writeFile(path.join(f.root, "example-source.md"), source);
  const initial = await f.registry.connect(f.root);
  assert.equal(initial.status, "ready");
  assert.equal(initial.sources.length, 1);
  await mkdir(path.join(f.root, ".strataa/sources"), { recursive: true });
  await writeFile(path.join(f.root, ".strataa/sources/excerpt.md"), source);
  const value = JSON.parse(example);
  value.sources[0].path = ".strataa/sources/excerpt.md";
  await f.save(value);
  assert.equal((await f.registry.get(initial.id)).status, "ready");
  value.project.unexpected = "Must not bypass exact schema";
  await f.save(value);
  assert.match((await f.registry.get(initial.id)).error, /unknown properties/);
});

test("nonregular evidence and symlinked connection storage fail closed", async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, "papers/paper.md"));
  await mkdir(path.join(f.root, "papers/paper.md"));
  await assert.rejects(f.registry.connect(f.root), /Not a regular file/);
  await rm(path.join(f.root, "papers/paper.md"), { recursive: true });
  await writeFile(path.join(f.root, "papers/paper.md"), sourceText);
  await mkdir(f.storage, { recursive: true });
  const target = path.join(f.directory, "external-connections.json");
  const content = JSON.stringify({ schemaVersion: 1, roots: [f.root] });
  await writeFile(target, content);
  await symlink(target, path.join(f.storage, "project-connections.json"));
  await assert.rejects(createProjectRegistry(f.storage).connect(f.root));
  assert.equal(await readFile(target, "utf8"), content);
});
