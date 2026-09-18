import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import type { RunOutcome, RunOutcomeCode } from "./scheduler.js";

export const POLICY_VERSION = "keep-drop-v1";

export interface Trace {
  tool: string;
  input: Record<string, unknown>;
  output: string;
  sourceIndex?: number;
  isError?: boolean;
}

/** The adapter owns message shape and reconstruction. The core owns policy. */
export interface Item {
  id: string;
  hash: string;
  trace?: Trace;
  paths?: string[];
  protectedReason?: string;
}

export interface Scores {
  keep: number;
  constraint: number;
}

export interface Judgment {
  scores: Scores;
  model: string;
}

export interface ScoreResult {
  judgments: Map<string, Judgment>;
  skipped: Map<string, string>;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Scorer {
  score(context: unknown, items: readonly Item[], signal?: AbortSignal, identity?: string): Promise<ScoreResult>;
  /** Discard reusable judgments after an application failure. */
  clearCache?(): void;
}

export interface Policy {
  keepThreshold: number;
  pinPaths: string[];
}

export const DEFAULT_POLICY: Policy = {
  keepThreshold: 0.2,
  pinPaths: ["**/AGENTS.md", "**/.env", "**/.env.*"],
};

export interface Decision {
  itemId: string;
  snippetHash: string;
  action: "keep" | "drop";
  reason: string;
  scores: Scores | null;
  threshold: number;
  model: string | null;
}

export interface Plan {
  decisions: Decision[];
  dropped: Set<string>;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  outcome: RunOutcome;
  failure?: string;
}

export function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validatePolicy(policy: Policy): void {
  if (!validProbability(policy.keepThreshold) || policy.keepThreshold > 0.5) {
    throw new Error("keepThreshold must be between 0 and 0.5; uncertain judgments must keep content");
  }
  if (!Array.isArray(policy.pinPaths) || !policy.pinPaths.every(p => typeof p === "string" && p.length > 0)) {
    throw new Error("pinPaths must contain non-empty glob strings");
  }
}

export function itemProtectionReason(item: Item, policy: Policy): string {
  const pin = item.paths?.some(path => policy.pinPaths.some(pattern => matchesGlob(path, pattern)));
  return item.protectedReason ?? (pin ? "path-pin" : !item.trace ? "non-tool" : "pending");
}

export function eligibleItems(items: readonly Item[], policy: Policy): Item[] {
  return items.filter(item => itemProtectionReason(item, policy) === "pending");
}

function outcomeFor(decisions: readonly Decision[], eligibleIds: ReadonlySet<string>, result: ScoreResult, failure?: string): RunOutcome {
  const eligible = decisions.filter(decision => eligibleIds.has(decision.itemId));
  const assessed = eligible.filter(decision => decision.scores !== null).length;
  const dropped = eligible.filter(decision => decision.action === "drop").length;
  const skipped = eligible.length - assessed;
  let code: RunOutcomeCode;
  if (failure === "cancelled") code = "cancelled";
  else if (failure) code = "scoring-error";
  else if (eligible.length === 0) code = "no-eligible";
  else if (dropped > 0) code = "success";
  else if ([...result.skipped.values()].includes("context-too-large")) code = "context-too-large";
  else if ([...result.skipped.values()].includes("candidate-too-large")) code = "candidate-too-large";
  else if ([...result.skipped.values()].includes("request-budget")) code = "request-budget";
  else code = "no-beneficial-drops";
  return { code, eligible: eligible.length, assessed, dropped, skipped, requests: failure ? null : result.requests };
}

export async function planPrune(
  items: readonly Item[], context: unknown, scorer: Scorer, policy: Policy, signal?: AbortSignal, snapshotIdentity?: string,
): Promise<Plan> {
  validatePolicy(policy);
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("Duplicate item IDs");
  const decisions: Decision[] = items.map(item => ({
    itemId: item.id, snippetHash: item.hash, action: "keep",
    reason: itemProtectionReason(item, policy),
    scores: null, threshold: policy.keepThreshold, model: null,
  }));
  const eligible = items.filter((_, i) => decisions[i]!.reason === "pending");
  let result: ScoreResult = { judgments: new Map(), skipped: new Map(), requests: 0, inputTokens: 0, outputTokens: 0 };
  let failure: string | undefined;
  try {
    signal?.throwIfAborted();
    if (eligible.length) result = await scorer.score(context, eligible, signal, hash({ context, policy, snapshotIdentity }));
    signal?.throwIfAborted();
    // Validate the complete batch before accepting any deletion.
    const ids = new Set(eligible.map(item => item.id));
    for (const id of [...result.judgments.keys(), ...result.skipped.keys()]) {
      if (!ids.has(id)) throw new Error("Unexpected judgment ID");
    }
    for (const item of eligible) {
      const judgment = result.judgments.get(item.id);
      if (judgment && result.skipped.has(item.id)) throw new Error("Conflicting judgment");
      if (!judgment && !result.skipped.has(item.id)) throw new Error("Missing judgment");
      if (judgment && (!validProbability(judgment.scores.keep) || !validProbability(judgment.scores.constraint) || !judgment.model.trim())) {
        throw new Error("Invalid judgment");
      }
    }
  } catch {
    // Never echo provider errors: they may contain prompts or credentials.
    failure = signal?.aborted ? "cancelled" : "scoring-failed";
  }
  for (const decision of decisions) {
    if (decision.reason !== "pending") continue;
    const judgment = result.judgments.get(decision.itemId);
    if (failure || !judgment) {
      decision.reason = failure ?? result.skipped.get(decision.itemId) ?? "unscored";
      continue;
    }
    decision.scores = judgment.scores;
    decision.model = judgment.model;
    const keep = Math.max(judgment.scores.keep, judgment.scores.constraint) >= policy.keepThreshold;
    decision.action = keep ? "keep" : "drop";
    decision.reason = keep ? "score-keep" : "score-drop";
  }
  return {
    decisions, dropped: new Set(decisions.filter(d => d.action === "drop").map(d => d.itemId)),
    requests: failure ? null : result.requests,
    inputTokens: failure ? null : result.inputTokens,
    outputTokens: failure ? null : result.outputTokens,
    outcome: outcomeFor(decisions, new Set(eligible.map(item => item.id)), result, failure), failure,
  };
}
