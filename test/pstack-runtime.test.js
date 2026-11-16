import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validatePstackInstall } from "../pstack-runtime.js";

function pack(t) {
  const root = mkdtempSync(path.join(tmpdir(), "strataa-pstack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = "vendor/pstack/skills/example/run.sh";
  for (const directory of ["vendor/pstack/skills/example", "skills/example", "agents"]) mkdirSync(path.join(root, directory), { recursive: true });
  const body = "#!/bin/sh\necho ok\n";
  writeFileSync(path.join(root, filename), body, { mode: 0o755 });
  writeFileSync(path.join(root, "pstack-omp.md"), "Host adapter");
  writeFileSync(path.join(root, "skills/example/SKILL.md"), "Native skill");
  writeFileSync(path.join(root, "agents/helper.md"), "Native agent");
  writeFileSync(path.join(root, "pstack-provenance.json"), JSON.stringify({
    source: { commit: "pinned", version: "1.0.0" }, skills: ["example"], agents: ["helper"],
    files: [{ path: filename, size: Buffer.byteLength(body), mode: 0o755, sha256: createHash("sha256").update(body).digest("hex") }],
  }));
  return { root, filename: path.join(root, filename), body };
}

test("pstack rejects same-size changed helpers, missing sources and lost executable modes", async t => {
  for (const change of ["content", "missing", "mode"]) await t.test(change, t => {
    const fixture = pack(t);
    assert.equal(validatePstackInstall(fixture.root).count, 1);
    if (change === "content") writeFileSync(fixture.filename, fixture.body.replace("ok", "no"));
    if (change === "missing") rmSync(fixture.filename);
    if (change === "mode") chmodSync(fixture.filename, 0o644);
    assert.throws(() => validatePstackInstall(fixture.root), change === "missing" ? /ENOENT/ : /source differs/);
  });
});

test("pstack does not declare a source-only import usable without native entrypoints", t => {
  const fixture = pack(t);
  rmSync(path.join(fixture.root, "skills/example/SKILL.md"));
  assert.throws(() => validatePstackInstall(fixture.root), /ENOENT/);
});
