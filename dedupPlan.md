# Duplication-Reduction Plan — dsh-fast-compact

Source checkpoint analyzed:
`C:\Users\vic\.dsh\fast-compact-debug\compacted-summary-2026-10-29T07-04-34-309Z-c6b44b76.md`
(session `session-94bdacca-bf85-4997-9142-5689c6b44b76`, 2026-10-29T07:04:34Z,
checkpoint body **63,903 B**, 151 tagged entries, 28 carried frames).
Audit tool: `scratch-dup-audit.mjs` (workspace root, dev-only).

## Measured duplication

| Family | Entries | Bytes | % of body | Verdict |
|---|---:|---:|---:|---|
| runtime-context | 32 | 22,765 | 35.6% | same snapshot re-injected every turn; each copy declares "supersedes all earlier"; 3 distinct variants (policy change at seq 1324 is separately retained as `[user-approval seq 1324]` verbatim) |
| assistant | 50 | 16,890 | 26.4% | real content — untouched |
| skill-catalog | 31 | 9,328 (4,244 full + 5,053 in 30 pointer lines) | 14.6% | 30 one-line pointers (two legacy wordings: 28× "duplicate injection", 2× "superseded") — aggregate |
| time-context | 15 | 7,101 | 11.1% | superseding snapshots — drop old silently |
| user | 13 | 2,389 | 3.7% | contract-required verbatim — untouched |
| tool-jobs | 5 | 2,198 | 3.4% | distinct jobs; clip repeated `$env:DSH_ENTRY=…` boilerplate |
| model-selection | 4 | 1,129 | 1.8% | superseding one-liners — aggregate |
| user-approval | 1 | 98 | 0.2% | untouched |
| ref lines (inside carried frames) | 26 | — | — | 6 adjacent identical thought labels ≈ 870 B foldable (continuation fix only ran in fresh compiles) |

