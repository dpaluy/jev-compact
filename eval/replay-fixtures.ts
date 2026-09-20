import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { assistant, call, result, user } from "../test/helpers.js";
import type { ReplaySnapshot } from "./replay.js";

/** Deterministic workload shapes, not captured user sessions. */
export function replayFixtures(): { id: string; snapshots: ReplaySnapshot[] }[] {
  return ["tool-heavy", "text-heavy", "oversized-results"].map(id => {
    let messages: AgentMessage[] = [user("Inspect the failing parser. Preserve exact errors and constraints.")];
    const snapshots: ReplaySnapshot[] = [];
    for (let turn = 0; turn < 24; turn++) {
      // Supply an explicit common host compaction boundary, not a Jev fallback.
      if (turn === 12) messages = [
        { role: "compactionSummary", summary: "Earlier inspection completed; parser contract still applies.", tokensBefore: 110_000, timestamp: 12 },
        ...messages.slice(-8),
      ];
      if (turn % 3 === 0) messages.push(user(`Continue inspection task ${turn / 3}.`));
      const count = id === "tool-heavy" ? 3 : 1;
      for (let index = 0; index < count; index++) {
        const traceId = `${id}-${turn}-${index}`;
        const output = "Parser inspection output.\n".repeat(id === "oversized-results" ? 1300 : id === "tool-heavy" ? 460 : 100);
        messages.push(assistant([call(traceId, { path: `src/parser-${index}.ts` })]), result(traceId, output));
      }
      messages.push(assistant([{ type: "text", text: "Inspection notes: preserve the public parser contract.\n".repeat(id === "text-heavy" ? 75 : 1) }]));
      snapshots.push({ id: `${id}-${turn}`, cwd: "/offline/replay", systemPrompt: "Follow the project rules.\n".repeat(160),
        contextWindow: id === "tool-heavy" ? 128_000 : 32_000, messages: [...messages] });
    }
    return { id, snapshots };
  });
}
