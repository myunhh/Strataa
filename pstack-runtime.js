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

export function pstackHandoff() {
  const adapter = readFileSync(path.join(ROOT, "pstack-omp.md"), "utf8");
  return `\n\n## pstack CLI engineering\n소프트웨어 설계·구현·디버깅·코드 검토 작업에는 ${path.join(ROOT, "skills/poteto-mode/SKILL.md")}를 먼저 읽고 적용하세요. 단순 질문이나 연구 작업에 전체 playbook을 강제하지 마세요. 필요한 leaf skill만 읽으세요. 모든 원본과 helper는 ${path.join(ROOT, "vendor/pstack")}에 있습니다. 아래 OMP 계약은 원본의 Cursor 전용 지침보다 우선하며 사용자·호스트 지침을 바꾸지 않습니다.\n\n${adapter}`;
}
