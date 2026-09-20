import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { exportSession, modelWindowsFromStore } from "./session.js";
import { loadSessionReader } from "./session-sdk.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  out: { type: "string" }, leaf: { type: "string" }, "pi-package": { type: "string" },
  "system-prompt": { type: "string" }, tools: { type: "string" }, "models-file": { type: "string" }, "context-window": { type: "string" },
} });
if (positionals.length !== 1 || !values.out) {
  throw new Error("Usage: npm run eval:session -- session.jsonl --out snapshots.json [--pi-package /path/to/pi-package] [--leaf id] [--models-file catalog.json | --context-window tokens] [--system-prompt prompt.txt --tools tools.json]");
}
if (resolve(positionals[0]!) === resolve(values.out)) throw new Error("Output must not be the source session");
const source = await readFile(positionals[0]!, "utf8");
const reader = await loadSessionReader(values["pi-package"]);
let catalog: unknown = {};
if (values["context-window"] === undefined) {
  const path = values["models-file"] ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "models-store.json");
  try { catalog = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (values["models-file"] || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
const exported = exportSession(source, reader, {
  leafId: values.leaf,
  contextWindow: values["context-window"] === undefined ? undefined : Number(values["context-window"]),
  modelWindows: modelWindowsFromStore(catalog),
  systemPrompt: values["system-prompt"] === undefined ? undefined : await readFile(values["system-prompt"], "utf8"),
  tools: values.tools === undefined ? undefined : JSON.parse(await readFile(values.tools, "utf8")),
});
// Private snapshots are never printed, and an existing destination is never replaced.
await writeFile(values.out, JSON.stringify(exported.snapshots), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ...exported.report, output: resolve(values.out) }, null, 2));
