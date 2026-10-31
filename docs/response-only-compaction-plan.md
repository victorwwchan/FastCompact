# `dsh-fast-compact` — Implementation Plan

A new DSH preset plugin that extends the **hypercompact** pattern: deterministic,
zero-LLM byte-budget compaction whose checkpoint carries **human text + each
turn's final agent response**, with all thinking blocks and all tool-call/result
content **replaced by reference numbers (seq) into the session log**. The full
originals stay in the durable session log and are restorable via `recall` /
`recall_search` (inherited from dsh-hypercompact).

Deliverables of this plan: (1) research findings that shape the design, (2) the
plugin architecture, (3) package layout and module specs, (4) the preset bundle
(extension of `preset-hypercompact`), (5) install/verification and test steps.

---

## 1. What "compacted data" contains today — and what it will contain

In the hypercompact preset, compaction replaces a contiguous surface span with one
checkpoint node (a user message whose source is `{ kind: 'compact-checkpoint' }`).
The checkpoint text is produced by a **deterministic local compiler**
(`lib/compiler.mjs` → `compileCheckpoint`, no LLM call). Content today vs. target:

| Entry kind | Carried today | Target (`dsh-fast-compact`) |
|---|---|---|
| `user` | verbatim (head+tail only for one pathological >cap paste) | **unchanged** — human text is protected from all budget passes |
| `assistant` final text | clipped to `assistantTextChars` (floor 1000); per-step intermediate text as excerpts | **unchanged** |
| reasoning / thinking | never carried (already excluded upstream) | unchanged — still fully dropped, **no reference line** |
| tool calls + results | per-call marker lines with rendered args + result head/tail excerpts (budget pass 1) | **replaced by one reference line per call/result pair: seq numbers into the session log** — no args, no result content |
| carried checkpoint / pins / state block | protected | unchanged (prior checkpoints keep their original compiled text) |

Reference line format (one per tool call/result pair, grouped per turn in a
dedicated `references` section appended to the history section):

```
[session-log references — restore originals with recall {"seq": N} or recall_search]
  turn 12 · write src/f.ts → log seq 23 (result seq 24, 4.1 KB)
  turn 12 · bash "git status" → log seq 25 (result seq 26, 2.0 KB)
```

- The **seq** is the durable session-log sequence number — exactly what
  `recall {"seq": …}` / `recall {"result": …}` already accept, so recoverability
  is zero new machinery.
- Tool name + (optionally) a single short key arg are kept *as labels only* so
  the checkpoint still shows what actions happened; the **content** (full args,
  result text/excerpts) is replaced by the seq reference. If even that is too
  much, `refKeyArg: false` drops the label down to name + seqs only.
- Thinking blocks get **no** reference line: they are dropped by design (that was
  the original ask), and hypercompact never carried them to begin with.

**Scope decisions (locked):**

- **Checkpoint content**: user text, assistant final text, carried checkpoints,
  pins/state — all as in hypercompact; tool entry content → seq references;
  thinking → dropped.
