# Jev Compact

A context-pruning extension for Pi. Jev Compact uses Jev to score tool traces and keep or drop them without summarizing retained content or rewriting user text.

## Behavior

The extension pairs Pi tool calls and results, applies pin rules and scoring thresholds, and writes an audit record before returning filtered outgoing context. It preserves native message structure and does not edit the session transcript.

- A trace is one complete tool call plus its complete result. There is no result truncation or summary generation.
- User messages and non-tool content are protected. Retained content stays verbatim and in order.
- Two Noul questions assess task relevance and constraint/exact-evidence retention. These are two dimensions in one model request, not independent safety checks. A pair is dropped only if **both** scores are below `keepThreshold`. The default is `0.2`; it is conservative policy, not a calibrated safety guarantee.
- The scorer receives complete candidate text, including the end of each result, plus the context supplied by the adapter. Other tool outputs are not necessarily in the same scoring batch.
- Automatic scoring begins at 60% model-context pressure with eligible traces. The extension estimates the actual outgoing snapshot; unknown pressure waits. Changed tool-loop snapshots normally wait for the next user/task cycle, but at 90% pressure they can trigger another pass. Deferred changed snapshots use the original context, never stale drops.
- Identical snapshots reuse their audited projection without remote scoring or another log file. If a request budget left work pending, an identical snapshot can continue scoring that work.
- Request size, request count and time are bounded. Oversized or unassessed traces stay. Context and outputs are not silently shortened to meet the budget. Reusable judgments require matching context, policy, model, question version, ordered candidate content and source positions. The cache holds at most eight identities with 1,024 judgments each; evicted judgments can require reassessment.
- Candidate selection advances separately from judgment reuse. Later traces get fresh assessments on subsequent permitted passes even when the task changes or old cache entries are evicted.
- Scoring failures retain all candidates. An error in any scoring batch discards all proposed drops and new cache entries for that pass. The extension also retains original context when reconstruction or audit logging fails.
- Outcomes distinguish disabled/not-ready, pressure or cadence waiting, no eligible work, protected-context or candidate oversize, request budget, no useful drops, errors, cancellation, and successful pruning.

Pruning may not free enough space. Previously summarized content cannot be recovered. Later extensions or provider serializers can also change context after Jev Compact runs.

## Credentials and privacy

Set `TYPESAFE_API_KEY` in your shell or secret manager. Do not put it in config files or command arguments. This key is for Jev scoring only. Pi continues to manage your model-provider login; the extension requires no separate model-provider key or proxy.

Enabling live scoring permits sending context and candidate tool inputs/outputs to `https://api.typesafe.ai/v1/systemone`. This includes the system prompt and user and assistant text. Do not enable it on sensitive sessions without approval. Pins prevent deletion, not disclosure of information repeated elsewhere in the conversation.

Offline tests do not require a key and make no external model calls.

## Compatibility

Tested against Pi **0.85.1** and Node **26.8.1**. Requires Node **22.20+**.

## Install

Install the Pi package directly from GitHub:

```sh
pi install git:github.com/dpaluy/jev-compact
```

This adds the package to `~/.pi/agent/settings.json`, clones it under Pi's package directory, installs its runtime dependencies, and loads the extension declared in `package.json`. You do not need to clone this repository or pass `-e`.

For one project only, run this from that project:

```sh
pi install git:github.com/dpaluy/jev-compact -l
```

Project installation writes `.pi/settings.json`. Pi asks you to trust project-local resources before it loads them.

Set the TypeSafe API key in the environment that starts Pi:

```sh
export TYPESAFE_API_KEY="..."
```

Pruning is **off by default**. Start Pi, then enable it:

```text
/jev-prune on
/jev-prune status
/jev-prune off
```

