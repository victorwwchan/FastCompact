# dsh-fast-compact

The idea is simple: **make compaction fast by not using a model at all.** A normal
compaction spends a whole LLM round-trip writing prose that the next turn then has to
re-read. This engine skips that step — compaction is computed locally and deterministically
from the append-only session log, so it costs no time and almost no input/output tokens.

The replacement text is compiled straight from the log into a fixed set of blocks, and every
dropped tool call/result becomes a one-line `seq` pointer the resumed model can restore with
`recall`. Nothing is rewritten into prose; nothing is asked of a model.

```
- [read the compiler to find the state block…] (thought seq 193) → seq 196, result seq 197, 15.7 KB
```

## Engine surface

`FastCompactEngine` (`lib/engine.mjs`, built by `createEngineClass(runtime)`)
extends `BasicCompactionEngine` from `@deepseek-ai/dsh-compaction-basic`. It
overrides exactly one documented hook — `summarize(input, agent, signal)` — so
selection, retention, the durable `compaction/start → compaction/summary →
compaction/end` bracket transaction, pressure policy, token-meter pricing,
shrink validation and overflow recovery all stay with the official base. If the
summarize input cannot be matched back to the log (`locateRegion` returns
null), it falls back to `super.summarize`.

The row's config schema is this plugin's own: `static Config = null`, so cordis
skips the base zod schema; `index.mjs` and `lib/config.mjs`
(`splitRowConfig` / `resolveFastCompactConfig`) validate the row instead, and
any unknown key fails at mount with an `unknown key "…"` error.

## The checkpoint body

The compiler (`lib/compiler.mjs`, `buildCheckpoint`) emits ONLY these blocks,
in this fixed order — no message text, no history prose, no tool-output
excerpts:

1. newest **runtime-context** block (superseded copies dropped),
2. newest **skill-catalog** block (deduped per kind; older identical copies
   collapse), each context block clipped to 6000 chars with a recall pointer,
3. **pinned content** — EVERY human message of the WHOLE session (this span's turns
    plus every turn an earlier compaction already replaced, re-read off the log):
   model recalled since the last compaction, kept verbatim under
   `## Pinned content (every user message kept, plus recalled entries verbatim)`;
   each human turn is clipped to `retainLength` chars and carries a recall pointer
   (`- [user seq N] "…" — restore with recall {"seq": N}`), so the request itself
   can never be lost,
4. `## State of work` — last human request (seq + quote), files written (last 8),
   commands run (last 5), unresolved errors with call/result seqs,
5. the newest **agent thought** quoted up to `thoughtChars` (0 = pointer only:
   `- last agent thought not quoted; resume from its own words with recall {"seq": N}`),
6. `## Session-log references (dropped tool traffic)`: one line per dropped call.
   The section is CUMULATIVE — when the span opens with a checkpoint an earlier
   compaction wrote, that body's own reference lines are parsed back and re-emitted
   ahead of this span's, so seqs from every compacted span stay `recall`able for as
   long as the session runs (see below),
7. `## Session-log instruction` — the built-in resume guidance.

