import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { ResearchError } from "./store.js";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const pdfAvailable = () => spawnSync("pdftotext", ["-v"], { stdio: "ignore", timeout: 3000 }).status === 0;

function extractPdf(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn("pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let size = 0, stderr = "", failure;
    const timer = setTimeout(() => { failure = new ResearchError("PDF 추출이 30초를 넘었습니다. 텍스트로 추출해 추가하세요."); child.kill("SIGKILL"); }, 30000);
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) { failure = new ResearchError("추출된 PDF 텍스트가 20 MiB를 넘습니다.", 413); child.kill("SIGKILL"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { if (stderr.length < 4000) stderr += chunk.toString("utf8").slice(0, 4000 - stderr.length); });
    child.stdin.on("error", () => {}); // Process error/exit is reported below, including a closed input pipe.
    child.on("error", error => { clearTimeout(timer); reject(new ResearchError(error.code === "ENOENT" ? "PDF 추출에 pdftotext가 필요합니다. poppler-utils를 설치하거나 텍스트를 입력하세요." : error.message)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new ResearchError(`PDF를 읽지 못했습니다: ${stderr.trim() || `exit ${code}`}`));
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return reject(new ResearchError("추출 가능한 텍스트가 없는 PDF입니다. 스캔본은 OCR 후 텍스트로 추가하세요."));
      resolve(text);
    });
    child.stdin.end(bytes);
  });
}

export async function paperSource(input) {
  if (!input.file) return { text: input.text, name: "" };
  const { name, base64 } = input.file;
  if (typeof name !== "string" || typeof base64 !== "string" || !base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new ResearchError("파일 이름과 올바른 base64 파일 내용이 필요합니다.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_FILE_BYTES) throw new ResearchError("파일은 20 MiB 이하여야 합니다.", 413);
  const filename = path.basename(name);
  const extension = path.extname(filename).toLowerCase();
  if (extension === ".pdf") {
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new ResearchError("PDF 헤더가 없는 파일입니다.");
    return { text: await extractPdf(bytes), name: filename, pdf: bytes };
  }
  if (![".md", ".markdown", ".txt"].includes(extension)) throw new ResearchError("PDF, Markdown, UTF-8 텍스트 파일을 선택하세요.");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ResearchError("텍스트 파일은 UTF-8이어야 합니다."); }
  if (text.includes("\0")) throw new ResearchError("바이너리 파일은 텍스트로 추가할 수 없습니다.");
  return { text, name: filename };
}