`on` enables the data transfer described in [Credentials and privacy](#credentials-and-privacy). Saved settings are reapplied on reload, new sessions, resumes, and forks. Session commands do not edit settings. Explicit startup overrides are:

```sh
pi --jev-prune       # enable for this process/session lifecycle
pi --no-jev-prune    # disable, even when saved settings enable it
```

Pi's extension flag API does not synthesize `--no-*`, so `--no-jev-prune` is a separately registered boolean flag. If both are present, disable wins.

Update or remove the package with Pi's package manager:

```sh
pi update git:github.com/dpaluy/jev-compact
pi remove git:github.com/dpaluy/jev-compact
```

For local development, clone this repository and install the package directory instead:

```sh
git clone https://github.com/dpaluy/jev-compact.git
pi install ./jev-compact
```

## Context and compaction

Pi's `context` event supplies a copy of the outgoing conversation. The adapter pairs native tool calls and results by ID, asks the scoring engine for decisions, writes a durable audit record, and returns a filtered copy. It never edits the session transcript, user text, or retained content.

All user messages, assistant text/thinking, and other non-tool messages stay. Recent pairs, configured paths, incomplete/ambiguous pairs, images, signed/opaque call groups, and tool activation records stay. Image-dependent user context disables scoring for that pass.

The scorer receives the system prompt and non-tool history with source positions. A later task is assessed from its own context and can restore an old trace because the original transcript is intact. There are no persisted drop masks to leak across branches or resumes. Automatic scoring is pressure-gated and normally runs at most once per user/task cycle, with an exception for changed snapshots at 90% pressure.

Pi pressure is estimated from the full outgoing messages, system prompt, and active tool definitions. Previous provider usage can raise this estimate but cannot hide traces restored from the original session. These are character-based estimates, not exact token counts. After an audit failure, the original context stays; a new task retries, or `/jev-prune on` permits an immediate retry.

Jev Compact does not restrict Pi's compaction. Run `/compact` whenever you want, including while pruning is enabled. Pi's automatic compaction follows your normal Pi settings. Compaction uses Pi's summarizer, not Jev's tool-trace pruning.

`/jev-prune status` reports why pruning is waiting or unable to reduce context, with assessed/dropped/unassessed counts. If protected scorer context itself exceeds the configured conservative 24,000-byte application envelope, batching cannot help because that same context must accompany every full candidate. Nothing is dropped and no remote call is made. If pruning is insufficient, run `/compact` or start a new session. You do not need to disable Jev first.

## Configuration

Jev Compact reads only the `jevCompact` namespace from Pi settings; unrelated Pi settings are ignored. It is off by default. Global example in `~/.pi/agent/settings.json`:

```json
{
  "jevCompact": {
    "enabled": true,
    "pressureThreshold": 0.6
  }
}
```

To enable it for one trusted project, add this to `<project>/.pi/settings.json` (use Pi's configured `CONFIG_DIR_NAME` in rebranded builds):

```json
{
  "jevCompact": {
    "enabled": true,
    "pinPaths": ["**/AGENTS.md", "**/.env", "**/.env.*", "lib/generated/**"]
  }
}
```

Project settings are read only when Pi reports the project trusted. A project `enabled: false` overrides global `true`. Precedence is **defaults < global < trusted project < `--jev-prune-config` file < explicit `--jev-prune`/`--no-jev-prune` activation**. Optional missing files are benign; malformed active files or namespace values fail closed with an actionable status and do not block normal `/compact`. File contents and keys are not printed.

Existing standalone config files remain supported:

```json
{
  "enabled": true,
  "keepThreshold": 0.2,
  "pinPaths": ["**/AGENTS.md", "**/.env", "**/.env.*"],
  "preserveRecentMessages": 6,
  "pressureThreshold": 0.6,
  "minContextBytes": 0,
  "model": "jev-1.13.0",
  "maxRequestBytes": 24000,
  "maxRequests": 4,
  "timeoutMs": 10000
}
```

Pass one with `--jev-prune-config /path/to/config.json`. `minContextBytes` is retained for compatibility as an optional secondary eligible-work floor; pressure remains the primary trigger. `pinPaths` replaces the default list. Patterns use Node's `path.matchesGlob` syntax against normalized paths from `path`, `file_path`, `filePath`, `paths`, or `files` tool arguments, including project-relative forms of absolute paths. Arbitrary shell commands and paths mentioned only in output are **not** parsed for pins.

`preserveRecentMessages` protects a pair if either side lies within the newest N messages. `keepThreshold` must be between 0 and 0.5, so uncertain scores cannot trigger a drop. `pressureThreshold` defaults to `0.6` and accepts `0.1..0.95`. `maxRequestBytes` includes full protected state and questions and cannot exceed 24,000 bytes. This is Jev Compact's deliberately conservative **byte-based application cap**, not a TypeSafe API limit and not a token estimate. The current Jev 1.13 documentation specifies 64,000 input tokens across state plus all questions and 32,000 across state plus the longest question; inputs are text-only. Jev Compact keeps its lower cap initially rather than translating those token limits speculatively. `timeoutMs` is a deadline for the whole scoring pass, not per batch. There are no automatic HTTP retries.

## Log location

Each completed assessment pass writes one JSONL file under:

```text
<session-file>.jev-prune/<run-id>.jsonl
```

Ephemeral sessions use `<Pi agent directory>/jev-prune/<hashed-session-id>/`. See [Decision logs](#decision-logs) for the record format and limitations.

## Comparison with fast-jev-compaction

This table compares the inspected [`fast-jev-compaction` source at `e3f262a`](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a) with this repository. They target different hosts and make different loss/fallback choices.

| Dimension | Jev Compact | [`fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) |
| --- | --- | --- |
| Implemented host | Pi outgoing `context` extension | Claude Code plugin hooks (`session.compact`, `turn.complete`) |
| Automatic trigger | 60% model-context pressure, eligible work, task-cycle cadence, explicit unknown-usage wait | `turn.complete` requests compaction at configurable 60% usage |
| Transformation | Drops complete call/result pairs only; retained native content is verbatim | Can drop a call or replace a result with a bounded head plus truncation note |
| Scorer evidence | Full protected system/non-tool context and each complete candidate; blocks if they cannot fit | Fits state by truncating inputs, abridging/collapsing/leaving out history; tool results are represented by result notes |
| Budget coverage | Bounded exact-input cache avoids duplicate scoring; separate selection progress reaches later traces across changing tasks | Batches all candidates and asks batches concurrently during one compaction |
| Failure / low reduction | Jev keeps original context; normal host compaction remains available | Falls back to the host's built-in summary on errors or below `minReductionRatio` |
| Pins | Recent pairs, paths, users/non-tool content, incomplete/opaque/native safety cases | First/recent messages; incomplete calls are not candidates |
| Observability | Private durable hash/decision JSONL written before applying | UI decision lines and summary statistics |
| Tradeoff | Preserves complete traces but may free less space; host compaction remains separate | Result truncation and summary fallback can free more space, but intentionally accept lossy transformations |

Neither project's offline fixture mechanics establish live judgment accuracy, continuation-task success, latency, or net cost.

## Decision logs

Audit records use JSONL. See [Log location](#log-location) for storage paths.

Files are created with mode `0600`, new directories with `0700`. The file and containing directory are synced before filtered context is returned. A write or sync failure prevents pruning.

Each decision records the session/run/item IDs, SHA-256 content hash, scores or null, threshold, keep/drop action, rule, model reported by the API, policy/question versions, and timestamp. Protected items have a reason rather than fabricated scores. Run records include input/output hashes, structured outcomes, serialized byte counts, and scorer token usage. Scoring failures report unknown usage as null, not zero.

Logs contain no raw tool output, user text, or API key. Configuration pins and model names are recorded. Treat logs as private metadata.

The last `ready` record marks a complete **context proposal**, not proof the provider accepted it. Ignore incomplete files. Cancellation or a later extension may still prevent or change the request after this record is written. The audit directory is append-only in normal operation, with one file per assessment pass and no automatic deletion or rotation. An identical completed snapshot can reuse that audited proposal; the log is not a count of provider requests.

Hashes cannot reconstruct deleted text. To replay decisions, supply the exact original context and match its hash, then apply the logged dropped item IDs. System prompts and earlier context-transform extensions must also match. There is no replay CLI in v1.

## Validation

```sh
npm run typecheck
npm test
npm run eval

# Read-only workload using actual Pi read-tool outputs from an existing checkout:
npm run eval:project -- /path/to/rubric_llm
```

The tests cover pairing, pins, untouched text, malformed responses, fresh pressure estimation after pruning, task cadence and emergency pressure, exact projection reuse, peer-candidate cache invalidation, fair coverage across changing tasks and cache eviction, impossible protected context, layered trusted settings, startup flags, cancellation, audit recovery, and context restoration. Tests use temporary directories and no external model calls.

The Pi integration test loads the actual extension with Pi's resource loader, dispatches through Pi to an offline provider, checks the provider's received messages, and verifies that the session still contains dropped traces.

The ten retention fixtures are hand-authored from RubricLLM rules, API names, and validation errors. Each contains a user constraint, a tool-only constraint, and removable progress traces. Nine tool-only constraints are unpinned; the project-guidance fixture tests a path pin. The evaluator checks both the surviving source item and exact text, not just a matching string elsewhere.

`npm run eval` uses fixture-label scores. It verifies the mechanics of retention and compression, **not Jev's judgment quality**. A negative control proves the evaluator detects a bad drop of an unpinned tool constraint. An offline transport check also verifies bounded repeated passes cover six one-batch candidates and a completed exact repeat makes zero requests. The project workload uses real file contents with a scripted conversation and fixture-label scores; it is not a recorded agent session.

To test the real scoring model on these synthetic fixtures, explicitly run:

```sh
npm run eval -- --live
```

This sends only the synthetic fixtures to TypeSafe using your configured account and can incur charges. It exits nonzero for lost constraints, failed/unscored candidates, or fixtures with no compression. This is a small initial suite, not evidence of general safety or superiority to summarization. Do not claim model retention until this live evaluation has run and its results have been reviewed.

Compression metrics are **serialized UTF-8 bytes**, not billed tokens. Scorer token usage comes from TypeSafe responses. Agent token savings, net cost savings, cache effects, continuation-task correctness, and live-model retention are not measured by the offline suite.

## Structure

| Path | Responsibility |
| --- | --- |
| `src/core.ts` | Keep/drop policy, outcomes, and result validation |
| `src/config.ts` | Defaults, validation, namespaced-layer merge |
| `src/scheduler.ts` | Pressure, cadence, readiness, and outcome policy |
| `src/jev.ts` | Full-output scoring, fair bounded cache/requests, strict TypeSafe response validation |
| `src/audit.ts` | Durable JSONL decision records |
| `src/pi/adapter.ts` | Native Pi pairing and lossless reconstruction |
| `src/pi/config.ts` | Pi settings paths and project trust checks |
| `src/pi/usage.ts` | Fresh outgoing-context pressure estimates |
| `src/pi/extension.ts` | Pi lifecycle, commands, audit-before-apply |
| `eval/` | Retention fixtures and evaluation commands |

## References

- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction): inspiration for tool-trace selection. This implementation does not copy its code or its result truncation and summary fallback behavior.
- [Pi extensions](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md): outgoing `context` filtering.
- [Pi packages](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md).
- [TypeSafe HTTP API](https://docs.typesafe.ai/api), [Noul](https://docs.typesafe.ai/primitives/noul), and [model versions and limits](https://docs.typesafe.ai/models).
