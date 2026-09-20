import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isObject } from "../src/jev.js";
import { parseReplaySnapshots, type ReplaySnapshot } from "./replay.js";

type Tools = NonNullable<ReplaySnapshot["tools"]>;
export interface SessionReader {
  version: string;
  buildMessages(entries: SessionEntry[], leafId: string | null): unknown[];
  systemState?: (messages: unknown[]) => { prompt: string; tools: Tools } | undefined;
}

export interface ExportOptions {
  leafId?: string;
  contextWindow?: number;
  modelWindows?: ReadonlyMap<string, number>;
  /** Explicit historical fallbacks, used only where system state was not recorded. */
  systemPrompt?: string;
  tools?: Tools;
}

export function modelWindowsFromStore(raw: unknown): Map<string, number> {
  if (!isObject(raw)) throw new Error("Expected a Pi model-store object");
  const windows = new Map<string, number>();
  for (const [provider, entry] of Object.entries(raw)) {
    if (!isObject(entry) || !Array.isArray(entry.models)) continue;
    for (const model of entry.models) {
      if (isObject(model) && typeof model.id === "string" && Number.isSafeInteger(model.contextWindow) && (model.contextWindow as number) > 0) {
        windows.set(`${provider}/${model.id}`, model.contextWindow as number);
      }
    }
  }
  return windows;
}

/** Strict, read-only export. Never use SessionManager.open(): it can repair files.
 * Context selection is delegated to the caller's matching Pi SDK, not flattened.
 */
export function exportSession(content: string, reader: SessionReader, options: ExportOptions = {}) {
  const records: Record<string, unknown>[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { throw new Error(`Invalid session JSON at line ${index + 1}; copy a complete file and retry`); }
    if (!isObject(record)) throw new Error(`Invalid session record at line ${index + 1}`);
    records.push(record);
  }
  const header = records[0];
  if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" || typeof header.cwd !== "string") {
    throw new Error("Expected a Pi v3 session header with id and cwd");
  }
  if (options.contextWindow !== undefined && (!Number.isSafeInteger(options.contextWindow) || options.contextWindow <= 0)) {
    throw new Error("contextWindow must be a positive integer");
  }
  const entries = records.slice(1);
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (typeof entry.id !== "string" || !entry.id || byId.has(entry.id) ||
      (entry.parentId !== null && (typeof entry.parentId !== "string" || !byId.has(entry.parentId)))) {
      throw new Error("Session contains a duplicate id, missing parent, or invalid tree order");
    }
    byId.set(entry.id, entry);
  }
  const leafId = options.leafId ?? entries.at(-1)?.id;
  if (typeof leafId !== "string" || !byId.has(leafId)) throw new Error("Selected session leaf does not exist");
  const branch = [];
  for (let entry = byId.get(leafId); entry; entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined) branch.push(entry);
  branch.reverse();
  const hasSystem = branch.some(entry => entry.type === "message" && isObject(entry.message) && entry.message.role === "system" ||
    entry.type === "compaction" && entry.systemMessage !== undefined);
  if (hasSystem && !reader.systemState) throw new Error("This session records system state. Select its matching Pi SDK with --pi-package (0.86+ required)");
  // A missing retained boundary makes native reconstruction silently omit context.
  const ancestors = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "compaction" && (typeof entry.firstKeptEntryId !== "string" || !ancestors.has(entry.firstKeptEntryId))) {
      throw new Error("Compaction retained boundary is not on the selected ancestor path");
    }
    ancestors.add(entry.id as string);
  }

  const snapshots: ReplaySnapshot[] = [];
  let suppliedSystemSnapshots = 0;
  const models = new Map<string, { provider: string; id: string; contextWindow: number; windowSource: string }>();
  for (const entry of branch) {
    if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "assistant") continue;
    const assistant = entry.message;
    if (typeof assistant.provider !== "string" || typeof assistant.model !== "string") throw new Error("Assistant record has no provider/model identity");
    const modelKey = `${assistant.provider}/${assistant.model}`;
    const contextWindow = options.contextWindow ?? options.modelWindows?.get(modelKey);
    if (!contextWindow) throw new Error(`Unknown context window for ${modelKey}; supply --models-file or --context-window explicitly`);
    const messages = reader.buildMessages(entries as unknown as SessionEntry[], entry.parentId as string | null);
    const system = reader.systemState?.(messages);
    if (!system && (options.systemPrompt === undefined || options.tools === undefined)) {
      throw new Error("System prompt or tools were not recorded. Supply historical --system-prompt and --tools files; empty context will not be assumed");
    }
    if (!system) suppliedSystemSnapshots++;
    // Keep system messages in the native transcript as well as its resolved prompt.
    // The real context hook sees both. Removing them understates scorer input size.
    const snapshot = parseReplaySnapshots([{
      id: entry.id, cwd: header.cwd, systemPrompt: system?.prompt ?? options.systemPrompt,
      tools: system?.tools ?? options.tools, contextWindow,
      model: { provider: assistant.provider, id: assistant.model }, messages,
    }])[0]!;
    snapshots.push(snapshot);
    models.set(modelKey, { provider: assistant.provider, id: assistant.model, contextWindow,
      windowSource: options.contextWindow === undefined ? "local-catalog" : "explicit-override" });
  }
  if (!snapshots.length) throw new Error("Selected branch contains no assistant requests");
  return {
    snapshots,
    report: {
      sourceSha256: createHash("sha256").update(content).digest("hex"), sessionId: header.id,
      sdkVersion: reader.version, leafId, branchEntries: branch.length, snapshots: snapshots.length,
      compactions: branch.filter(entry => entry.type === "compaction").length,
      suppliedSystemSnapshots, models: [...models.values()],
      warnings: [
        "Reconstructed persisted contexts, not captured provider payloads. Unrecorded extension mutations and historical model-window overrides cannot be recovered.",
        ...(suppliedSystemSnapshots ? ["Some prompt/tool state was supplied, not recovered from the session."] : []),
        ...(options.contextWindow === undefined ? ["Window sizes come from the current local catalog, not historical request metadata."] : []),
      ],
    },
  };
}
