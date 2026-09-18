import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { configLayerFromSettings, mergeConfig } from "../src/config.js";
import { loadPiConfig } from "../src/pi/config.js";

test("settings namespace ignores unrelated Pi settings and validates only jevCompact", () => {
  assert.deepEqual(configLayerFromSettings({ theme: "dark", compaction: { enabled: true } }), {});
  assert.deepEqual(configLayerFromSettings({ theme: "dark", jevCompact: { enabled: false, pressureThreshold: 0.7 } }), {
    enabled: false, pressureThreshold: 0.7,
  });
  assert.throws(() => configLayerFromSettings({ jevCompact: { typo: true } }), /Unknown config key/);
  assert.equal(mergeConfig({ enabled: true }, { enabled: false }).enabled, false);
});

test("Pi config precedence is defaults < global < trusted project < explicit file", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  const projectSettingsDir = join(projectDir, CONFIG_DIR_NAME);
  const explicit = join(root, "explicit.json");
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(projectSettingsDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", jevCompact: { enabled: true, keepThreshold: 0.1, maxRequests: 2 } }));
    await writeFile(join(projectSettingsDir, "settings.json"), JSON.stringify({ jevCompact: { enabled: false, maxRequests: 3 } }));
    await writeFile(explicit, JSON.stringify({ enabled: true, maxRequests: 1 }));

    const untrusted = await loadPiConfig({ cwd: projectDir, projectTrusted: false, agentDir });
    assert.equal(untrusted.config.enabled, true);
    assert.equal(untrusted.config.maxRequests, 2);
    assert.equal(untrusted.usedProject, false);

    const trusted = await loadPiConfig({ cwd: projectDir, projectTrusted: true, agentDir });
    assert.equal(trusted.config.enabled, false, "project false overrides global true");
    assert.equal(trusted.config.maxRequests, 3);

    const explicitResult = await loadPiConfig({ cwd: projectDir, projectTrusted: true, explicitPath: explicit, agentDir });
    assert.equal(explicitResult.config.enabled, true);
    assert.equal(explicitResult.config.maxRequests, 1);
    assert.equal(explicitResult.config.keepThreshold, 0.1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted project settings are not read, while malformed active layers fail safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-config-malformed-"));
  const agentDir = join(root, "agent");
  const projectDir = join(root, "project");
  try {
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    await writeFile(join(projectDir, CONFIG_DIR_NAME, "settings.json"), "{ private malformed content");
    const ignored = await loadPiConfig({ cwd: projectDir, projectTrusted: false, agentDir });
    assert.equal(ignored.config.enabled, false);
    await assert.rejects(loadPiConfig({ cwd: projectDir, projectTrusted: true, agentDir }), /Invalid configuration/);
    await writeFile(join(projectDir, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ jevCompact: { enabled: "yes" } }));
    await assert.rejects(loadPiConfig({ cwd: projectDir, projectTrusted: true, agentDir }), /Invalid configuration|enabled must be boolean/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
