import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  configLayerFromSettings,
  mergeConfig,
  parseConfig,
  parseConfigLayer,
  type Config,
  type ConfigLayer,
} from "../config.js";

export { DEFAULT_CONFIG, parseConfig, type Config } from "../config.js";

async function readJson(path: string, optional: boolean): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid configuration at ${path}`);
  }
}

export async function loadConfig(path?: string): Promise<Config> {
  if (!path) return parseConfig({});
  return parseConfig(await readJson(path, false));
}

export interface PiConfigSources {
  config: Config;
  usedProject: boolean;
  explicitFile: boolean;
}

/** Pi owns path/trust discovery; parsing and precedence stay host-neutral. */
export async function loadPiConfig(options: {
  cwd: string;
  projectTrusted: boolean;
  explicitPath?: string;
  agentDir?: string;
}): Promise<PiConfigSources> {
  const layers: ConfigLayer[] = [];
  const globalRaw = await readJson(join(options.agentDir ?? getAgentDir(), "settings.json"), true);
  if (globalRaw !== undefined) layers.push(configLayerFromSettings(globalRaw));

  let usedProject = false;
  if (options.projectTrusted) {
    const projectRaw = await readJson(join(options.cwd, CONFIG_DIR_NAME, "settings.json"), true);
    if (projectRaw !== undefined) {
      layers.push(configLayerFromSettings(projectRaw));
      usedProject = true;
    }
  }

  if (options.explicitPath) {
    layers.push(parseConfigLayer(await readJson(options.explicitPath, false)));
  }
  return { config: mergeConfig(...layers), usedProject, explicitFile: options.explicitPath !== undefined };
}