Expected result on this checkpoint: **63,903 B → ~28–30 KB (≈ −55%)**.
(request bytes in that compaction's meter table: 107,304 after → ~72 KB after fix.)

## Confirmed decisions (user, 2026-10-29)

| Question | Decision |
|---|---|
| Defaults | **Flip defaults** so every session gets the dedupe after plugin reload |
| time-context | **Drop old copies WITHOUT pointer line**; keep newest in full |
| Pointer aggregation | **Yes** — N superseded entries of one kind → ONE range line |
| Carried-frame ref lines | **Yes** — apply thought-label continuation fold at carry time |
| Micro-wins | **Yes** — both: model-selection aggregate + tool-jobs env-boilerplate clip |

## Config design (step 1) — `lib/config.mjs`

Two name-list keys, both via existing `resolveNameList` (accepts list / `null` / `[]`; bad type throws):

- `dedupeContextKinds` — pointer mode (existing key; OLD copies → superseded pointer line).
  New DEFAULT: `['skill-catalog', 'runtime-context', 'model-selection']`
  (was `['skill-catalog']`).
- `dropContextKinds` — NEW key, silent mode (old copies emit NO line at all).
  Default: `['time-context']`.
  Rationale for time-context: the harness re-injects a fresh snapshot on the next
  turn anyway, and timestamps carry no task state.

Both exported through `index.mjs` re-exports; preset YAML may pin either.
Shipped preset row: leave both at defaults (no YAML change needed).

## Implementation steps

### Step 1 — config defaults + new key (`lib/config.mjs`) [x]
- DEFAULTS: `dedupeContextKinds: ['skill-catalog', 'runtime-context', 'model-selection']`,
  add `dropContextKinds: ['time-context']`.
- Validation in the same place `dedupeContextKinds` is resolved (both lists
  `resolveNameList`; duplicate kind across both lists → throw
  `kind "<k>" appears in both dedupeContextKinds and dropContextKinds`).

### Step 2 — compiler: silent-drop mode + aggregation (`lib/compiler.mjs`) [x]
- Generalize `supersededContextSeqs(nodes, kinds)` → per-kind mode map:
  `{kind: 'pointer' | 'drop'}`; returns seq sets + the surviving newest seq per kind.
- Fresh render path: entries marked `pointer` → superseded pointer line (existing shape);
  entries marked `drop` → emit nothing.
- **Aggregation** (both fresh and `carriedEntries` pre-scan): consecutive superseded
  entries of the same kind collapse to ONE line:
  `[<kind> seqs A–B ×N] (superseded — kept whole at recall seq N)`
  (single copy → existing one-line shape, unchanged).
  Non-superseded lines in between break the run. Carried frames re-render with current
  wording, unifying the two legacy pointer wordings.
- Newest full entry per kind stays in place.

### Step 3 — carry-time thought-label fold (`lib/refs.mjs` / carriedEntries pass) [x]
- Port `prevThoughtSeq` continuation logic (same as fresh `refSectionLines`) to the
  path that re-emits ref lines inside carried checkpoint frames, so sibling-call label
  repeats render as `- Turn N · (thought seq T)` continuations at carry time too.

### Step 4 — tool-jobs boilerplate clip [x]
- When rendering `tool-jobs` entries, strip the repeated
  `$env:DSH_ENTRY='C:\Users\vic\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js';`
  env-assignment prefix from embedded command text (exact string to be confirmed
  against the real entries in the audited file; full command stays recall-able by seq).

### Step 5 — tests [x]
- `test/config.test.mjs`: new defaults assertion; `dropContextKinds` accept/`null`/bad-type;
  cross-list duplicate-kind rejection. (10 → 14)
- `test/compiler.test.mjs`: runtime-context supersede+aggregate across frames;
  time-context silent drop (no line, newest kept); pointer aggregation single vs range;
  carriedEntries aggregate re-render with unified wording; carry-time thought-label fold. (8 → 12)
- Full sweep: **68 pass / 0 fail** (config 14 + compiler 12 + refs 22 + engine 12 + select 4 + housekeeping 3 + ref-formats-e2e 1).

### Step 6 — verification [x]
- `node scripts/selfcheck.mjs` → `all checks passed`.
- `dev-parity.mjs`: **cannot run here** — the vendored oracle `vendor/dsh-hypercompact/package/`
  is not present in this checkout (and dsh-hypercompact is not installed under npm `node_modules`).
  Parity is unaffected by construction: the fixtures carry no `runtime-context` /
  `time-context` / `model-selection` injections, so both new passes are no-ops on them;
  proven instead by the fixture A/B in `test/compiler.test.mjs` (identical bytes when
  `dedupeContextKinds: null, dropContextKinds: null` is pinned back).
- Real-log A/B (`scratch-checkpoint-ab.mjs`, input = the audited checkpoint file, 65,777 B):
  new defaults recompile **31,090 B** vs legacy settings **59,249 B** → **saved 28,159 B (47.5%)**.
  Audit of the new output: runtime-context 23,337 B → **677 B** (1 copy), time-context 6,821 B →
  **286 B** (1 copy, silent), skill-catalog pointers 5,053 B → **0** (one aggregate line),
  model-selection 568 B → **166 B**; body 63,903 B → **29,946 B** (−53%).
  `scratch-pointer-check.mjs`: all three aggregate lines name the kept whole copy
  (`recall seq 2914/2915/3013`); no dead-end pointers (the one flagged hit is assistant
  prose quoting an earlier audit, not a compiler-emitted pointer).

### Step 7 — activation [ ]
- Reinstall plugin link deps if needed (`pnpm install` in `dsh-fast-compact\`),
  restart `dsh web`, verify with a NEW session + `/preset fast-compact`.
  (Only when the user wants it live; code+tests can be done first.)

## Progress log

- [x] 2026-10-29 — Audited checkpoint file: per-family bytes measured
  (`scratch-dup-audit.mjs`, fixed truncated-write syntax error on line 15).
- [x] 2026-10-29 — Solution plan presented; all unknowns answered by user.
- [x] 2026-10-29 — Steps 1–4 implemented: config defaults flipped (`dedupeContextKinds`
  `['skill-catalog','runtime-context','model-selection']`, new `dropContextKinds`
  `['time-context']`, cross-list duplicate rejected), silent-drop pass + per-kind mode map,
  superseded-pointer aggregation (one range line naming every collapsed seq and the kept
  whole copy — newest whole copy of that kind, including copies inside carried frames),
  carry-time thought-label fold (`foldCarriedThoughtLabels`), tool-jobs env-boilerplate clip
  (`clipEnvAssignments`).
- [x] 2026-10-29 — Step 5 tests added (4 compiler tests): sweep 64 → **68 pass / 0 fail**.
- [x] 2026-10-29 — Step 6 verification: selfcheck green; real-log A/B −47.5% bytes
  (dev-parity oracle absent, see note above).
- [ ] 2026-10-29 — Step 7 activation (reinstall + restart `dsh web`), on request.

