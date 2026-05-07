import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, normalizeCompletedResult } from "./types.ts";

function baseResult(overrides = {}) {
  return {
    agent: "worker",
    agentSource: "user",
    task: "do work",
    exitCode: 0,
    messages: [],
    response: "",
    stderr: "",
    usage: emptyUsage(),
    ...overrides,
  };
}

test("normalizes transport errors to the latest failed tool when the child already reached agent_end", () => {
  const result = normalizeCompletedResult(
    baseResult({
      stopReason: "error",
      errorMessage: "WebSocket closed 1006",
      sawAgentEnd: true,
      artifactDir: "/tmp/pi-minimal-subagent-output-test",
      stdoutArtifact: "/tmp/pi-minimal-subagent-output-test/stdout.jsonl",
      stderrArtifact: "/tmp/pi-minimal-subagent-output-test/stderr.log",
      toolExecutions: [
        {
          toolCallId: "tool-1",
          toolName: "bash",
          status: "error",
          updates: 1,
          displayText: "bash $ npm run typecheck",
          latestText: "src/commands/harness.ts(24,44): error TS1343: import.meta is not allowed",
          isError: true,
          activityOrder: 1,
        },
      ],
    }),
    false,
  );

  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /Subagent failed after tool error/);
  assert.match(result.errorMessage ?? "", /bash \$ npm run typecheck/);
  assert.match(result.errorMessage ?? "", /TS1343/);
  assert.match(result.errorMessage ?? "", /stdout\.jsonl/);
  assert.match(result.errorMessage ?? "", /stderr\.log/);
  assert.match(result.stderr, /Transport error: WebSocket closed 1006/);
});
