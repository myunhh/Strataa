import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("./", import.meta.url));

function manifest(root) {
  return JSON.parse(readFileSync(path.join(root, "pstack-provenance.json"), "utf8"));
}

export function getPstackCatalog(root = ROOT) {
  return manifest(root).skills.map(name => ({ name, path: path.join(root, "skills", name, "SKILL.md") }));
}

export function validatePstackInstall(root = ROOT) {
  const provenance = manifest(root);
  for (const entry of provenance.files) {
    const filename = path.join(root, entry.path);
    const info = lstatSync(filename);
    if (!info.isFile() || info.size !== entry.size || (info.mode & 0o111) !== (entry.mode & 0o111)
      || createHash("sha256").update(readFileSync(filename)).digest("hex") !== entry.sha256) {
      throw new Error(`pstack source differs from pinned inventory: ${entry.path}`);
    }
  }
  for (const filename of ["pstack-omp.md", ...provenance.skills.map(name => `skills/${name}/SKILL.md`),
    ...provenance.agents.map(name => `agents/${name}.md`)]) {
    const info = lstatSync(path.join(root, filename));
    if (!info.isFile() || !info.size) throw new Error(`pstack native entrypoint missing or empty: ${filename}`);
  }
  return { count: provenance.skills.length, agents: provenance.agents.length, files: provenance.files.length,
    commit: provenance.source.commit, version: provenance.source.version, root };
}

export function pstackHandoff(role) {
  const adapter = readFileSync(path.join(ROOT, "pstack-omp.md"), "utf8");
  const ownership = role === "worker"
    ? "You are a bounded ARIS Worker. Use pstack only inside the assigned packet. Do not delegate, start reviews, decide research claims, or widen scope. Report substantive claim changes to Brain."
    : role === "brain"
      ? "You remain the ARIS Brain. ARIS owns the research procedure and requested review; pstack supports exploration, implementation and writing. Pass only relevant leaf-skill paths to Workers. Keep the independent Reviewer focused on original evidence, not the author's polishing instructions."
      : "You remain the Solo coordinator. Handle straightforward work inline. Use poteto-mode only when the user requests it or a substantial software task benefits from its playbook; ordinary coding and prose cleanup do not require the whole mode.";
  return `\n\n## Selective pstack support\n${ownership}\nUse only useful leaf skills: unslop for prose cleanup, why for decision evidence, architect for implementation design, blast-radius for change impact. Native entrypoints: ${path.join(ROOT, "skills/<name>/SKILL.md")}. Read the selected entrypoint before applying it; original references stay under ${path.join(ROOT, "vendor/pstack")}. The installed adapter below applies to every selected skill and nested playbook. No need to load all skills or add a review stage merely because pstack is available.\n\n${adapter}`;
}
