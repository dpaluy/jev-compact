import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { POLICY_VERSION, type Plan, type Policy } from "./core.js";
import { QUESTION_VERSION } from "./jev.js";

export interface AuditRun {
  sessionId: string;
  host: string;
  inputHash: string;
  outputHash: string;
  policy: Policy;
  requestedModel: string;
  beforeBytes: number;
  afterBytes: number;
  plan: Plan;
}

/** Each run is independent. A missing ready record means the file is incomplete. */
export async function writeAudit(directory: string, run: AuditRun): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runId = randomUUID();
  const timestamp = new Date().toISOString();
  const common = {
    schemaVersion: 1, runId, timestamp, sessionId: run.sessionId, host: run.host,
    policyVersion: POLICY_VERSION, questionVersion: QUESTION_VERSION,
  };
  const lines = [
    { ...common, type: "run", inputHash: run.inputHash, outputHash: run.outputHash,
      policy: run.policy, requestedModel: run.requestedModel,
      beforeBytes: run.beforeBytes, afterBytes: run.afterBytes,
      byteReduction: run.beforeBytes ? 1 - run.afterBytes / run.beforeBytes : 0,
      requests: run.plan.requests, scoringInputTokens: run.plan.inputTokens,
      scoringOutputTokens: run.plan.outputTokens, outcome: run.plan.outcome,
      failure: run.plan.failure ?? null },
    ...run.plan.decisions.map(decision => ({ ...common, type: "decision", ...decision })),
    // This records an emitted context proposal, not proof of provider acceptance.
    { ...common, type: "ready", decisions: run.plan.decisions.length },
  ];
  const path = join(directory, `${runId}.jsonl`);
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  // Ensure creation of the run file is committed before returning filtered context.
  const dir = await open(directory, "r");
  try { await dir.sync(); } finally { await dir.close(); }
  return path;
}
