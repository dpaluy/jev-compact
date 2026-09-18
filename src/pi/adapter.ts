import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { posix } from "node:path";
import { hash, type Item } from "../core.js";
import { isObject } from "../jev.js";

interface Call {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  type: "toolCall";
}

interface LocatedCall { call: Call; index: number; safe: boolean }

export interface Snapshot {
  items: Item[];
  context: unknown;
  apply(dropped: ReadonlySet<string>): AgentMessage[];
}

function pathArguments(input: Record<string, unknown>, cwd: string): string[] {
  const paths: string[] = [];
  for (const key of ["path", "file_path", "filePath", "paths", "files"]) {
    const value = input[key];
    for (const p of Array.isArray(value) ? value : [value]) {
      if (typeof p !== "string") continue;
      const normalized = posix.normalize(p.replaceAll("\\", "/"));
      paths.push(normalized);
      if (posix.isAbsolute(normalized)) paths.push(posix.relative(cwd.replaceAll("\\", "/"), normalized));
      else paths.push(posix.resolve(cwd, normalized));
    }
  }
  return paths;
}

/** Native objects are retained. Only known, complete call/result pairs can be removed. */
export function snapshotPi(
  messages: readonly AgentMessage[], systemPrompt: string, cwd: string, preserveRecentMessages = 6,
): Snapshot {
  const calls = new Map<string, LocatedCall[]>();
  const results = new Map<string, number[]>();
  const items: Item[] = [];
  const history: unknown[] = [];
  let nonTextContext = false;
  const protectedItem = (id: string, value: unknown, reason: string) => {
    items.push({ id, hash: hash(value), protectedReason: reason });
  };
  const recentFrom = messages.length - preserveRecentMessages;
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      // Signed/opaque blocks can bind to tool calls. Never break those groups.
      const safe = message.content.every(block => {
        if (block.type === "toolCall") return !block.thoughtSignature;
        if (block.type === "text") return !block.textSignature;
        if (block.type === "thinking") return !block.thinkingSignature && !block.redacted;
        return false;
      });
      const nonTools = message.content.filter(block => block.type !== "toolCall");
      if (nonTools.some(block => block.type !== "text" && block.type !== "thinking")) nonTextContext = true;
      if (nonTools.length) {
        protectedItem(`message:${index}`, nonTools, "non-tool");
        history.push({ sourceIndex: index, role: message.role, content: nonTools });
      }
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (!block.id || !block.name || !isObject(block.arguments)) throw new Error("Invalid Pi tool call");
        const list = calls.get(block.id) ?? [];
        list.push({ call: block, index, safe });
        calls.set(block.id, list);
      }
    } else if (message.role === "toolResult") {
      const list = results.get(message.toolCallId) ?? [];
      list.push(index);
      results.set(message.toolCallId, list);
    } else {
      protectedItem(`message:${index}`, message, message.role === "user" ? "user-message" : "non-tool");
      if ("content" in message && Array.isArray(message.content) && message.content.some(block => block.type !== "text")) {
        nonTextContext = true;
      }
      history.push({ sourceIndex: index, message });
    }
  });
  const removals = new Map<string, { callIndex: number; resultIndex: number; callId: string }>();
  for (const [id, located] of calls) {
    const resultIndices = results.get(id) ?? [];
    const first = located[0]!;
    const resultIndex = resultIndices[0];
    const result = resultIndex === undefined ? undefined : messages[resultIndex];
    let reason: string | undefined;
    if (located.length !== 1 || resultIndices.length > 1) reason = "ambiguous-pair";
    else if (!result || result.role !== "toolResult") reason = "incomplete-pair";
    else if (resultIndex! <= first.index || result.toolName !== first.call.name) reason = "invalid-pair";
    else if (!first.safe || !result.content.every(b => b.type === "text") || result.addedToolNames?.length) reason = "opaque-content";
    else if (first.index >= recentFrom || resultIndex! >= recentFrom) reason = "recent";
    const text = result?.role === "toolResult" ? result.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "";
    const itemId = `tool:${id}`;
    items.push({
      id: itemId,
      hash: hash({ calls: located.map(c => c.call), results: resultIndices.map(i => messages[i]) }),
      paths: pathArguments(first.call.arguments, cwd),
      protectedReason: reason,
      trace: { tool: first.call.name, input: first.call.arguments, output: text, sourceIndex: first.index, isError: result?.role === "toolResult" ? result.isError : undefined },
    });
    if (!reason) removals.set(itemId, { callIndex: first.index, resultIndex: resultIndex!, callId: id });
  }
  for (const [id, indices] of results) {
    if (calls.has(id)) continue;
    for (const index of indices) protectedItem(`orphan:${index}`, messages[index], "orphan-result");
  }
  if (nonTextContext) {
    for (const item of items) item.protectedReason ??= "non-text-context";
    removals.clear();
  }
  return {
    items,
    context: { systemPrompt, history },
    apply(dropped) {
      const resultIndices = new Set<number>();
      const callIds = new Map<number, Set<string>>();
      for (const id of dropped) {
        const removal = removals.get(id);
        if (!removal) throw new Error("Cannot remove protected or unknown Pi item");
        resultIndices.add(removal.resultIndex);
        const ids = callIds.get(removal.callIndex) ?? new Set();
        ids.add(removal.callId);
        callIds.set(removal.callIndex, ids);
      }
      return messages.flatMap((message, index): AgentMessage[] => {
        if (resultIndices.has(index)) return [];
        const ids = callIds.get(index);
        if (!ids || message.role !== "assistant") return [message];
        const content = message.content.filter(block => block.type !== "toolCall" || !ids.has(block.id));
        return content.length ? [{ ...message, content }] : [];
      });
    },
  };
}
