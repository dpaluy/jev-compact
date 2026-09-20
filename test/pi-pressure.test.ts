import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore, type Context } from "@earendil-works/pi-ai";
import { JEV_ENDPOINT } from "../src/jev.js";
import { assistant, call, result, user } from "./helpers.js";

test("saved global activation and real Pi usage preserve pruning across new user turns", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-pi-pressure-"));
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.TYPESAFE_API_KEY = "offline-fixture";
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let scoringRequests = 0;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, JEV_ENDPOINT);
    scoringRequests++;
    const body = JSON.parse(String(init?.body));
    return Response.json({ model: "offline", usage: { input_tokens: 1, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.01 }])) });
  };
  try {
    await mkdir(join(root, "agent"));
    await writeFile(join(root, "agent", "settings.json"), JSON.stringify({ jevCompact: { enabled: true, preserveRecentMessages: 0 } }));
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("src/pi/extension.ts")], systemPrompt: "Keep requirements." });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    const provider = fauxProvider({ tokensPerSecond: Infinity });
    runtime.registerNativeProvider(provider.provider);
    const seen: Context[] = [];
    provider.setResponses(Array.from({ length: 2 }, () => (context: Context) => {
      seen.push(structuredClone(context));
      const response = fauxAssistantMessage("Continue.");
      response.usage.input = 100;
      response.usage.output = 1;
      response.usage.totalTokens = 101;
      return response;
    }));
    const manager = SessionManager.create(root, join(root, "sessions"));
    for (const message of [user("Keep constraints."), assistant([call("old")]), result("old", "old noise ".repeat(1600))]) manager.appendMessage(message);
    ({ session } = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime: runtime,
      model: { ...provider.getModel(), contextWindow: 5000 }, resourceLoader: loader, sessionManager: manager,
      settingsManager: settings, noTools: "all", thinkingLevel: "off" }));
    await session.bindExtensions({ mode: "print" });
    await session.prompt("First task.");
    assert.equal(scoringRequests, 1);
    assert.ok(session.getContextUsage()!.tokens! < 3000, "Pi reports the previously pruned request below pressure threshold");
    await session.prompt("Next task: reconsider the earlier trace.");
    assert.equal(scoringRequests, 2, "fresh original snapshot still exceeds threshold");
    for (const context of seen) assert.ok(!JSON.stringify(context).includes("old noise"));
    assert.ok(JSON.stringify(manager.getBranch()).includes("old noise"), "the original session is untouched");
  } finally {
    session?.dispose();
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});
