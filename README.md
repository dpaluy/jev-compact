# Jev Compact for Pi

## What it does

Jev Compact reduces the context sent to your Pi model. It uses [TypeSafe Jev](https://typesafe.ai/) to identify tool calls and results that are no longer needed, then removes those pairs from outgoing requests.

User messages, assistant text, and retained tool results stay unchanged. The saved session transcript stays intact. Pi's normal `/compact` and automatic compaction remain available.

## Install

Requires Pi and Node.js 22.20 or later.

Install the [Pi extension](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/packages.md):

```sh
pi install npm:@dpaluy/pi-jev-compact
```

Add `-l` to install for the current project only. Git install remains available as `pi install git:github.com/dpaluy/pi-jev-compact`.

Get an API key from [TypeSafe](https://typesafe.ai/) through its [console](https://console.typesafe.ai/). Set it in the shell that starts Pi:

```sh
export TYPESAFE_API_KEY="your-key"
pi
```

Pruning is off by default. In Pi, run:

```text
/jev-prune on
/jev-prune status
```

Use `/jev-prune off` to stop pruning. These commands do not save settings. If Pi was already running when you installed the extension, run `/reload` to load it.

When enabled, the extension sends the system prompt, conversation text, and candidate tool inputs and outputs to TypeSafe for scoring. Keep the API key out of settings files and source control. Pi continues to use your existing model-provider login.

## Configuration

Add `jevCompact` to `~/.pi/agent/settings.json` to save your settings:

```json
{
  "jevCompact": {
    "enabled": true,
    "pressureThreshold": 0.6,
    "keepThreshold": 0.2,
    "preserveRecentMessages": 6,
    "pinPaths": ["**/AGENTS.md", "**/.env", "**/.env.*"]
  }
}
```

| Setting | Default | Purpose |
| --- | --- | --- |
| `enabled` | `false` | Enable pruning when Pi loads the extension. |
| `pressureThreshold` | `0.6` | Start scoring at 60% estimated context use. Accepts `0.1` to `0.95`. |
| `keepThreshold` | `0.2` | Drop a pair only when both scores are below this value. Lower values keep more. Accepts `0` to `0.5`. |
| `preserveRecentMessages` | `6` | Keep pairs with either side in the newest six messages. |
| `pinPaths` | As shown above | Keep pairs whose tool path arguments match these patterns. A custom list replaces the defaults. |

Pins prevent removal, not disclosure to TypeSafe. Paths mentioned only in shell commands or tool output do not count as path arguments.

For project settings, use the same structure in `.pi/settings.json`. Pi reads these only for trusted projects, and they override global settings. Run `/reload` after changes.

Start Pi with `--jev-prune` or `--no-jev-prune` to override saved activation settings. If both are set, disable wins. Advanced options are defined in [src/config.ts](src/config.ts). Use `--jev-prune-config /path/to/config.json` for an override file with settings at the top level, without the `jevCompact` wrapper.

## How it works

1. **Wait for context pressure.** Scoring starts at the configured threshold, normally once per user/task cycle. At 90% context use, changed context can trigger another pass.
2. **Protect content.** User and assistant text, recent tool pairs, pinned paths, and pairs that cannot be safely separated stay.
3. **Score complete tool pairs.** Jev receives each candidate's full input and output, plus system and conversation text. It scores task relevance and the need to retain constraints or exact evidence. Both scores must be below `keepThreshold` to remove a pair.
4. **Log and filter.** The extension records its decisions, then sends Pi a filtered copy of the context. It never shortens retained results or writes a summary. Later tasks can use the original traces while they remain in Pi's transcript.

Requests have size, count, and time limits. Oversized or unassessed pairs stay. Scoring or log failures keep the original context. `/jev-prune status` shows the current outcome and counts.

If pruning does not free enough space, run `/compact`. Jev decisions can be wrong; unchanged retained text does not guarantee that every removed result was unnecessary.

## Compared with the original Claude Code version

This extension was inspired by [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). The comparison below uses its [source at `e3f262a`](https://github.com/tamaratran/fast-jev-compaction/tree/e3f262a).

| Behavior | Jev Compact for Pi | Original Claude Code plugin |
| --- | --- | --- |
| Integration | Filters outgoing context; saved transcript stays intact. | Replaces the host's compaction result through hooks. |
| Tool results | Keeps or removes complete call/result pairs. | Can also shorten a result while keeping its call. |
| Evidence sent to Jev | Complete candidate inputs and outputs; skips candidates that cannot fit. | Uses short result notes and can shorten scoring history to fit. |
| Failure or insufficient reduction | Keeps original context on failure; Pi compaction remains separate. | Falls back to the host's built-in summary. |

The Pi version keeps retained tool results complete, but may free less space. Accuracy, speed, and cost differences have not been established by a live comparison.

## Evaluation

Run `npm run check` for tests and offline evaluations. `npm run eval:compare`
compares required-evidence retention with recency at a common estimated-token
ceiling. `npm run eval:replay` measures request coverage and outgoing context
across long synthetic workloads or supplied context snapshots. `npm run eval:session`
exports existing Pi session JSONL into private replay snapshots without changing
the source.

Offline scores do not measure Jev accuracy. Live scoring is opt-in and uses only
synthetic fixtures. See [eval/README.md](eval/README.md) for commands, input format,
and measurement limits.
