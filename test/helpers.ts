import type { AssistantMessage, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { Item, Scorer, Scores } from "../src/core.js";

export const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 1 });
export const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "openai-responses", provider: "test", model: "test", usage, stopReason: "stop", timestamp: 2,
});
export const call = (id: string, input: Record<string, unknown> = { path: "src/a.ts" }): ToolCall => ({
  type: "toolCall", id, name: "read", arguments: input,
});
export const result = (id: string, text = "old progress output"): ToolResultMessage => ({
  role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: 3,
});
export const conversation = (): (UserMessage | AssistantMessage | ToolResultMessage)[] => [
  user("Never edit .env. Preserve the public API."),
  assistant([{ type: "text", text: "Inspecting the implementation." }, call("old")]), result("old"),
  user("Continue with the fix."),
];
export function fakeScorer(judge: (item: Item) => Scores = () => ({ keep: 0.01, constraint: 0.01 })): Scorer {
  return { async score(_context, items) {
    return { judgments: new Map(items.map(item => [item.id, { scores: judge(item), model: "fake-offline" }])),
      skipped: new Map(), requests: 0, inputTokens: 0, outputTokens: 0 };
  } };
}
