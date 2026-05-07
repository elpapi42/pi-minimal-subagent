import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getSubagentProgressText, processPiJsonLine } from "./runner-events.js";
import {
  type AgentConfig,
  type Settings,
  type SubagentDetails,
  type SubagentResult,
  emptyUsage,
  normalizeCompletedResult,
} from "./types.ts";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const STDOUT_TAIL_LINES = 40;
type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface RunSubagentOptions {
  cwd: string;
  agent: AgentConfig;
  task: string;
  settings: Settings;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  makeDetails: (results: SubagentResult[]) => SubagentDetails;
}

function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

function writeSystemPromptToTempFile(systemPrompt: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-subagent-"));
  const filePath = path.join(tmpDir, "system-prompt.md");
  fs.writeFileSync(filePath, systemPrompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function createArtifactFiles(): { dir: string; stdoutPath: string; stderrPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-subagent-output-"));
  const stdoutPath = path.join(dir, "stdout.jsonl");
  const stderrPath = path.join(dir, "stderr.log");
  fs.writeFileSync(stdoutPath, "", { encoding: "utf-8", mode: 0o600 });
  fs.writeFileSync(stderrPath, "", { encoding: "utf-8", mode: 0o600 });
  return { dir, stdoutPath, stderrPath };
}

function appendArtifact(filePath: string | undefined, chunk: Buffer | string): void {
  if (!filePath) return;
  try {
    fs.appendFileSync(filePath, chunk);
  } catch {
    // Preserve subagent execution even when diagnostic artifact writing fails.
  }
}

function rememberStdoutLine(result: SubagentResult, line: string): void {
  if (!line.trim()) return;
  if (!Array.isArray(result.stdoutTail)) result.stdoutTail = [];
  result.stdoutTail.push(line);
  while (result.stdoutTail.length > STDOUT_TAIL_LINES) result.stdoutTail.shift();
}

function mergeExtensions(settings: Settings, agent: AgentConfig): string[] {
  return [...new Set([...(settings.extensions ?? []), ...(agent.extensions ?? [])])];
}

function buildChildEnv(settings: Settings): NodeJS.ProcessEnv {
  const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };

  if (isWindows) {
    for (const [configuredKey, configuredValue] of Object.entries(settings.environment)) {
      const normalizedKey = configuredKey.toLowerCase();
      for (const key of Object.keys(inheritedEnv)) {
        if (key.toLowerCase() === normalizedKey) delete inheritedEnv[key];
      }
      inheritedEnv[configuredKey] = configuredValue;
    }
    return inheritedEnv;
  }

  return {
    ...inheritedEnv,
    ...settings.environment,
  };
}

function buildPiArgs(opts: {
  task: string;
  systemPromptPath: string | null;
  settings: Settings;
  agent: AgentConfig;
}): string[] {
  const { task, systemPromptPath, settings, agent } = opts;
  const args = ["--mode", "json", "-p", "--no-session"];
  const extensions = mergeExtensions(settings, agent);

  if (settings.extensions !== null) {
    args.push("--no-extensions");
  }

  for (const extension of extensions) {
    args.push("--extension", extension);
  }

  const model = agent.model ?? settings.model;
  if (model) args.push("--model", model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.skills?.length) {
    for (const skill of agent.skills) args.push("--skill", skill);
  }
  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);

  args.push(task);
  return args;
}

export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  const { cwd, agent, task, settings, signal, onUpdate, makeDetails } = opts;

  const result: SubagentResult = {
    agent: agent.name,
    agentSource: agent.source,
    agentFile: agent.filePath,
    task,
    exitCode: -1,
    messages: [],
    response: "",
    stderr: "",
    usage: emptyUsage(),
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getSubagentProgressText(result),
        },
      ],
      details: makeDetails([result]),
    });
  };

  let tmpDir: string | null = null;
  let systemPromptPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = writeSystemPromptToTempFile(agent.systemPrompt);
    tmpDir = tmp.dir;
    systemPromptPath = tmp.filePath;
  }

  try {
    const piArgs = buildPiArgs({ task, systemPromptPath, settings, agent });
    const artifacts = createArtifactFiles();
    result.artifactDir = artifacts.dir;
    result.stdoutArtifact = artifacts.stdoutPath;
    result.stderrArtifact = artifacts.stderrPath;
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const { command, prefixArgs } = resolvePiSpawn();
      const proc = spawn(command, [...prefixArgs, ...piArgs], {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(settings),
      });

      proc.stdin.on("error", () => {
        // Ignore broken pipe on fast exits.
      });
      proc.stdin.end();

      let buffer = "";
      let didClose = false;
      let settled = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;

      const clearSemanticCompletionTimer = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
      };

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearSemanticCompletionTimer();
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        resolve(code);
      };

      const flushLine = (line: string) => {
        rememberStdoutLine(result, line);
        if (processPiJsonLine(line, result)) emitUpdate();
        maybeFinishFromAgentEnd();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishFromAgentEnd = () => {
        if (!result.sawAgentEnd || didClose || settled) return;
        clearSemanticCompletionTimer();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled || !result.sawAgentEnd) return;
          if (buffer.trim()) {
            flushBufferedLines(buffer);
            buffer = "";
          }
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          finish(0);
          terminateChild();
        }, AGENT_END_GRACE_MS);
        semanticCompletionTimer.unref();
      };

      const onStdoutData = (chunk: Buffer) => {
        appendArtifact(result.stdoutArtifact, chunk);
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        appendArtifact(result.stderrArtifact, chunk);
        result.stderr += chunk.toString();
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      proc.on("close", (code) => {
        didClose = true;
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        appendArtifact(result.stderrArtifact, `${err.message}\n`);
        if (!result.stderr.trim()) result.stderr = err.message;
        finish(1);
      });

      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    cleanupTempDir(tmpDir);
  }
}
