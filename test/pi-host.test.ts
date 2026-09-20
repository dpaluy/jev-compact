import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { JEV_ENDPOINT } from "../src/jev.js";
import { conversation } from "./helpers.js";

// Actual resource loading plus registered startup flags: saved enable can be
// overridden in either direction without touching real user settings.
test("Pi resource loader applies saved activation and explicit CLI enable/disable overrides", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-pi-flags-"));
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.TYPESAFE_API_KEY = "offline-fixture";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: "offline", usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.01 }])) });
  };
  const sessions: Array<Awaited<ReturnType<typeof createAgentSession>>["session"]> = [];
  try {
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "settings.json"), "{}");
    const run = async (savedEnabled: boolean, flag: "jev-prune" | "no-jev-prune") => {
      await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ jevCompact: {
        enabled: savedEnabled, preserveRecentMessages: 0, pressureThreshold: 0.1,
      } }));
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [resolve("src/pi/extension.ts")], systemPrompt: "fixture",
      });
      await loader.reload();
      loader.getExtensions().runtime.flagValues.set(flag, true);
      const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
        modelsStorePath: join(root, `models-${flag}.json`), allowModelNetwork: false, refreshOnCreate: false });
      const provider = fauxProvider({ tokensPerSecond: Infinity });
      runtime.registerNativeProvider(provider.provider);
      provider.setResponses([fauxAssistantMessage("ok")]);
      const manager = SessionManager.inMemory(root);
      const startupConversation = conversation();
      const oldResult = startupConversation.find(message => message.role === "toolResult");
      if (oldResult?.role === "toolResult") oldResult.content = [{ type: "text", text: "x".repeat(5000) }];
      for (const message of startupConversation) manager.appendMessage(message);
      const created = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime: runtime,
        model: { ...provider.getModel(), contextWindow: 1000 }, resourceLoader: loader, sessionManager: manager,
        settingsManager: settings, noTools: "all", thinkingLevel: "off" });
      sessions.push(created.session);
      await created.session.bindExtensions({ mode: "print" });
      await created.session.prompt("startup flag probe");
    };
    await run(false, "jev-prune");
    assert.equal(requests, 1, "explicit enable overrides saved false");
    await run(true, "no-jev-prune");
    assert.equal(requests, 1, "explicit disable overrides saved true");
  } finally {
    for (const session of sessions) session.dispose();
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

// Real Pi resource loading, extension lifecycle, context hook, provider dispatch and
// persisted session. Only the two remote model transports are replaced offline.
test("Pi loads the package and filters provider context without editing its stored session", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-pi-host-"));
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.TYPESAFE_API_KEY = "fixture-key-not-a-credential";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let remoteFailure = false;
  let scoringRequests = 0;
  let pauseScoring = false;
  let signalStarted!: () => void;
  let releaseScoring!: () => void;
  const scoringStarted = new Promise<void>(resolve => { signalStarted = resolve; });
  const scoringReleased = new Promise<void>(resolve => { releaseScoring = resolve; });
  globalThis.fetch = async (url, init) => {
    assert.equal(url, JEV_ENDPOINT, "No other network endpoint may be used");
    scoringRequests++;
    if (pauseScoring) { signalStarted(); await scoringReleased; }
    if (remoteFailure) return new Response("unavailable", { status: 503 });
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: "offline-jev-transport", usage: { input_tokens: 80, output_tokens: 4 },
      answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.01 }])) });
  };
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({ preserveRecentMessages: 0, minContextBytes: 0, pressureThreshold: 0.1 }));
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("src/pi/extension.ts")], systemPrompt: "Offline fixture test.",
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0]!.flags.keys()].sort(), ["jev-prune", "jev-prune-config", "no-jev-prune"]);
    loaded.runtime.flagValues.set("jev-prune-config", configPath);
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false,
    });
    const provider = fauxProvider({ tokensPerSecond: Infinity });
    runtime.registerNativeProvider(provider.provider);
    const seen: Context[] = [];
    provider.setResponses(Array.from({ length: 6 }, () => (context: Context) => {
      seen.push(structuredClone(context));
      return fauxAssistantMessage("Offline response.");
    }));
    const manager = SessionManager.create(root, join(root, "sessions"));
    const original = conversation();
    for (const message of original) manager.appendMessage(message);
    ({ session } = await createAgentSession({
      cwd: root, agentDir: join(root, "agent"), modelRuntime: runtime, model: { ...provider.getModel(), contextWindow: 1000 },
      resourceLoader: loader, sessionManager: manager, settingsManager: settings, noTools: "all", thinkingLevel: "off",
    }));
    const errors: unknown[] = [];
    await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
    await session.prompt("disabled baseline");
    assert.equal(scoringRequests, 0);
    assert.ok(JSON.stringify(seen[0]).includes("old progress output"));
    await session.prompt("/jev-prune on");
    await session.prompt("enabled projection");
    assert.equal(scoringRequests, 1);
    assert.ok(!JSON.stringify(seen[1]).includes("old progress output"));
    assert.ok(JSON.stringify(seen[1]).includes("Never edit .env."));
    assert.ok(JSON.stringify(seen[1]).includes("Inspecting the implementation."));
    assert.deepEqual(manager.getBranch().filter(e => e.type === "message").slice(0, original.length).map(e => e.message), original);
    const sessionPath = manager.getSessionFile()!;
    assert.ok((await readFile(sessionPath, "utf8")).includes("old progress output"));
    const auditDir = `${sessionPath}.jev-prune`;
    const logs = await readdir(auditDir);
    assert.equal(logs.length, 1);
    const log = (await readFile(join(auditDir, logs[0]!), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(log.filter(row => row.type === "decision" && row.action === "drop").length, 1);
    remoteFailure = true;
    await session.prompt("scorer failure");
    assert.ok(JSON.stringify(seen[2]).includes("old progress output"));
    remoteFailure = false;
    // A non-directory at the audit path simulates a write failure after scoring.
    await rm(auditDir, { recursive: true });
    await writeFile(auditDir, "blocked");
    await session.prompt("audit failure");
    assert.ok(JSON.stringify(seen[3]).includes("old progress output"));
    await session.prompt("/jev-prune off");
    const previousRequests = scoringRequests;
    await session.prompt("disabled again");
    assert.equal(scoringRequests, previousRequests);
    assert.ok(JSON.stringify(seen[4]).includes("old progress output"));
    // Disabling during a pending scoring call must prevent that projection too.
    await rm(auditDir);
    await session.prompt("/jev-prune on");
    pauseScoring = true;
    const pending = session.prompt("disable during scoring");
    try {
      await scoringStarted;
      await session.prompt("/jev-prune off");
    } finally {
      releaseScoring();
      await pending;
    }
    assert.ok(JSON.stringify(seen[5]).includes("old progress output"));
    // Native manual compaction remains available while Jev is enabled.
    pauseScoring = false;
    await session.prompt("/jev-prune on");
    provider.setResponses([
      fauxAssistantMessage("Offline compacted summary."),
      fauxAssistantMessage("Offline turn prefix summary."),
    ]);
    const compacted = await session.compact();
    assert.match(compacted.summary, /Offline compacted summary/);
    assert.ok(manager.getEntries().some(e => e.type === "compaction"));
    provider.setResponses([(context: Context) => {
      seen.push(structuredClone(context));
      return fauxAssistantMessage("After compaction.");
    }]);
    await session.prompt("Continue after compaction.");
    assert.ok(JSON.stringify(seen.at(-1)).includes("Offline compacted summary"));
    assert.ok(!JSON.stringify(seen.at(-1)).includes("old progress output"));
    assert.deepEqual(errors, []);
  } finally {
    session?.dispose();
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