- **Retained tail stays verbatim.** The retained recent turns (`retainTurns` /
  `retainBytes`) keep thinking + tools intact, because the harness only accepts
  **content-only `tool/result` rewrites** in place (the same mechanism
  dsh-hypercompact's housekeeping uses) — there is no supported rewrite path for
  assistant messages, so thinking in the live tail cannot be stripped without
  corrupting replay/tool-pairing. "Compacted data" = what compaction produces;
  the retained tail is working memory by design.
- **Optionality (phase 2)**: `shrinkRetainedToolResults` — reuse housekeeping's
  in-place rewrite to replace *old* retained tool results with a one-line
  log-seq pointer. Thinking still stays; only result bytes shrink. Off by default.
- **Recoverability**: shadowed seqs remain in the durable log (same as
  hypercompact); `recall`/`recall_search` are re-registered by the plugin (see §4).

---

## 2. Research findings that shape the design

### 2.1 Presets have no inheritance

From `@deepseek-ai/dsh-agent-preset` docs
(`skills/editing-cordis-compositions/SKILL.md`, `README.md`): a preset is a row
(`id: preset-<id>`, `name: '@deepseek-ai/dsh-agent-preset'`,
`config.{id,plugins,name?,description?,order?}`). **Nothing extends or edits a
declaration in place.** A bundle's patch either inserts a new full preset row or
overrides an existing row id with a *complete* config. Declarations provide no
directory/file operations; duplicate ids fail the bundle. ⇒ The extended preset
is shipped as a **full copy** of `preset-hypercompact` with exactly one row
changed (the compaction group's engine row), mirroring how
`preset-hypercompact` itself is a full copy of `standard`.

### 2.2 `BasicCompactionEngine` config resolution (reference pattern)

`@deepseek-ai/dsh-compaction-basic/lib/index.js`, three stages:

1. **`resolveConfig(config = {})`** — `validateKeys` against
   `BASIC_COMPACT_CONFIG_KEYS` (unknown keys and duplicate `modelPolicies`
   entries throw at mount), fills defaults, returns a **`deepFreeze`d** object.
2. **`resolveTargetPolicy(config, target)`** — exact `{provider, model}` lookup
   in `modelPolicies`; an override merges over globals field-by-field
   (`override?.x ?? config.x`); retention inherits explicitly or from the ratio.
3. **`resolveCompactSpec(policy, contextWindow, reservedCompletionTokens)`** —
   scales the policy to the routed target's adapter token budgets (explicit
   `contextWindow` required; no model discovery).

dsh-hypercompact's `lib/config.mjs` is the same shape (frozen `DEFAULTS`,
`checkKeys` against `TOP_LEVEL_KEYS`, `resolvePolicy(config, target)` with exact
provider/model merge over `POLICY_KEYS`). **The new plugin reuses hypercompact's
`resolveConfig` verbatim** and adds its own keys on top (see §5.4).

### 2.3 dsh-hypercompact architecture (the extension surface)

Source: `vendor/dsh-hypercompact/package/` (dsh-hypercompact@0.2.4, MIT).

- **Entry (`index.mjs`)**: `apply(ctx, config)` splits plugin keys
  (`harnessEntry`, `allowUntestedHarness`, `recallToolName`, `searchToolName`)
  from engine keys; validates engine config up front; `loadRuntime()` walks up
  from the running dsh CLI entry to locate the harness root, **version-gates**
  (`TESTED_DSH_VERSIONS` / `SUPPORTED_DSH_RANGE`, plus a contract check that every
  used export exists), and imports `@deepseek-ai/dsh-compaction`,
  `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools` **from the running install**
  (never a second copy). Then `createEngineClass(runtime)` builds the engine class,
  `ctx.plugin(Engine, …)` provides `ctx.compaction`, and `ctx.inject` adds the
  recall tools + `/recall`/`/hypercompact` commands. Its own bundle patch is `[]`
  (host-inert); it is meaningful only inside a preset.
- **Base contract (`@deepseek-ai/dsh-compaction` → `CompactionEngine`)**: abstract
  `compactIfNeeded`, `compactNow`, `compactRegion`; one implementation per context;
  durable transaction `compaction/start → compaction/summary → user/message(replace)
  → compaction/end`; boundary checks via `toolPairingBalancedBefore/After`.
- **Engine (`lib/engine.mjs`)**: same transaction protocol as basic. The single
  compile call site is inside **`runCompaction`** (method, line ≈400):
  `compileCheckpoint(nodes, { ...this.config, toolNames, pinnedSeqs }, budget)`.
  Everything else — selection (`selectRange`, retention, intra-turn fallback),
  housekeeping (in-place old-result trims between target and trigger), image
  offload, pins, stats, dry-run — lives in the same class.
- **Compiler (`lib/compiler.mjs`)**: exports `compileEntries`, `pinnedBlock`,
  `stateBlock`, `compileCheckpoint`, text helpers, checkpoint constants. The
  budget loop (3 degradation passes + binary-search elision) is private to
  `compileCheckpoint`; entry *filtering/replacing* is not exposed as a knob —
  and the compiler has no "reference" entry kind, so seq-reference lines are
  spliced into the compiled history section by the engine override (§4.3),
  inside the same byte budget.
- **Housekeeping (`lib/housekeeping.mjs`)**: the only supported in-place rewrite —
  content-only `tool/result` replacement, older-than-retention, with a marker and
  the original seq for recall. This is the mechanism a phase-2 retained-tail
  shrink would reuse.