The base supplies the framing (`<compacted-summary>`, "automatically generated
checkpoint") around the body; this package adds no frame tags of its own. Reference-line
shapes (`refLineFormat`):

| shape | line |
| --- | --- |
| `thought` (default) | `- [the thought that drove the call…] (thought seq 193) → seq 196, result seq 197, 15.7 KB` — a run of calls sharing one governing thought quotes it on the first line only; the rest carry `(thought seq N)`; `thoughtChars: 0` drops every excerpt |
| `none` | `- read lib/compiler.mjs → seq 196, result seq 197, 15.7 KB` (labelled by tool + key argument; no thought at all) |

The section's budget is the share the row grants the checkpoint — `contextMaxRatio` ×
the MESSAGE BUDGET that route leaves its window, in bytes (budget = window − reserved
output; `REFERENCES_BLOCK_BYTES` only when the route exposes no capacity). Over that
budget, its **oldest** lines fold into one range line:
`- 12 earlier calls: seq 40–88, restore with recall or recall_search` (every tool
name the checkpoint prints — headers, fold line, built-in instruction — follows
this row's `recallToolName`/`searchToolName`). With room to spare every indexed call
gets its own line, nothing folds, and the whole session's traffic is visible by seq.

The section is **cumulative across the whole session**, and its source is the log
itself: the host's own `compaction/summary` events carry the `shadowedRange` of every
earlier compaction, and the append-only session log still holds those calls, results
and thoughts, so `shadowedCallEntries` re-reads them by seq (`session.eventAt`). A call
seq is indexed once even when two ranges overlap, and calls this span names itself are
skipped — no message ever appears twice. It does not matter what replaced that traffic:
a checkpoint written by another engine (an LLM summary) limits nothing, because its body
is never parsed for seqs; the body's own reference lines (`carriedReferences`) are only a
fallback for traffic the brackets do not cover. The byte budget then ages traffic oldest-
first (a fold line counts the inherited calls too, e.g. `- 41 earlier calls: seq 12–880`),
so history coarsens while its seqs stay named.

## Configuration (cordis row keys)

Three disjoint sets; anything else in the row fails at mount.

**Plugin-level keys** (read and stripped by `index.mjs`; never reach the engine):

| key | default | meaning |
| --- | --- | --- |
| `harnessEntry` | auto | path of the running dsh CLI used to locate its install (default: `process.argv[1]`) |
| `allowUntestedHarness` | `false` | accept a dsh version outside the supported range after the contract check |
| `recallToolName` / `searchToolName` | `recall` / `recall_search` | rename the registered recall tools (`/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`) |
| `maxRecallChars` | `60000` | chars per `recall` page (integer ≥ 1; longer output paginates via `offset`) |
| `maxSearchHits` | `40` | events one `recall_search` reports (integer ≥ 1) |
| `headroomRatio` | `0.04` | share of each route's `contextWindow` used as the starting headroom B; replaces hand-set `headroomTokens` (B only feeds the base's own envelope formula — the plugin's gate never consults it, see below) |

**Content keys** owned by the engine (`lib/config.mjs`):

| key | default | meaning |
| --- | --- | --- |
| `thoughtChars` | `200` | one knob capping BOTH the last-thought quote and each reference line's thought excerpt (integer ≥ 0; 0 = pointers only) |
| `retainLength` | `200` | ONE shared cap, in characters, on human text kept across a compaction: it sizes each pinned user-message clip AND the `## State of work` quote of the last request (integer ≥ 1). Human turns are never dropped — a full pinned budget demotes a clip to a bare pointer (`- [user seq N] — restore with recall {"seq": N}`), and every turn keeps its line. Model reasoning is sized by `thoughtChars`, not by this |
| `refLineFormat` | `'thought'` | `thought` \| `none` (see table above) |
| `instructions` | built-in | `null`/absent = built-in text; non-empty string = used verbatim (may interpolate `${thoughtChars}`, `${recallTool}`, `${searchTool}`); `''` = block off |
| `debug` | `false` | ONE switch drives TWO blocks in the checkpoint: the **window-accounting** block (usage before / after / freed, as % of the window AND of the message budget, plus the gate that tripped) and the **failed-call trail** (tool name + clipped error text). It also records the accounting for `/fastcompact`. |
| `debugChars` | `200` | per-entry cap for that trail's error text ONLY, in chars (0 = names only; the stats block is not sized by it; `debug: false` = neither block) |
| `toolNames` | — | set by `index.mjs` from the resolved recall tool names so reference lines name the restoring tool |
| `contextMaxRatio` | `0.25` | how much of the MESSAGE BUDGET the route leaves its window — budget = window − reserved output, or the raw window when the route names no budget — the compiled checkpoint may occupy, as a ratio in (0, 1] — never an absolute byte or token length, so one row reads the same on a 64K and a 1M route. On `strata-llm/64K` (window 65,535, reserved output 32,000) a 0.25 row caps the checkpoint at ~8,383 tokens / 33,532 bytes, not 16,383. When the body would pass that share, only the reference section shrinks (its budget falls toward its 1 KiB floor) and its oldest calls fold into the range line; the pinned turns, state, thought and instruction blocks stay whole. A session that keeps compacting therefore never grows its own summaries |

**Host keys** forwarded to the base engine (validated there):
`thresholdRatio`, `retainRatio`, `retainTokens`, `maxTokens`, `compactionRetries`,
`maxOverflowRetries`, `modelPolicies`, `auto` — plus TWO host keys that are **derived,
never required**: `headroomTokens` (rejected if the row sets it), while `thresholdRatio` rides the host half **verbatim**,
and `maxTokens` (the summary's output cap) is **filled in per route** from the same share when the row leaves it out —
a row that still writes `maxTokens` keeps its own value at every level. A row that sets `headroomTokens` (top level or inside a `modelPolicies` entry) fails at mount
with a message saying so; the plugin derives it per route instead. The row's `thresholdRatio`
IS a share of the window — one number, read the same way everywhere: this plugin gates on
`ceil(W * thresholdRatio)` against the meter's surface reading, and forwards the ratio untouched
so the base sees the same share (see the section below for how the two readings differ). The
summary cap follows that same share: `min(that route's adapter default, W - gate)`.

### How the pressure gate gets sized

The gate lives in the base and follows ONE formula (see its own README; W = the
route's `contextWindow`, O = its effective request output cap, B = `headroomTokens`):

```text
fires when   measuredTokens >= floor(min(W * thresholdRatio, W - O - B))
retention    floor((W - O) * retainRatio)        // must stay below the gate
```

You no longer pick B, and you no longer write the summary's output cap. At mount, `index.mjs` asks the same `llm` service the base prices
against — `listProviders` → `listModels` → `resolveModelInfo` — and calls
`deriveRoutePressure(contextWindow, ratio, defaultMaxTokens, headroomRatio)` for **every route
the profile offers**. It returns `{ headroomTokens, thresholdRatio, gateTokens, requestedGateTokens, ceilingTokens, clampedToCeiling, beyondBudget, outputCapTokens }` for that route: B sized as a
share of THAT route's window (capped at a quarter of its message budget so the margin can never
steal the `1 - r` you left free), `thresholdRatio` forwarded **verbatim** — there is nothing
to translate any more, because the row's share means the same thing on both sides — and the summary
cap as `min(that route's adapter default, W - gate)`, so the compaction request can never ask for
more than what its own gate left free. Each readable
route gets its own `modelPolicies` entry carrying only `provider`, `model`, `headroomTokens`,
that ratio and that cap; capacity facts stay out of the base's policy schema, and the row-level default is
sized from the **tightest** window read, so an unlisted route can never carry a headroom bigger
than its own budget. The capacities come from the adapter metadata the base reads at request time,
so gate and pricing cannot drift apart.

The math, per route (`budget = W - O` is what messages may use; `r` = the row's ratio):

```text
share   = max(1024, round(W * headroomRatio))     budgetCap = floor(budget / 4)
B       = min(share, budgetCap)     ceiling = budget - B     gate = min(ceil(W * r), max(1, ceiling))  // guard
base    = floor(min(W * r, W - O - B))            // the base's own envelope threshold
```

So the plugin's guard is exactly the percentage you wrote — as a share of the WINDOW — read
against `tokenMeter.measure(session).surfaceTokens`, the meter's surface-only projection — with one
exception: a share the messages can physically never reach clamps to `ceiling`, so pressure fires
at the last reachable step before the request overflows; the clamp is reported (`clampedToCeiling`,
plus `beyondBudget` when that share sits past the message budget) and printed where it was seen.
Live web-profile numbers (`headroomRatio` 0.04, row ratios from the preset):

| route | W | O | budget | derived B | plugin gate | base threshold | gate as % of W |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `strata-llm/120KB` (ratio 0.7) | 122880 | 32000 | 90880 | 4915 | 85,965 | 85,965 | 69.9% (clamped from 86,016) |
| `strata-llm/100KB` (ratio 0.65) | 102400 | 32000 | 70400 | 4096 | 66,304 | 66,304 | 64.8% (clamped from 66,560) |
| `strata-llm/64KB` (ratio 0.8) | 65535 | 32000 | 33535 | 2621 | 30,914 | 30,914 | 47.2% (clamped from 52,428 = 80%) |
| `llama-cpp/84k` (ratio 0.6, no declared O) | 84000 | 0 | 84000 | 3360 | 50,400 | 50,400 | 60.0% |

What a share past the message budget means now: on `strata-llm/64KB` the reply reservation alone
takes 32,000 tokens, so messages can never hold 80% of that window (they top out at 51.2%).
That share no longer stops being a gate — it clamps to the last reachable step (the ceiling
`budget - B` = 30,914 tokens = 47.2% of W), so pressure still fires before the request overflows;
`clampedToCeiling` plus `beyondBudget` say which share had to move aside, and both the mount line
and the stats block print it. A share the messages CAN reach (up to ~51.1% on that route) fires
exactly where you wrote it.

One more gap sits under that arithmetic, and it is not arithmetic at all: the meter
prices the WHOLE request envelope — `totalTokens = toolSchemaTokens + surfaceTokens`
(`estimateToolsTokens(header)`, dsh-token-meter/lib/index.js:83 folded into the baseline
at line 753). Tool schemas are a per-request constant a conversation cannot grow, so on a
tight route they occupy real budget before one message token is counted. With this profile's
live header (7,661 tokens of schemas on `strata-llm/64KB`) a row saying `0.8` armed while the
messages still held only ~19,000 tokens = 29% of the window, and kept re-arming after nearly
every response, because the retained tail only had to climb back over a gate already a fifth
full of schemas. `FastCompactEngine.compactIfNeeded` therefore re-checks the derived gate
against `measurement.surfaceTokens` — the message surface alone — and defers automatic
pressure compaction until THAT share is reached; `context-overflow` recovery is never
deferred, and a route whose capacity this plugin never named keeps the base's own decision.

The gate is not mount-only: `learnRoute` reads an unnamed route's capacity straight from
the session — `requestContext()`, the same window the meter's own `contextPressure`
projection divides by — and falls back to `ctx.llm.resolveModelInfo` only when that session
has not ridden a request yet. A web profile resolves its providers after the plugins mounted,
so a mount-time-only table leaves `perRoute` empty and every session runs on the base's
envelope threshold instead — the "it compacts after every response again" symptom. Learned
gates govern the guard from then on, and the stats block prints real percentages instead of
giving up.

What the debug block prints is deliberately tiny: the checkpoint's `## Context window stats`
is ONE line — usage before and after as shares of the window, the gate (also as a share of
the window), and the tokens freed — because those tokens stay in the window forever. Nothing
else is printed there: the row's only context decisions are `thresholdRatio` (when to fire)
and `contextMaxRatio` (what may survive), both shares of W, so every number in that line
reads on the same basis you wrote. `/fastcompact` spells the same shares out for the live
session (window, gate, current messages) when you want the sentences rather than the log
line; a gate past what its messages can hold says so on both.

What the old hand-tuned B got wrong, and what this removes: the base default
`B = 65536` put the trigger at 25344 tokens = **0.21 of the window** on `strata-llm/120KB`,
so a tool-heavy session compacted before almost every step; on `strata-llm/100KB` the
same B drove the gate (4864) *below* the retention budget (11264), so compaction could
never reach the gate and churned until it failed with "compaction still above threshold";
on `strata-llm/64KB` `W - O - B` was negative, which throws once per route and leaves
pressure silently off. Those three are now structurally impossible: B is a share of the
route's own window. Still honest failures, unchanged:

- an adapter model with no `contextWindow` (e.g. `llama-cpp/150k` in this profile) is
  left out of the table — that route never gates pressure, and the base says
  `no context capacity for <provider>/<model>`;
- no `llm` service in the compaction realm, or a provider that cannot be listed/interrogated,
  falls back to `HEADROOM_FALLBACK_TOKENS = 4096` for every route (warned once at mount);
  a provider listing more than 64 models is skipped the same way;
- a route whose output cap eats its whole window keeps B at 1 and lets the base report it.

Tune per route with `modelPolicies` — `provider` and `model` must match the live
request header exactly (not the persona or display name). Name `thresholdRatio` and
retention there; leave `maxTokens` out — the summary's output cap is derived per route
as `min(that route's adapter default, W - gate)`, so it follows the share you named and
can never over-request what that gate left free. A value you do write (top level or in
one policy) wins over that aligned cap, at every level.

Byte caps in code (`lib/config.mjs`): `PINNED_MESSAGE_BYTES` 8000 per pinned
entry, `PINNED_BLOCK_BYTES` 24000 for the whole pinned block,
`REFERENCES_BLOCK_BYTES` 16000 as the reference section's budget ONLY when the
route exposes no capacity (normally that budget is `contextMaxRatio` × the MESSAGE
BUDGET the route leaves its window — window − reserved output; see the table row
above); over any budget → oldest lines fold.

## Install

The installable unit is the **preset bundle** `dsh-fast-compact-preset`: a copy
of the shipped "standard" preset whose `compaction` isolate group carries this
row (its `cordis.patch.yml` is already on the new keys — host-pressure keys plus
`thoughtChars`, `refLineFormat`, `instructions`). Install the bundle, select
preset `preset-fast-compact`, start a new session. This package's own `cordis.patch.yml` is a comment header plus an
empty row list (`[]`) — installing it alone can never change the host boot.

The row REPLACES any other compaction engine in that isolate group (one
`ctx.compaction` per context). It re-registers its own recall tools and the
`/recall` + `/fastcompact` commands, so a preset swapping to this row keeps the
recall surface working.

## Recall surface

- Tools `recall` (`{"seq":N}` / `{"result":N}` / `{"range":"A-B"}`, max 200 seqs;
  `grep`/`context`/`head`/`tail`/`offset` selectors, byte-exact originals) and
  `recall_search` (whole log, newest first; `kind` ∈ user|assistant|tool|result|error|checkpoint|context,
  `since`/`until`, `regex=true`). Renameable via the plugin keys above.
- Commands `/recall <seq> | <from>-<to> | result <seq>` and
  `/fastcompact [format [<thought|none> [chars <n>] | chars <n> | reset]]`
  — bare `/fastcompact` reports the last compaction this engine wrote, plus a live
  "Context window" line (route, W/O/budget, headroom, the gate in tokens and as % of
  both, current surface usage) and — when `debug` is on — the before → after / freed
  accounting of that compaction;
  `format` changes one session's shape from its NEXT compaction on (runtime-only,
  via `engine.setShape` / `currentShape`; bounded at 64 sessions).
- Pinned content: every seq the model recalls is remembered (`lib/pins.mjs`,
  max 200/session) and kept verbatim by the next compaction, then released.

## Version gate (`lib/runtime.mjs`)

Harness classes are resolved from the RUNNING dsh install (never a second npm
copy). Tested versions: `TESTED_DSH_VERSIONS = ['0.2.1-rc.2']`; accepted without
override: `SUPPORTED_DSH_RANGE` = ≥ `0.1.5-rc.2`, < `0.3.0` (prerelease-aware;
0.3.0 and its prereleases are refused). Outside the range needs
`allowUntestedHarness: true`. Before any session work, an API contract check
proves every export this plugin uses exists with the right shape — and that `BasicCompactionEngine` still carries the five methods our subclass relies on (`summarize`, `compactIfNeeded`, `compactRegion`, `compactNow`, `regionDependencies`) — on the injected
harness classes, or the load is refused.

## Removed in the housekeeping trim pass

The housekeeping trim pass, image offload, the stats-file writer, legacy trim
aliases and the whole byte-budget selection layer are gone, as is the duplicate
version gate that used to sit in `lib/harness.mjs` (its check now lives in
`lib/runtime.mjs`): `lib/select.mjs` and
`lib/refs.mjs` no longer exist — range selection belongs to the base. These row
keys are unknown now and **fail at mount**: `maxRequestBytes`,
`targetRequestBytes`, `contextRatio`, `retainTurns`, `retainBytes`,
`keepRecentImages`, `dryRun`, `toolRefs`, `refKeyArg`, `refThoughtChars`,
`lastThinkingMode`, `sessionLogInstruction`, `statsLog`. (`debug` was re-claimed: it
is now ONE switch of ours — the failed-call trail AND the window-accounting block —
with `debugChars` sizing only the trail's error text; hypercompact's old meaning of it
no longer exists.)

## Package contents

| File | What it is |
| --- | --- |
| [index.mjs](<index.mjs>) | Plugin entry: mount/apply + plugin-level row keys. |
| [lib/engine.mjs](<lib/engine.mjs>) | `FastCompactEngine` — the single `summarize` override. |
| [lib/runtime.mjs](<lib/runtime.mjs>) | Version gate against the running DSH install. |
| [lib/config.mjs](<lib/config.mjs>) | Row-config split/validation (`splitRowConfig`, `resolveFastCompactConfig`). |
| [lib/compiler.mjs](<lib/compiler.mjs>) | `buildCheckpoint` — the deterministic block compiler. |
| [lib/references.mjs](<lib/references.mjs>) | Cumulative session-log reference lines + parsing them back. |
| [lib/measure.mjs](<lib/measure.mjs>) | Token measurement for gate/sizing decisions. |
| [lib/messages.mjs](<lib/messages.mjs>) | Message/span walking over the session log. |
| [lib/pins.mjs](<lib/pins.mjs>) | Pinned-content selection (every user message kept). |
| [lib/recall.mjs](<lib/recall.mjs>) | Recall-surface helpers used by the compiled instruction block. |
| [lib/tools.mjs](<lib/tools.mjs>) | Tool-call/result plumbing for reference lines. |
| [scripts/selfcheck.mjs](<scripts/selfcheck.mjs>) | 19 static + mount checks (`npm run selfcheck`). |
| [scripts/find-dsh.mjs](<scripts/find-dsh.mjs>) | DSH entry resolution (DSH_ENTRY → `where dsh` → npm global). |
| [test/](<test/>) | 8 test files (100 tests) + fixtures; reports land in `test/out/`. |
| [docs/reports/](<docs/reports/>) | The two field-test stress reports and their comparison (see above). |
| [cordis.patch.yml](<cordis.patch.yml>) | Empty mount patch (comment header + `[]`). |
| [LICENSE](<LICENSE>) | MIT, owned by vicschan. |

## Tests

```sh
npm test        # node --test "test/*.test.mjs" — 100 tests (88 pure: config, measure, references, compiler, tools, pressure-gate-repro; 12 harness: engine, ref-formats-e2e)
npm run selfcheck   # scripts/selfcheck.mjs — 19 static + mount checks
```

The `ref-formats-e2e` test compacts the latest real durable session log in both
formats × `thoughtChars` {0, 200} and writes `test/out/ref-formats-e2e-report.md`
(plus `test/out/checkpoints/*.txt`). Engine/mount tests need the harness: set
`DSH_ENTRY` to the dsh CLI entry (e.g. `...\@deepseek-ai\dsh\lib\bin.js`) where a
sandboxed PATH cannot find it; `scripts/find-dsh.mjs` resolves DSH_ENTRY → `where dsh`
→ npm global root. On Windows, `node --test` may hit the sandbox's named-pipe
limit — run the test files directly with `node` if so.

## Field-test reports

Two live-session stress runs of this preset (64K window, gate ≈ 30,914 tokens,
`retainRatio` 0.12) plus a fear-vs-truth comparison of them, in `docs/reports/`:

- [compactBasic.md](<docs/reports/compactBasic.md>) — reference run: 300-entry detail
  corpus, ~10 auto-compactions over 41 min of heavy traffic; memory 2/8 native,
  **8/8 restored** from the append-only log.
- [FastCompact.md](<docs/reports/FastCompact.md>) — follow-up run: **23 compactions**,
  16/300 sampled D-IDs (chosen to exclude the reference run's 8) restored
  **byte-exact via `recall`/`recall_search` only — 16/16 = 100% effective memory**
  with zero file re-reads; final compact freed 14,656 tokens.
- [compareRepor.md](<docs/reports/compareRepor.md>) — summary comparison of the two
  runs: memory-context feature table and an 8-point fear-vs-truth review
  (loss, confabulation, summary lag, search precision, …).

## License

MIT, owned by vicschan — see `LICENSE` in this package. It carries no upstream
attribution note: this engine descends from no third-party project. The only
external code it touches is the official DSH host surface
(`@deepseek-ai/dsh-compaction`, `@deepseek-ai/dsh-compaction-basic`,
`@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`), whose public API it subclasses
by resolving classes from the running install at mount — nothing of theirs is
copied or bundled, and no vendored compaction library exists in this package.

Node: `^22.19.0 || >=24.0.0`; dsh engines range `>=0.1.5-rc.2 <0.3.0`
(`package.json`, matching `SUPPORTED_DSH_RANGE`).
