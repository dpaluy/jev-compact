import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { eligibleItems, hash, planPrune, type Scorer } from "../core.js";
import { createJevScorer } from "../jev.js";
import { writeAudit } from "../audit.js";
import { PruneScheduler, summarizeOutcome, type RunOutcome } from "../scheduler.js";
import { estimatePiUsage } from "./usage.js";
import { snapshotPi } from "./adapter.js";
import { loadPiConfig, type Config } from "./config.js";

/** Dependencies are injectable for offline host integration tests. */
export interface Dependencies {
  scorer?: Scorer;
  audit?: typeof writeAudit;
  config?: Config;
}

function taskCycleKey(messages: readonly unknown[]): string {
  let latestUser = -1;
  messages.forEach((message, index) => {
    if (typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user") latestUser = index;
  });
  return hash(messages.slice(0, latestUser + 1));
}

function actionable(code: RunOutcome["code"]): boolean {
  return ["not-ready", "no-eligible", "context-too-large", "candidate-too-large", "request-budget", "no-beneficial-drops", "scoring-error", "audit-error"].includes(code);
}

export function registerPruner(pi: ExtensionAPI, dependencies: Dependencies = {}): void {
  // Pi boolean extension flags have no --no-X negation, so disable is a
  // separate explicit flag. No defaults preserves whether a CLI override exists.
  pi.registerFlag("jev-prune", { type: "boolean", description: "Enable audited context pruning. Sends text to TypeSafe." });
  pi.registerFlag("no-jev-prune", { type: "boolean", description: "Disable Jev pruning, overriding saved settings." });
  pi.registerFlag("jev-prune-config", { type: "string", description: "Explicit path to Jev pruning JSON config" });

  let requested = false;
  let ready = false;
  let config: Config | undefined;
  let scorer: Scorer | undefined;
  let outcome: RunOutcome = { code: "disabled", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0 };
  let warned = false;
  let generation = 0;
  let lastProjection: { key: string; dropped: Set<string>; outcome: RunOutcome; pending: boolean } | undefined;
  const scheduler = new PruneScheduler();

  const notify = (ctx: ExtensionContext, text: string, warning = false) => {
    if (ctx.hasUI) ctx.ui.notify(`jev-compact: ${text}`, warning ? "warning" : "info");
    else console.error(`jev-compact: ${text}`);
  };
  const warnOnce = (ctx: ExtensionContext, text: string) => {
    if (!warned) { notify(ctx, text, true); warned = true; }
  };
  const setOutcome = (next: RunOutcome) => {
    outcome = next;
    return summarizeOutcome(next);
  };

  pi.on("session_start", async (_event, ctx) => {
    generation++;
    scheduler.reset();
    lastProjection = undefined;
    warned = false;
    config = undefined;
    scorer = undefined;
    ready = false;
    try {
      const configFlag = pi.getFlag("jev-prune-config");
      config = dependencies.config ?? (await loadPiConfig({
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        explicitPath: typeof configFlag === "string" ? resolve(ctx.cwd, configFlag) : undefined,
      })).config;
      requested = config.enabled;
      if (pi.getFlag("jev-prune") === true) requested = true;
      if (pi.getFlag("no-jev-prune") === true) requested = false;
      const key = process.env.TYPESAFE_API_KEY?.trim();
      scorer = dependencies.scorer ?? (key ? createJevScorer({ ...config, apiKey: key }) : undefined);
      ready = !requested || scorer !== undefined;
      if (!requested) setOutcome({ code: "disabled", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0 });
      else if (!ready) {
        const text = setOutcome({ code: "not-ready", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0, detail: "TYPESAFE_API_KEY is missing" });
        warnOnce(ctx, `${text}; pruning is inactive and normal /compact remains available`);
      } else {
        setOutcome({ code: "waiting-pressure", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0 });
        notify(ctx, "pruning requested and ready");
      }
    } catch {
      requested = pi.getFlag("jev-prune") === true && pi.getFlag("no-jev-prune") !== true;
      ready = false;
      config = undefined;
      const text = setOutcome({ code: "not-ready", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0, detail: "configuration is invalid" });
      warnOnce(ctx, `${text}; fix settings/config and /reload. Normal /compact remains available`);
    }
  });

  pi.on("session_shutdown", () => {
    generation++;
    ready = false;
    lastProjection = undefined;
    scorer?.clearCache?.();
    scheduler.reset();
  });

  pi.registerCommand("jev-prune", {
    description: "on | off | status. Enabling sends context and tool output to TypeSafe.",
    handler: async (args, ctx) => {
      switch (args.trim()) {
        case "on": {
          if (!config) { notify(ctx, "configuration is invalid; fix it and /reload", true); return; }
          if (!scorer) {
            const key = process.env.TYPESAFE_API_KEY?.trim();
            if (!key) {
              requested = true;
              ready = false;
              generation++;
              setOutcome({ code: "not-ready", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0, detail: "TYPESAFE_API_KEY is missing" });
              notify(ctx, "pruning requested but inactive: TYPESAFE_API_KEY is missing; /compact remains available", true);
              return;
            }
            scorer = createJevScorer({ ...config, apiKey: key });
          }
          requested = true;
          ready = true;
          warned = false;
          generation++;
          scheduler.reset();
          lastProjection = undefined;
          setOutcome({ code: "waiting-pressure", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0 });
          break;
        }
        case "off":
          requested = false;
          ready = true;
          scorer?.clearCache?.();
          if (!dependencies.scorer) scorer = undefined;
          generation++;
          scheduler.reset();
          lastProjection = undefined;
          setOutcome({ code: "disabled", eligible: 0, assessed: 0, dropped: 0, skipped: 0, requests: 0 });
          break;
        case "": case "status": break;
        default: notify(ctx, "use /jev-prune on | off | status"); return;
      }
      notify(ctx, `${!requested ? "off" : ready ? "on" : "requested (inactive)"}: ${summarizeOutcome(outcome)}`);
    },
  });

  pi.on("context", async (event, ctx) => {
    if (!requested || !ready || !config || !scorer) return;
    const currentGeneration = generation;
    const systemPrompt = ctx.getSystemPrompt();
    try {
      const snapshot = snapshotPi(event.messages, systemPrompt, ctx.cwd, config.preserveRecentMessages);
      const policy = { keepThreshold: config.keepThreshold, pinPaths: config.pinPaths };
      const eligible = eligibleItems(snapshot.items, policy);
      const eligibleBytes = eligible.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item.trace)), 0);
      const cycleKey = taskCycleKey(event.messages);
      const activeTools = new Set(pi.getActiveTools());
      const tools = pi.getAllTools().filter(tool => activeTools.has(tool.name))
        .map(({ name, description, parameters }) => ({ name, description, parameters }));
      const contentKey = hash({ messages: event.messages, systemPrompt, tools, config, model: ctx.model });
      if (ctx.signal?.aborted) {
        setOutcome({ code: "cancelled", eligible: eligible.length, assessed: 0, dropped: 0, skipped: eligible.length, requests: 0 });
        return;
      }
      if (lastProjection?.key === contentKey && !lastProjection.pending) {
        setOutcome({ ...lastProjection.outcome, requests: 0 });
        return { messages: snapshot.apply(lastProjection.dropped) };
      }
      const deferred = scheduler.decide({
        enabled: requested,
        ready,
        usage: estimatePiUsage(event.messages, systemPrompt, tools, ctx.model?.contextWindow, ctx.getContextUsage()),
        pressureThreshold: config.pressureThreshold,
        eligible: eligible.length,
        eligibleBytes,
        minContextBytes: config.minContextBytes,
        cycleKey,
        contentKey,
      });
      if (deferred) {
        setOutcome(deferred);
        if (actionable(deferred.code)) warnOnce(ctx, `${summarizeOutcome(deferred)}. Use /compact or start a new session if more space is needed.`);
        return;
      }

      const beforeBytes = Buffer.byteLength(JSON.stringify(event.messages));
      const plan = await planPrune(snapshot.items, snapshot.context, scorer, policy, ctx.signal, contentKey);
      if (currentGeneration !== generation || !requested || !ready) return;
      if (ctx.signal?.aborted) {
        scorer.clearCache?.();
        lastProjection = undefined;
        setOutcome({ code: "cancelled", eligible: eligible.length, assessed: 0, dropped: 0, skipped: eligible.length, requests: plan.requests });
        return;
      }
      const messages = snapshot.apply(plan.dropped);
      const afterBytes = Buffer.byteLength(JSON.stringify(messages));
      const sessionFile = ctx.sessionManager.getSessionFile();
      const directory = sessionFile ? `${sessionFile}.jev-prune` : join(getAgentDir(), "jev-prune", hash(ctx.sessionManager.getSessionId()));
      let auditPath: string;
      try {
        auditPath = await (dependencies.audit ?? writeAudit)(directory, {
          host: "pi", sessionId: ctx.sessionManager.getSessionId(),
          inputHash: hash({ messages: event.messages, systemPrompt }), outputHash: hash(messages),
          policy, requestedModel: config.model, beforeBytes, afterBytes, plan,
        });
      } catch {
        if (currentGeneration !== generation || !requested || !ready) return;
        const failed: RunOutcome = { code: ctx.signal?.aborted ? "cancelled" : "audit-error", eligible: plan.outcome.eligible, assessed: plan.outcome.assessed, dropped: 0, skipped: plan.outcome.eligible, requests: plan.requests };
        scorer.clearCache?.();
        lastProjection = undefined;
        scheduler.record(cycleKey, contentKey, failed);
        setOutcome(failed);
        warnOnce(ctx, `${summarizeOutcome(failed)}. Original context retained; a new task retries, or use /jev-prune on to retry now`);
        return;
      }
      if (currentGeneration !== generation || !requested || !ready) return;
      if (ctx.signal?.aborted) {
        scorer.clearCache?.();
        lastProjection = undefined;
        setOutcome({ code: "cancelled", eligible: eligible.length, assessed: 0, dropped: 0, skipped: eligible.length, requests: plan.requests });
        return;
      }
      const pending = plan.decisions.some(decision => decision.reason === "request-budget");
      scheduler.record(cycleKey, contentKey, plan.outcome, pending);
      const recorded = { ...plan.outcome, detail: plan.outcome.code === "success"
        ? `${Math.round((1 - afterBytes / beforeBytes) * 100)}% fewer serialized bytes; log: ${auditPath}`
        : `log: ${auditPath}` };
      lastProjection = { key: contentKey, dropped: new Set(plan.dropped), outcome: recorded, pending };
      const summary = setOutcome(recorded);
      if (actionable(plan.outcome.code)) warnOnce(ctx, `${summary}. Use /compact or start a new session if more space is needed.`);
      else warned = false;
      return { messages };
    } catch {
      if (currentGeneration !== generation || !requested || !ready) return;
      const failed: RunOutcome = { code: ctx.signal?.aborted ? "cancelled" : "scoring-error", eligible: outcome.eligible, assessed: 0, dropped: 0, skipped: outcome.eligible, requests: null };
      scorer?.clearCache?.();
      lastProjection = undefined;
      setOutcome(failed);
      warnOnce(ctx, `${summarizeOutcome(failed)}. Original context retained`);
      return;
    }
  });
}

export default function (pi: ExtensionAPI): void { registerPruner(pi); }