- **`ctx.compaction` is single-instance per context** ⇒ the new plugin must
  **replace** the `dsh-hypercompact` row in the preset's `compaction` isolate
  group (exactly as hypercompact replaced `dsh-compaction-basic`), not sit beside
  it. dsh-hypercompact stays installed as a *library dependency* of the new
  plugin.

### 2.4 Why the obvious seams don't work

- **Sanitize nodes before `compileCheckpoint` + splice refs**: feasible and chosen
  (see §4) — the compiler consumes node copies; the transaction itself validates
  boundaries against the real session (`toolPairingBalancedBefore/After`) and
  re-checks surface identity (`liveNodes` vs captured view) at commit, so
  sanitized *copies* never desynchronize the harness.
- **Filtering the `view()`/`index()` instead**: rejected — `requestBytes`,
  retention selection, housekeeping and the commit-time surface-identity check
  all require the view to match the real surface exactly; a filtered view would
  throw `SurfaceChangedError` on every compaction.
- **Subclassing via a compiler config/hook**: no hook exists; `compileCheckpoint`
  is an import binding inside `runCompaction` (ESM — not reassignable).

---

## 3. Architecture decision

| Option | Shape | Verdict |
|---|---|---|
| **A. Subclass + single-method override** (recommended) | New plugin depends on `dsh-hypercompact`; subclasses its engine class; overrides only `runCompaction` — a copy of the base method in which the compile step becomes: sanitize nodes (drop thinking/tool content, collect refs) → `compileCheckpoint(sanitized, …)` → splice the per-turn reference section into the history output before budget framing. All selection/housekeeping/recall/stats inherited. | **Chosen.** ~300 lines of owned code; one upstream-coupling surface; inherits future hypercompact improvements (selection, image offload, recall). |
| B. Full fork of dsh-hypercompact | Vendor all `lib/` files into the new package, modify the entry pipeline in the compiler. | Rejected for v1: ~25 KB of upstream code to re-track; same drift risk with more owned surface. Kept as fallback if A proves brittle. |
| C. Upstream config knob (`toolEntries: 'refs'` in hypercompact) + thin wrapper | PR the entry replacement into dsh-hypercompact; our plugin becomes config passthrough. | **Phase 2 follow-up**: once upstream lands it, the `runCompaction` copy collapses to a config line and the plugin shrinks to identity + preset. File this PR after M3 (MIT project, small diff: emit seq-reference lines instead of args/results in `renderEntries` when configured). |

