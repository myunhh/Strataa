import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REASONING_LEVELS } from "../model-config.js";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const RUN_TIMEOUT_MS = 195000;

export function validateModelSettings(model, reasoning, label = "Paper analysis") {
  if (typeof model !== "string" || !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/@+-]+$/.test(model) || model.length > 250) throw new Error(`${label}: model must be an exact provider/model selector`);
  if (!REASONING_LEVELS.includes(reasoning)) throw new Error(`${label}: reasoning must be auto, off, minimal, low, medium, high, xhigh or max`);
}

function finalResult(stdout, requestedModel, label) {
  const fail = message => { throw new Error(`${label}: ${message}`); };
  let finalMessage;
  let ended = false;
  let terminalMessage;
  const checkMessage = message => {
    if (!message || message.role !== "assistant") return;
    if (message.stopReason !== "stop" || message.errorMessage || message.retryRecovery) fail(`OMP assistant did not complete successfully (${message.stopReason || "missing stop reason"})${message.errorMessage ? `: ${message.errorMessage}` : ""}`);
    const actual = `${message.provider}/${message.model}`;
    if (actual !== requestedModel) fail(`OMP model mismatch: requested ${requestedModel}, received ${actual}`);
    if (message.upstreamModel && message.upstreamModel !== message.model) fail(`OMP reported a different upstream model: ${message.upstreamModel}`);
    if (!Array.isArray(message.content) || message.content.some(block => !block || !["text", "thinking", "redactedThinking"].includes(block.type))) fail("OMP returned unexpected non-text content or a tool call");
    return message;
  };
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { fail("OMP emitted malformed JSON stream output"); }
    if (!event || typeof event !== "object" || Array.isArray(event)) fail("OMP event must be an object");
    if (typeof event.type !== "string") fail("OMP event is missing its type");
    if (event.type.includes("error") || /^(auto_retry|retry_fallback|auto_compaction|context_promotion|tool_execution)/u.test(event.type) || event.error || event.errorMessage || event.assistantMessageEvent?.type === "error") fail(`OMP transport or unexpected continuation event: ${event.type}`);
    if (["message_end", "turn_end"].includes(event.type)) {
      const message = checkMessage(event.message);
      if (message) {
        if (ended) fail("OMP emitted an assistant message after completion");
        if (event.type === "message_end") {
          if (finalMessage) fail("OMP emitted multiple assistant completions; no retries or continuations are permitted");
          finalMessage = message;
        }
      }
    }
    if (event.type === "agent_end") {
      if (ended || !Array.isArray(event.messages)) fail("OMP emitted invalid completion event");
      ended = true;
      const assistants = event.messages.filter(message => message?.role === "assistant");
      if (assistants.length !== 1) fail("OMP completion must contain exactly one assistant result");
      terminalMessage = checkMessage(assistants[0]);
    }
  }
  if (!ended || !finalMessage || !terminalMessage) fail("OMP stream is incomplete");
  // The session enriches timing/replay metadata between frames. Compare the
  // public result, not whole SDK objects; identity and completion were checked above.
  const publicText = message => message.content.filter(block => block.type === "text").map(block => {
    if (typeof block.text !== "string") fail("OMP text block is malformed");
    return block.text;
  }).join("");
  const resultText = publicText(finalMessage);
  if (resultText !== publicText(terminalMessage)) fail("OMP stream has inconsistent final assistant text");
  let value;
  try { value = JSON.parse(resultText); } catch { fail("final OMP assistant text is not a JSON object"); }
  return { value, model: `${finalMessage.provider}/${finalMessage.model}` };
}

async function runOmp(prompt, model, reasoning, signal, configPath, label, operation) {
  const fail = message => { throw new Error(`${label}: ${message}`); };
  if (signal?.aborted) fail(`${operation} aborted before OMP launch`);
  return new Promise((resolve, reject) => {
    const args = ["--print", "--mode", "json", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-session", "--no-title", "--no-lsp", "--no-prewalk", "--model", model, "--thinking", reasoning, "--max-time", "180", "--config", configPath];
    const child = spawn(process.env.OMP_BIN || "omp", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    let failure;
    let killTimer;
    let outBytes = 0;
    let errBytes = 0;
    const stdout = [];
    const stderr = [];
    const kill = signalName => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
        else child.kill(signalName);
      } catch (error) {
        if (error.code !== "ESRCH") child.kill(signalName);
      }
    };
    const stop = message => {
      if (failure) return;
      failure = new Error(`${label}: ${message}`);
      child.stdin.destroy();
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const abort = () => stop(`${operation} aborted; OMP was terminated`);
    const timer = setTimeout(() => stop(`OMP exceeded the 195-second ${operation} deadline`), RUN_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", chunk => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) stop(`OMP stdout exceeded ${MAX_OUTPUT_BYTES} bytes; result rejected, not truncated`);
      else if (!failure) stdout.push(chunk);
    });
    child.stderr.on("data", chunk => {
      errBytes += chunk.length;
      if (errBytes > MAX_STDERR_BYTES) stop(`OMP stderr exceeded ${MAX_STDERR_BYTES} bytes`);
      else if (!failure) stderr.push(chunk);
    });
    child.stdin.on("error", error => stop(`could not send source data to OMP: ${error.message}`));
    child.on("error", error => { failure ||= new Error(`${label}: could not launch OMP: ${error.message}`); });
    child.on("close", (code, closeSignal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) { kill("SIGKILL"); reject(failure); return; }
      if (code !== 0 || closeSignal) { reject(new Error(`${label}: OMP exited ${closeSignal || code}${errBytes ? `: ${Buffer.concat(stderr).toString("utf8").trim()}` : ""}`)); return; }
      try {
        const output = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
        resolve(finalResult(output, model, label));
      } catch (error) { reject(error); }
    });
    if (!failure) child.stdin.end(prompt);
  });
}

export async function runModelJson({ prompt, model, reasoning, signal, label = "Paper analysis", operation = "analysis" }) {
  validateModelSettings(model, reasoning, label);
  if (signal?.aborted) throw new Error(`${label}: ${operation} aborted before OMP launch`);
  const directory = await mkdtemp(path.join(tmpdir(), `strataa-${operation}-`));
  try {
    // Explicit per-run overlay only; never read or rewrite the operator's settings/auth.
    const configPath = path.join(directory, "inference.yml");
    await writeFile(configPath, "retry:\n  enabled: false\n  maxRetries: 0\n  modelFallback: false\n  usageAwareFallback: false\ncontextPromotion:\n  enabled: false\nadvisor:\n  enabled: false\ncompaction:\n  enabled: false\n  midTurnEnabled: false\nfeatures:\n  unexpectedStopDetection: none\n", { mode: 0o600 });
    return await runOmp(prompt, model, reasoning, signal, configPath, label, operation);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
