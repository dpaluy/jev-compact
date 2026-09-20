# Evaluation

All default commands are offline. They do not use credentials, send transcripts,
run tools, or change Pi settings. They test retention and execution limits, not
Jev accuracy or total session savings.

```sh
npm run eval
npm run eval:compare
npm run eval:replay
npm run check
```

## Coverage reporting

`unscored` uses the planner's skipped count. It includes oversized context,
oversized candidates, exhausted request budgets, and scoring failures. A partial
assessment must not appear to be a complete assessment.

## Matched-budget comparison

`eval:compare` compares the shipping Jev threshold policy with newest-first
whole-pair retention. Both receive the same original messages, protected paths,
recent-message protection (two messages, as in the existing retention exam), and
unassessed-pair protection. Neither receives retrieval or a new summary. Labels
are used only for scoring retention, never as Jev request context.

The recency arm gets the Jev arm's retained-message token ceiling, measured with
Pi's character-based estimator. Fixed system-prompt overhead is common to both
arms and excluded from this ceiling. Complete pairs cannot always fill it
exactly. Each result reports the actual sizes and `recencyBudgetSlackTokens`.
Only fully assessed, exactly matched fixtures contribute to the aggregate
retention delta. A skipped candidate or lost required fact fails the command.

Comparison fixtures pad tool results to equal estimated pair sizes. This prevents
recency from selecting the required fact just because it is the only small result.
Padding does not enter the required-evidence labels. The default scorer uses
fixture labels, so an offline advantage verifies the comparison mechanics only.

To measure live Jev retention and scoring latency on these synthetic fixtures:

```sh
TYPESAFE_API_KEY=... npm run eval:compare -- --live
```

This explicit opt-in contacts TypeSafe and incurs cost. It sends only the
synthetic fixtures, not saved user sessions. Resolved model IDs and scoring token
usage are reported. The comparison does not generate continuation responses.
Total session cost, provider latency, and cache-read tokens are therefore `null`,
not zero. No total-cost or task-quality conclusion follows from this test.

## Long-session replay

`eval:replay` exercises the real extension context hook, scheduler, request
fitting, and pair reconstruction. Its local transport votes to drop every
assessed pair. This measures assessment capacity and an optimistic reduction
bound, not safe deletion or model judgment. Production limits are unchanged.

The built-in workloads cover tool-heavy sessions, growing conversation text, and
oversized tool results. They include explicit host-summary boundaries. They are
synthetic workloads, not captured user sessions.

Each row reports eligible, assessed, newly assessed, skipped, and dropped counts;
skip reasons; request counts; actual before/after serialized sizes; and estimated
outgoing tokens. Identical projections are reused without counting another remote
request. A changed snapshot can restore unfiltered history when the real scheduler
defers work. Cumulative sizes count what each simulated outgoing request contains,
not just the size immediately after pruning.

`prefixRewritten` and `sharedPrefixEstimatedTokens` compare successive message
prefixes. They do not measure provider cache hits, TTLs, billing, or serialization.
The audit sink is in memory, so this is not an audit-storage performance test.

### Existing sessions in ~/.pi

Copy a complete session first, especially if it is still active. The exporter
reads v3 JSONL and writes private snapshots without changing the source. It never
opens a running agent, executes recorded tools, loads extensions, or calls a model.

```sh
umask 077
work=$(mktemp -d)
cp /path/to/session.jsonl "$work/session.jsonl"
npm run eval:session -- "$work/session.jsonl" --out "$work/snapshots.json" \
  --pi-package /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent
npm run eval:replay -- "$work/snapshots.json"
```

`--pi-package` is the directory of the installed Pi package compatible with the
session. Omit it to use this checkout's SDK. Structured system-message records
require the newer 0.86+ helpers; the pinned 0.85 SDK cannot reconstruct them and
is rejected for those sessions. No dependency upgrade is needed for export.

The exporter selects the final entry's branch, or `--leaf ENTRY_ID`. For each
assistant record, it reconstructs the context at that record's parent, before
including the response. Native SDK helpers apply compaction boundaries and
system-prompt/tool patches. System messages remain in the transcript: removing
them would understate what the real context hook sends to the scorer.

Model windows come from `~/.pi/agent/models-store.json` (respecting
`PI_CODING_AGENT_DIR`), or an explicit `--models-file PATH`. Unknown models stop
export. `--context-window TOKENS` supplies a documented override for every request.
The report distinguishes current catalog sizes from explicit overrides; neither
proves the historical host's exact capacity.

Older sessions often lack prompt and tool state. Export stops rather than
substituting an empty prompt. Supply historical `--system-prompt prompt.txt` and
`--tools tools.json` files if available. These are fallbacks only where recorded
state is absent, and their use is reported. Do not substitute current settings
and then describe the replay as an exact historical measurement.

Output files are created exclusively with mode `0600`; existing files are not
overwritten. Keep the output directory private. The JSON report on stdout has
counts, source SHA-256, SDK version, model/window provenance, and warnings, not
transcript text. Malformed JSON, missing parents, and invalid compaction boundaries
stop export rather than silently losing context.

Session export reconstructs persisted history, not provider payloads. Unrecorded
extension context rewrites cannot be recovered. For exact runtime captures, use
the input format below. To run exporter tests with the installed SDK, including
structured system and checkpoint tests:

```sh
PI_EVAL_SDK_PACKAGE=/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent npm run check
```

### Captured input

```sh
npm run eval:replay -- /private/path/snapshots.json
```

Supply an array of context-hook snapshots from one session, in request order:

```json
[
  {
    "id": "request-1",
    "cwd": "/work/project",
    "systemPrompt": "The exact system prompt for this request.",
    "contextWindow": 200000,
    "tools": [],
    "messages": [
      { "role": "user", "content": "Continue the fix.", "timestamp": 1 }
    ]
  }
]
```

Use native Pi message objects as received by the context hook. Include the exact
system prompt and tool declarations separately. Use `eval:session` to convert
session JSONL first: do not flatten branches, omit compaction summaries, or
substitute partial messages. Captured snapshots already carry the host's compaction and recovery
boundaries. Replay does not invent alternative summaries or future agent actions,
and it never feeds a pruned copy into the next recorded snapshot.

Keep private snapshots outside the repository. Output contains counts and supplied
snapshot IDs, not message text. Supplied snapshots cannot enable live transport.
An optional `model: { "provider": "...", "id": "..." }` records model switches.
The replay runs this checkout's pruning code and estimator; source SDK version is
reported separately by the exporter.