Provider identity: `compaction/summary` records
`provider: 'dsh-fast-compact'`, `model: 'fast-compact-compiler-v1'` so logs,
stats and the token meter attribute compactions to this engine (mirrors
hypercompact's `ENGINE_PROVIDER` / `ENGINE_MODEL` constants).

---

## 4. Package layout — `dsh-fast-compact`

New standalone package (its own directory, e.g. `C:\Users\vic\.dsh\fast-compact-plugin\`
— the `fast-compact` workspace currently hosts the unrelated
`dsh-plugin-context-trim` project and keeps only this plan in `docs/`):

```
dsh-fast-compact/
├─ package.json            # name dsh-fast-compact, version 0.1.0, type: module,
│                          # main index.mjs; dependencies: { "dsh-hypercompact": "0.2.4" }
│                          # "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
├─ cordis.patch.yml        # []  (host-inert, exactly like dsh-hypercompact's)
├─ LICENSE                 # MIT + attribution: built on dsh-hypercompact (MIT, mrbeandev)
├─ index.mjs               # entry: apply(ctx, config) — see §4.1
├─ lib/
│  ├─ refs.mjs             # pure node sanitizer + reference collector — see §4.2
│  └─ engine-fc.mjs        # FastCompactEngine subclass — see §4.3
├─ test/
│  ├─ helpers.mjs          # fixtures in dsh-hypercompact test/helpers.mjs style
│  ├─ refs.test.mjs        # pure-module unit tests (no host needed)
│  └─ engine.test.mjs      # parity + refs integration tests (fake session)
└─ scripts/
   └─ selfcheck.mjs        # mount-check against a running headless dsh (see §6.4)
```

### 4.1 `index.mjs` — entry

`apply(ctx, config)` (mirrors dsh-hypercompact's, with its additions):

1. Split config into plugin keys (`harnessEntry`, `allowUntestedHarness`,
   `recallToolName`, `searchToolName`, plus the new `toolRefs`, `refKeyArg`,
   `shrinkRetainedToolResults`) and engine keys.
2. Validate engine keys through **dsh-hypercompact's** `resolveConfig` (frozen),
   then merge/validate this plugin's keys (unknown key ⇒ throw at mount with a
   clear message; result deep-frozen).
3. Version gate: require the resolved `dsh-hypercompact` version to be within
   `{ min: '0.2.4', below: '0.3.0' }`, and let hypercompact's own `loadRuntime`
   enforce the harness gate + contract checks (it throws on missing/renamed
   exports). Contract-check additionally that
   `createEngineClass`, `compileCheckpoint`, `resolveConfig`,
   `defineRecallTools`, `registerCommands` exist in the loaded package.
4. Build `FastCompactEngine = createFastCompactEngine(hyperRuntime)` and
   `ctx.plugin(FastCompactEngine, { ...engine, toolNames })` — this provides
   `ctx.compaction` (replacing hypercompact's row in the preset).
5. Because this plugin **replaces** hypercompact's row, it must re-register what
   that row registered: recall/recall_search tools via
   `ctx.inject(['tools'], …)` and `/recall` (+ alias) commands via
   `ctx.inject(['commands','compaction'], …)` — same helpers hypercompact's
   entry uses, driven by the resolved `tools` / `commands` config flags.

### 4.2 `lib/refs.mjs` — pure sanitizer + reference collector (no host dependency)

```
refifyNodes(nodes) → {
  nodes: Node[],                    // sanitized copies for compileCheckpoint
  refs: [ { turn, name, seqCall, seqResult, resultBytes, keyArg? } ]
}
renderRefSection(refs, config) → string   // the "[session-log references]" block
```

For each surface node copy, in the dual message formats handled by
hypercompact's `toolResultsOf` (`role:'tool'` since dsh 0.1.7, user-wrapped
`tool-result` block before):

- **assistant nodes** → keep only `{type:'text'}` blocks; drop
  `{type:'reasoning'}` and `{type:'tool-call'}` blocks. Each dropped
  `tool-call` block contributes a ref record
  (`{ name, seqCall: node.seq, keyArg? }`). If no text block remains (pure
  tool-call step) → drop the node; its refs stay in the list.
- **tool/result nodes** → dropped as surface entries; each contributes
  `{ seqResult: node.seq, resultBytes }` and is paired with its preceding call
  (by `toolCallId`). Unpaired results (orphaned by selection boundaries) still
  get their own ref line — recall must never lose a seq.
- **user, system, checkpoint, end-seed nodes** → pass through unchanged (a
  carried checkpoint from a *previous* engine keeps its original text).

`renderRefSection` emits the grouped block shown in §1: turn header + one line
per pair with log seqs and original result size; `keyArg` label only when
`refKeyArg: true` (default true, clipped to ~48 chars like hypercompact's
`keyArgChars`). The section is plain text — no per-call content.

Returns plain copies: the transaction's pairing checks and surface-identity check
run against the real session and are untouched. Pure function ⇒ unit-testable
with static fixtures (copy the pattern of `vendor/…/test/helpers.mjs`
`buildEvents`/`fakeSession`).

### 4.3 `lib/engine-fc.mjs` — the subclass

```
class FastCompactEngine extends BaseHyperEngine {
  async runCompaction(agent, job) { /* copy of base runCompaction (≈190 lines) */ }
}
```

The copy is **verbatim from dsh-hypercompact 0.2.4** except:

1. When `config.toolRefs === true` (default), the compile step becomes:
   ```
   const { nodes: clean, refs } = refifyNodes(nodes);
   let compiled = compileCheckpoint(clean, { ...this.config, toolNames: this.toolNames, pinnedSeqs }, budget);
   if (refs.length) compiled = withRefSection(compiled, renderRefSection(refs, this.config));
   ```
   `withRefSection` splices the reference block into the history section of the
   compiled checkpoint (inside the same byte-budget framing — refs count toward
   `maxCheckpointBytes` and degrade last, after elision of oldest entries, since
   they are the recall affordance). With `toolRefs: false` the base expression
   runs unchanged (parity mode).
2. New identity constants: `ENGINE_PROVIDER = 'dsh-fast-compact'`,
   `ENGINE_MODEL = 'fast-compact-compiler-v1'` used in the
   `compaction/summary` fields.
3. Stats/log extension: merge `refs` counts into the info log line and the
   recorded stats (`stats.toolRefs`, `stats.resultNodesReplaced`).
4. Phase-2 hook (off, no-op in v1): after compaction commit, if
   `shrinkRetainedToolResults` is on, run one housekeeping-style pass rewriting
   older-than-retention results to a log-seq pointer line (reuses
   hypercompact's `planResultTrim`/content-only rewrite with a fast-compact
   marker string).

Discipline: the copied method is the **only** upstream-coupling surface. The test
suite includes a **parity test**: on a fixture with no tool traffic, the
subclassed engine must produce a byte-identical checkpoint to the base engine —
any upstream change that alters `runCompaction`'s behavior shows up there.

---

## 5. Preset bundle — `dsh-fast-compact-preset` (extension of hypercompact)

Per §2.1, a **full copy** of the `preset-hypercompact` row (itself a full copy of
`standard`), with exactly one change inside the `compaction` isolate group:

```yaml
- insert:
    id: preset-fast-compact
    name: '@deepseek-ai/dsh-agent-preset'
    config:
      id: fast-compact
      name: Fast Compact (response-only, log-ref checkpoints)
      plugins: <verbatim copy of preset-hypercompact's full plugin list, except the compaction group row>
```

The compaction group row becomes:

```yaml
  - name: dsh-fast-compact
    config:
      toolRefs: true
      refKeyArg: true
      # + same engine config as today's hypercompact row (maxRequestBytes, …)
      modelPolicies:
        - { provider: strata-llm, model: 64KB, /* per-route overrides */ }
```

Bundle layout: the usual 2 files (`package.json` with
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` + the patch), package
name `dsh-fast-compact-preset`. Header comment on the patch file, same convention
as the reference: *"A copy of preset-hypercompact (which is a copy of standard);
only the compaction group row was changed. Regenerate as a full copy after
upgrading dsh or dsh-hypercompact."*

The profile keeps **both** plugin bundles installed (`dsh-hypercompact` and
`dsh-fast-compact`) — hypercompact is now a library dependency; presets choose
which engine row their compaction group carries:

- `preset-standard` / existing rows → unchanged, still basic/hypercompact.
- `preset-fast-compact` → the new response-only preset (this deployment's
  default candidate for the web profile).

No profile-level `cordis.patch.yml` changes are needed beyond switching
`agent-preset-registry`'s default to `fast-compact` (optional, separate step).

---

## 6. Install, verification, testing

### 6.1 Build order

1. `dsh-fast-compact` package: implement §4, run pure-module unit tests locally
   (`node --test test/refs.test.mjs test/engine.test.mjs`) — no host required.
2. Pack both bundles (2-file layout). `dsh-fast-compact`'s `package.json` pins
   `dsh-hypercompact@0.2.4`.

### 6.2 Install (via `plugin_manager`, as in the editing-cordis skill)

1. `install_bundle` with the absolute path of each bundle dir into the target
   profile (`web`). Verify with `list_bundles` / `list_plugins`: both rows
   present, enabled, host composition otherwise unchanged (each patch is `[]`).
2. Install the preset bundle; verify the new `preset-fast-compact` row appears
   in the preset registry.
3. **New session required**: existing sessions keep their old preset revision;
   the change applies to newly started agents selecting the preset.

### 6.3 In-session verification checklist

- Start a web session on `preset-fast-compact`, confirm `/compact` works (manual,
  idle) and logs show `provider: dsh-fast-compact`.
- Run a tool-heavy turn, trigger compaction (or `dryRun: true` first), inspect
  the checkpoint text: user blocks verbatim, assistant final texts present,
  **no** tool-call args or result excerpts — only the `[session-log references]`
  block with seqs; thinking absent.
- `recall {"seq": <a seq from the reference block>}` returns the full original
  (recoverability is now *advertised by the checkpoint itself*);
  `recall_search` finds by keyword.
- Token meter / context display consistent with the shrunken request (use
  hypercompact's `scripts/measure-session.mjs` pattern to diff bytes before/after).
- Overflow path: simulate a large paste → automatic `context-overflow` trigger
  compacts without error; pairing boundaries never rejected.

### 6.4 Test matrix (in-repo, `node --test`)

| Test | Fixture | Asserts |
|---|---|---|
| refs unit | `buildEvents` (tools + reasoning) | no tool nodes out; assistant text verbatim; ref records correct (seqs, pairing by toolCallId, unpaired results still recorded); dual formats (v1/v2) both handled |
| renderRefSection | ref list | one line per pair, grouped by turn, keyArg clipping, `refKeyArg:false` variant |
| **parity** | tool-free fixture, `toolRefs:false` vs base engine | byte-identical checkpoint frame |
| refs integration | tool fixture through `FastCompactEngine` | checkpoint: user + assistant final only + reference block with correct seqs; stats counts logged; refs count toward byte budget |
| boundaries | span with odd start/end around tool traffic | `toolPairingBalancedBefore/After` pass on real session; commit succeeds |
| budget | oversized user paste / many turns | degradation passes + elision behave as base; reference block degrades last |
| dry-run | any | log line, no events appended |
| recall | post-compaction | originals restorable by the seqs printed in the checkpoint |
| config | unknown key; duplicate modelPolicy | mount-time throw with clear message |

### 6.5 Risks & mitigations

- **Upstream drift** in the copied `runCompaction` → pinned dependency version +
  contract checks at load + the parity test; phase-2 upstream PR (option C)
  removes the copy entirely.
- **Model quality**: checkpoints lose tool context → by design; the seq reference
  block + recall are the escape hatch and now visible in the checkpoint itself;
  document in the preset description and README. Keep `standard`/`hypercompact`
  presets available for sessions that need full fidelity.
- **Double-mount** (both rows present) fails at boot with a cordis single-service
  error — acceptable, documented; never put both rows in one group.
- **License**: MIT throughout; keep attribution + license file in the package.

---

## 7. Milestones

| # | Deliverable | Exit criterion |
|---|---|---|
| M1 | `dsh-fast-compact` scaffold + `refs.mjs` + unit tests | `node --test` green, no host needed |
| M2 | `engine-fc.mjs` + `index.mjs` entry + selfcheck vs running headless dsh | mounts, `ctx.compaction` resolves to the fast-compact engine, parity test passes |
| M3 | `dsh-fast-compact-preset` full-copy bundle installed in web profile; new-session verification (§6.3) | all checklist items pass |
| M4 (optional) | Upstream PR to dsh-hypercompact (`toolEntries: 'refs'` knob); collapse override to config; phase-2 `shrinkRetainedToolResults` | upstream release lands; plugin code shrinks |

---

## Appendix — key source references

- Preset rules: `@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md`,
  `README.md` (no inheritance; full-copy/override semantics; 2-file bundle;
  `plugin_manager` install/verify).
- Reference preset: `C:\Users\vic\.dsh\hypercompact\preset-hypercompact\cordis.patch.yml`
  (full copy of `standard`, compaction row swapped to `dsh-hypercompact`).
- Basic engine config chain: `@deepseek-ai/dsh-compaction-basic/lib/index.js`
  (`resolveConfig` L59 → `resolveTargetPolicy` L94 → `resolveCompactSpec` L124;
  class at L800).
- Base contract: `@deepseek-ai/dsh-compaction/lib/types/index.d.ts`
  (`CompactionEngine` abstract methods, single implementation per context,
  transaction protocol).
- dsh-hypercompact@0.2.4 source (extracted):
  `C:\Users\vic\.dsh\fast-compact\vendor\dsh-hypercompact\package\` —
  `index.mjs` (entry/runtime gating), `lib/engine.mjs` (`runCompaction` L348–540,
  compile call L400), `lib/compiler.mjs` (exports incl. `compileEntries` L309,
  `compileCheckpoint` L790), `lib/config.mjs` (frozen DEFAULTS),
  `lib/housekeeping.mjs` (content-only result rewrite), `lib/messages.mjs`
  (dual tool-result formats), `test/helpers.mjs` (fixture pattern).
