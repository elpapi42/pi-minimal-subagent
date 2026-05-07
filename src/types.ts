import type { Message } from "@mariozechner/pi-ai";
import { getFinalAssistantText } from "./runner-events.js";

export type AgentSource = "user" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  model?: string;
  extensions?: string[];
  skills?: string[];
  thinking?: string;
}

export interface Settings {
  model: string | null;
  extensions: string[] | null;
  environment: Record<string, string>;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface ToolExecution {
  toolCallId: string;
  toolName: string;
  status: "running" | "completed" | "error";
  updates: number;
  argsPreview?: string;
  displayText?: string;
  latestText?: string;
  isError?: boolean;
  activityOrder?: number;
}

export interface ThinkingState {
  status: "running" | "completed";
  chars: number;
  activityOrder?: number;
}

export interface ToolActivity extends ToolExecution {
  type: "tool";
  activityOrder: number;
}

export interface ThinkingActivity extends ThinkingState {
  type: "thinking";
  activityOrder: number;
}

export type Activity = ToolActivity | ThinkingActivity;

export interface SubagentResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  agentFile?: string;
  task: string;
  exitCode: number;
  messages: Message[];
  response: string;
  stderr: string;
  usage: UsageStats;
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  sawAgentEnd?: boolean;
  thinking?: ThinkingState;
  activityCount?: number;
  activities?: Activity[];
  toolExecutionCount?: number;
  toolExecutions?: ToolExecution[];
  artifactDir?: string;
  stdoutArtifact?: string;
  stderrArtifact?: string;
  stdoutTail?: string[];
}

export interface SubagentDetails {
  results: SubagentResult[];
  availableAgents?: string[];
  projectAgentsDir?: string | null;
}

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

export function hasFinalAssistantOutput(
  r: Pick<SubagentResult, "messages">,
): boolean {
  return getFinalAssistantText(r.messages).trim().length > 0;
}

export function hasSemanticCompletion(
  r: Pick<SubagentResult, "messages" | "sawAgentEnd">,
): boolean {
  return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

export function isResultSuccess(r: SubagentResult): boolean {
  if (r.exitCode === -1) return false;
  if (hasSemanticCompletion(r)) return true;
  return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
}

export function isResultError(r: SubagentResult): boolean {
  if (r.exitCode === -1) return false;
  return !isResultSuccess(r);
}

function latestFailedTool(result: SubagentResult): ToolExecution | undefined {
  const activities = Array.isArray(result.activities) ? result.activities : [];
  for (let i = activities.length - 1; i >= 0; i--) {
    const activity = activities[i];
    if (activity?.type === "tool" && (activity.status === "error" || activity.isError)) return activity;
  }

  const tools = Array.isArray(result.toolExecutions) ? result.toolExecutions : [];
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i];
    if (tool?.status === "error" || tool?.isError) return tool;
  }

  return undefined;
}

function formatArtifactSummary(result: SubagentResult): string {
  const paths: string[] = [];
  if (result.stdoutArtifact) paths.push(`stdout: ${result.stdoutArtifact}`);
  if (result.stderrArtifact) paths.push(`stderr: ${result.stderrArtifact}`);
  return paths.length > 0 ? `\nArtifacts: ${paths.join(", ")}` : "";
}

function normalizeAgentEndToolFailure(result: SubagentResult): void {
  if (!result.sawAgentEnd || hasSemanticCompletion(result)) return;
  if (result.stopReason !== "error" && !result.errorMessage) return;

  const tool = latestFailedTool(result);
  if (!tool) return;

  const transportError = result.errorMessage?.trim();
  if (transportError && !result.stderr.includes(transportError)) {
    result.stderr = result.stderr.trim()
      ? `${result.stderr.trim()}\nTransport error: ${transportError}`
      : `Transport error: ${transportError}`;
  }

  const toolLabel = tool.displayText || tool.toolName || "tool";
  const toolOutput = tool.latestText?.trim();
  const artifacts = formatArtifactSummary(result);
  result.errorMessage = toolOutput
    ? `Subagent failed after tool error: ${toolLabel}\n${toolOutput}${artifacts}`
    : `Subagent failed after tool error: ${toolLabel}${artifacts}`;
}

export function normalizeCompletedResult(
  result: SubagentResult,
  wasAborted: boolean,
): SubagentResult {
  const semanticSuccess = hasSemanticCompletion(result);

  normalizeAgentEndToolFailure(result);

  if (wasAborted) {
    if (semanticSuccess) {
      result.exitCode = 0;
      if (result.stopReason === "aborted") result.stopReason = undefined;
      if (result.errorMessage === "Subagent was aborted.") result.errorMessage = undefined;
    } else {
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
    }
    result.response = getFinalOutput(result.messages);
    return result;
  }

  if (result.exitCode > 0) {
    if (semanticSuccess) {
      result.exitCode = 0;
      if (result.stopReason === "error") result.stopReason = undefined;
      if (result.errorMessage === result.stderr.trim()) result.errorMessage = undefined;
    } else {
      if (!result.stopReason) result.stopReason = "error";
      if (!result.errorMessage && result.stderr.trim()) {
        result.errorMessage = result.stderr.trim();
      }
    }
  }

  result.response = getFinalOutput(result.messages);
  return result;
}

export function getFinalOutput(messages: Message[]): string {
  return getFinalAssistantText(messages);
}
