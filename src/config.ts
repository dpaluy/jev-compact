import { DEFAULT_POLICY, validatePolicy, type Policy } from "./core.js";
import { DEFAULT_MODEL, isObject } from "./jev.js";

/** Host-neutral configuration shared by every adapter. */
export interface Config extends Policy {
  enabled: boolean;
  model: string;
  preserveRecentMessages: number;
  /** Compatibility name: a secondary serialized-work floor, never the primary trigger. */
  minContextBytes: number;
  pressureThreshold: number;
  maxRequestBytes: number;
  maxRequests: number;
  timeoutMs: number;
}

export const DEFAULT_CONFIG: Config = {
  ...DEFAULT_POLICY,
  enabled: false,
  model: DEFAULT_MODEL,
  preserveRecentMessages: 6,
  minContextBytes: 0,
  pressureThreshold: 0.6,
  maxRequestBytes: 24_000,
  maxRequests: 4,
  timeoutMs: 10_000,
};

export type ConfigLayer = Partial<Config>;

export function parseConfigLayer(raw: unknown): ConfigLayer {
  if (!isObject(raw)) throw new Error("Expected a JSON configuration object");
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new Error(`Unknown config key: ${key}`);
  }
  const layer = { ...raw } as ConfigLayer;
  if (layer.enabled !== undefined && typeof layer.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (layer.keepThreshold !== undefined || layer.pinPaths !== undefined) {
    validatePolicy({
      keepThreshold: layer.keepThreshold ?? DEFAULT_CONFIG.keepThreshold,
      pinPaths: layer.pinPaths ?? DEFAULT_CONFIG.pinPaths,
    });
  }
  if (layer.model !== undefined && (typeof layer.model !== "string" || !layer.model.trim())) {
    throw new Error("model must be a non-empty string");
  }
  const bounds = {
    preserveRecentMessages: [0, 1000],
    minContextBytes: [0, 10_000_000],
    pressureThreshold: [0.1, 0.95],
    maxRequestBytes: [1000, 24_000],
    maxRequests: [1, 16],
    timeoutMs: [1, 60_000],
  } as const;
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const value = layer[key];
    if (value === undefined) continue;
    const [min, max] = bounds[key];
    if (!Number.isFinite(value) || value < min || value > max || (key !== "pressureThreshold" && !Number.isInteger(value))) {
      throw new Error(`Invalid ${key}`);
    }
  }
  return layer;
}

export function mergeConfig(...layers: readonly ConfigLayer[]): Config {
  const merged = Object.assign({}, DEFAULT_CONFIG, ...layers) as Config;
  validatePolicy(merged);
  // Revalidate the complete result as well as each source layer.
  parseConfigLayer(merged);
  return merged;
}

export function parseConfig(raw: unknown): Config {
  return mergeConfig(parseConfigLayer(raw));
}

/** Read only our namespace from a host settings object. */
export function configLayerFromSettings(raw: unknown): ConfigLayer {
  if (!isObject(raw)) throw new Error("Expected a settings JSON object");
  const namespace = raw.jevCompact;
  return namespace === undefined ? {} : parseConfigLayer(namespace);
}
