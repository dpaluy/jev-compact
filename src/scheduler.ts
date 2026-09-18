export type UsageSource = "current" | "estimated" | "stale" | "unknown";

export interface HostContextUsage {
  capacityTokens: number | null;
  usedTokens: number | null;
  source: UsageSource;
}

export type RunOutcomeCode =
  | "disabled"
  | "not-ready"
  | "waiting-pressure"
  | "usage-unknown"
  | "waiting-cadence"
  | "no-eligible"
  | "context-too-large"
  | "candidate-too-large"
  | "request-budget"
  | "no-beneficial-drops"
  | "cancelled"
  | "scoring-error"
  | "audit-error"
  | "success";

export interface RunOutcome {
  code: RunOutcomeCode;
  eligible: number;
  assessed: number;
  dropped: number;
  skipped: number;
  requests: number | null;
  detail?: string;
}

export interface ScheduleInput {
  enabled: boolean;
  ready: boolean;
  usage: HostContextUsage;
  pressureThreshold: number;
  eligible: number;
  eligibleBytes: number;
  minContextBytes: number;
  cycleKey: string;
  contentKey: string;
}

/**
 * Bounds automatic work to one changing snapshot per user/task cycle. An exact
 * snapshot may continue only while the previous pass hit its request budget;
 * this lets the scorer's bounded cache advance fairly without rescoring calls.
 * Changed snapshots at 90% pressure bypass cadence to avoid sending an almost
 * full original snapshot just because an earlier projection freed space.
 */
export class PruneScheduler {
  private cycleKey?: string;
  private contentKey?: string;
  private continuation = false;

  reset(): void {
    this.cycleKey = undefined;
    this.contentKey = undefined;
    this.continuation = false;
  }

  decide(input: ScheduleInput): RunOutcome | undefined {
    const base = { eligible: input.eligible, assessed: 0, dropped: 0, skipped: input.eligible, requests: 0 };
    if (!input.enabled) return { code: "disabled", ...base };
    if (!input.ready) return { code: "not-ready", ...base };
    if (input.usage.source === "unknown" || input.usage.source === "stale" || input.usage.capacityTokens === null || input.usage.usedTokens === null || !Number.isFinite(input.usage.capacityTokens) || !Number.isFinite(input.usage.usedTokens) || input.usage.capacityTokens <= 0 || input.usage.usedTokens < 0) {
      return { code: "usage-unknown", ...base, detail: input.usage.source === "stale" ? "stale usage is not used" : "current model usage is unavailable" };
    }
    const pressure = input.usage.usedTokens / input.usage.capacityTokens;
    if (!Number.isFinite(pressure) || pressure < input.pressureThreshold) {
      return { code: "waiting-pressure", ...base, detail: `${Math.max(0, pressure * 100).toFixed(0)}% < ${(input.pressureThreshold * 100).toFixed(0)}%` };
    }
    if (input.eligible === 0) return { code: "no-eligible", ...base, skipped: 0 };
    if (input.eligibleBytes < input.minContextBytes) {
      return { code: "waiting-pressure", ...base, detail: `${input.eligibleBytes} eligible bytes < ${input.minContextBytes}` };
    }
    if (this.cycleKey === input.cycleKey) {
      if (this.contentKey !== input.contentKey && pressure >= 0.9) return undefined;
      if (this.contentKey !== input.contentKey || !this.continuation) {
        return { code: "waiting-cadence", ...base, detail: "already assessed this task cycle" };
      }
    }
    return undefined;
  }

  record(cycleKey: string, contentKey: string, outcome: RunOutcome, hasRequestBudget = outcome.code === "request-budget"): void {
    this.cycleKey = cycleKey;
    this.contentKey = contentKey;
    this.continuation = hasRequestBudget;
  }
}

export function summarizeOutcome(outcome: RunOutcome): string {
  const counts = `${outcome.dropped} dropped, ${outcome.assessed} assessed, ${outcome.skipped} unassessed`;
  const suffix = outcome.detail ? `; ${outcome.detail}` : "";
  switch (outcome.code) {
    case "success": return `pruned successfully: ${counts}${suffix}`;
    case "disabled": return "disabled; original context is used";
    case "not-ready": return `requested but not ready${outcome.detail ? `: ${outcome.detail}` : ""}`;
    case "waiting-pressure": return `waiting below pressure threshold${outcome.detail ? ` (${outcome.detail})` : ""}`;
    case "usage-unknown": return `waiting: context pressure is unknown${outcome.detail ? ` (${outcome.detail})` : ""}`;
    case "waiting-cadence": return `waiting for the next task cycle (${counts})`;
    case "no-eligible": return "no eligible tool traces; original context is used";
    case "context-too-large": return `unable to assess: protected scorer context exceeds the request envelope (${counts})${suffix}`;
    case "candidate-too-large": return `unable to assess one or more complete candidates (${counts})${suffix}`;
    case "request-budget": return `request budget reached (${counts})${suffix}`;
    case "no-beneficial-drops": return `assessed with no beneficial drops (${counts})${suffix}`;
    case "cancelled": return "pruning cancelled; original context is used";
    case "scoring-error": return "scoring failed; original context is used";
    case "audit-error": return "audit failed; original context is used";
  }
}
