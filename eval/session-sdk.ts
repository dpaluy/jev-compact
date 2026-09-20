import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SessionReader } from "./session.js";

/** Load only pure session/transcript helpers. No agent, resources, credentials,
 * provider runtime, session file repair, or network refresh is started.
 */
export async function loadSessionReader(packageDirectory?: string): Promise<SessionReader> {
  const root = packageDirectory ? resolve(packageDirectory)
    : resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (metadata.name !== "@earendil-works/pi-coding-agent") throw new Error("--pi-package must name a Pi coding-agent package directory");
  const entry = join(root, metadata.exports["."].import);
  const sdk = await import(pathToFileURL(entry).href);
  // These packages expose ESM-only entry points, so require.resolve(package)
  // cannot resolve them. Search Node's dependency locations, then use import.
  let aiEntry: string | undefined;
  for (const path of createRequire(entry).resolve.paths("@earendil-works/pi-ai") ?? []) {
    const aiRoot = join(path, "@earendil-works/pi-ai");
    try {
      const aiMetadata = JSON.parse(await readFile(join(aiRoot, "package.json"), "utf8"));
      aiEntry = join(aiRoot, aiMetadata.exports["."].import);
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (!aiEntry) throw new Error("Cannot locate the selected Pi SDK's pi-ai dependency");
  const ai = await import(pathToFileURL(aiEntry).href);
  return {
    version: metadata.version,
    buildMessages: (entries, leafId) => sdk.buildSessionContext(entries, leafId).messages,
    systemState: typeof ai.getCurrentSystemMessage === "function" && typeof ai.getSystemMessageText === "function"
      ? messages => {
        const system = ai.getCurrentSystemMessage(messages);
        return system ? { prompt: ai.getSystemMessageText(system), tools: (system.toolsAdded ?? []).map(
          (tool: { name: string; description: string; parameters: unknown }) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }),
        ) } : undefined;
      }
      : undefined,
  };
}
