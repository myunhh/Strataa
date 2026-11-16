import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export function flowDirectory() {
  return path.resolve(process.env.OMP_STRATAA_FLOW_DIR || path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "omp-agent-dialogue", "flows"));
}

const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === "string");
export function validFlow(flow) {
  return record(flow) && flow.version === 1 && typeof flow.id === "string" &&
    typeof flow.request === "string" && typeof flow.status === "string" &&
    Array.isArray(flow.rows) && flow.rows.every(row => record(row) &&
      typeof row.id === "string" && typeof row.state === "string" && strings(row.jobIds) &&
      Array.isArray(row.jobs) && row.jobs.every(job => record(job) && typeof job.id === "string")) &&
    (flow.waves === undefined || (Array.isArray(flow.waves) && flow.waves.every(wave => record(wave) && typeof wave.id === "string"))) &&
    (flow.skills === undefined || strings(flow.skills));
}
function validRecord(info) {
  return record(info) && info.version === 1 && typeof info.key === "string" && !!info.key &&
    Number.isSafeInteger(info.pid) && info.pid > 0 && typeof info.sessionId === "string" &&
    (info.sessionFile === undefined || typeof info.sessionFile === "string") &&
    typeof info.cwd === "string" && Number.isFinite(info.updatedAt) &&
    (info.flow === null || validFlow(info.flow));
}
function remove(file) {
  try { unlinkSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

/** One private record per extension instance, not per mutable host session. */
export function createFlowPublisher({ directory = flowDirectory() } = {}) {
  directory = path.resolve(directory);
  const key = `${process.pid}-${randomUUID()}`;
  const file = path.join(directory, `${key}.json`);
  let closed = false;
  return {
    publish({ sessionId, sessionFile, cwd, flow }) {
      if (closed) return;
      const info = { version: 1, key, pid: process.pid, sessionId,
        ...(typeof sessionFile === "string" ? { sessionFile } : {}), cwd, updatedAt: Date.now(), flow };
      if (!validRecord(info)) throw new Error("Invalid Strataa Flow snapshot");
      const content = JSON.stringify(info);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      const temporary = path.join(directory, `${key}-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, file);
      } finally {
        remove(temporary);
      }
    },
    close() {
      closed = true;
      remove(file);
    },
  };
}

function live(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

/** Missing/racing/malformed rows are ignored; filesystem failures remain visible. */
export function readFlowSessions({ directory = flowDirectory(), liveSessions = [] } = {}) {
  let names = [];
  try { names = readdirSync(directory); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const published = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let info;
    try { info = JSON.parse(readFileSync(path.join(directory, name), "utf8")); }
    catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) continue;
      throw error;
    }
    if (validRecord(info) && live(info.pid)) published.push(info);
  }
  const sessions = published.filter(info => info.flow);
  for (const info of liveSessions) {
    if (!validRecord(info) || !live(info.pid) || (!info.flow && !info.request)) continue;
    const owner = published.filter(item => item.pid === info.pid);
    if (!owner.length) { sessions.push(info); continue; }
    const current = owner.find(item => item.sessionId === info.sessionId && item.sessionFile === info.sessionFile);
    // A native null is authoritative: never revive another branch's stored flow.
    if (current && !current.flow && !info.flow) {
      sessions.push({ ...info, ...current, source: "session", title: info.title, request: info.request, requestId: info.requestId });
    }
  }
  return sessions.sort((a, b) => a.key.localeCompare(b.key));
}
