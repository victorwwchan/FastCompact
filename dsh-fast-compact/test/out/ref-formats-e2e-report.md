# refLineFormat e2e — committed sample session log

- input log: `C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\fixtures\session-fa7af7bf-afee-45bf-b552-e2b5b21276eb.v4.jsonl.zstd`
- source: the committed fixture under `test/fixtures` — the same frozen sample every run
- other logs skipped: none
- events: 3155 (compressed 3082.4 KiB / 10820 KiB JSONL, 1879 zstd frames)
- window used for judging: cut after seq 3152 — the newest checkpoint-bounded stretch that holds human turns, so the pin block gets real work
- open tail turn closed in memory: yes (turn 12)
- session id: session-fa7af7bf-afee-45bf-b552-e2b5b21276eb · preset of that log: fast-compact
- engine: dsh-fast-compact / fast-compact-compiler-v1 (no model call anywhere)
- shared config: `auto: false`, `retainTokens: 0` (test-only: makes the whole real surface compactable)
- committed span: seq 2900–3148 (125 surface nodes, 43 tool calls)
- pinned human turns: 2 inside the span + 10 older ones an earlier compaction already shadowed (re-read off the log) = 12 lines, every one kept at any output budget, clipped to retainLength=200 and restorable by recall
- context kinds this log injects: `runtime-context`, `skill-catalog` — every one appears in every body (carried back when its injection lies outside the span)
- reference-section budget: `contextMaxRatio` 0.25 × the MESSAGE BUDGET the route leaves its window (window − reserved output; the raw window stands in when the route names no budget — these direct runs name none), else the 16000-byte fallback — the section is sized from that share, NOT a fixed block; only the OLDEST lines collapse into one range line, and only when that share cannot hold every line

| refLineFormat | thoughtChars | checkpoint bytes | shadowed tokens | ref lines | pointers | call coverage | collapses | ms |
|---|---|---|---|---|---|---|---|---|
| thought | 0 | 28130 | 50718 | 271 | 807 | 43/43 | 136 | 65 |
| thought | 200 | 28296 | 50718 | 66 | 195 | 43/43 | 0 | 174 |
| none | 0 | 28124 | 50718 | 155 | 308 | 43/43 | 252 | 97 |
| none | 200 | 28373 | 50718 | 155 | 308 | 43/43 | 252 | 97 |

## Shared-thought collapse on the `thought` shape

The span's input events demand 0 collapse(s): a call whose governing thought the line above already quoted keeps only its pointer, so the same prose never repeats while every seq stays recallable.

## Reference section of every run (first lines)

### thought-thoughtChars0
```text
: seq 19–3148
Restore any original with recall {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call recall_search for it first, then restore the seqs it reports.
- 136 earlier calls: seq 19–994, restore with recall or recall_search
- (thought seq 998) → seq 999, result seq 1000, 1.1 KB
- (thought seq 1003) → seq 1004, result seq 1005, 0.1 KB
- (thought seq 1008) → seq 1009, result seq 1010, 1.6 KB
```
Full checkpoint: [thought-thoughtChars0](C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\out\checkpoints\thought-thoughtChars0.txt)

### thought-thoughtChars200
```text
: seq 19–3148
Restore any original with recall {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call recall_search for it first, then restore the seqs it reports.
- 341 earlier calls: seq 19–2662, restore with recall or recall_search
- [So "pin block" = `## Pinned content (recalled — kept verbatim)` which pins content the model RECALLED (seqs from recall tool calls), not user messages. The user expects instead: **all user messages** …] (thought seq 2667) → seq 2668, result seq 2669, 1.0 KB
- [Let me read compiler.mjs around lines 40–190 to see pinnedBlock and stateBlock, and around 400-460 for the budget/pin logic. Also need to see how context blocks (runtime) are emitted (`contextBlocks` …] (thought seq 2672) → seq 2673, result seq 2674, 10.3 KB
- [Wait: compiler.mjs has DEFAULT_DEBUG and DEBUG_HEADING — "debug trail" block; note also that `debug` row key was said dead earlier in skill but here it's live (skill changelog predates). Fine. Continu…] (thought seq 2677) → seq 2678, result seq 2679, 7.0 KB
```
Full checkpoint: [thought-thoughtChars200](C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\out\checkpoints\thought-thoughtChars200.txt)

### none-thoughtChars0
```text
: seq 19–3148
Restore any original with recall {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call recall_search for it first, then restore the seqs it reports.
- 252 earlier calls: seq 19–1859, restore with recall or recall_search
- pwsh $env:DSH_ENTRY = 'C:\Users\vic\AppData\Roaming\npm\node_modu… → seq 1865, result seq 1868, 0.6 KB
- pwsh $env:DSH_ENTRY = 'C:\Users\vic\AppData\Roaming\npm\node_modu… → seq 1872, result seq 1875, 0.1 KB
- pwsh $env:DSH_ENTRY = 'C:\Users\vic\AppData\Roaming\npm\node_modu… → seq 1879, result seq 1882, 0.9 KB
```
Full checkpoint: [none-thoughtChars0](C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\out\checkpoints\none-thoughtChars0.txt)

### none-thoughtChars200
```text
: seq 19–3148
Restore any original with recall {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call recall_search for it first, then restore the seqs it reports.
- 252 earlier calls: seq 19–1859, restore with recall or recall_search
- pwsh $env:DSH_ENTRY = 'C:\Users\vic\AppData\Roaming\npm\node_modu… → seq 1865, result seq 1868, 0.6 KB
- pwsh $env:DSH_ENTRY = 'C:\Users\vic\AppData\Roaming\npm\node_modu… → seq 1872, result seq 1875, 0.1 KB
- pwsh $env:DSH_ENTRY = 'C:\Users\vic\AppData\Roaming\npm\node_modu… → seq 1879, result seq 1882, 0.9 KB
```
Full checkpoint: [none-thoughtChars200](C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\out\checkpoints\none-thoughtChars200.txt)
## The same span at two output budgets

| variant | ref budget (bytes) | rows named | rows folded | checkpoint bytes |
|---|---|---|---|---|
| budget-64k-window | 53691 | 219 | 188 | 65094 |
| budget-unlimited | 39988159 | 406 | 0 | 106730 |


### budget-64k-window
```text
## Session-log references (dropped tool traffic): seq 19–3148
Restore any original with recall {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call recall_search for it first, then restore the seqs it reports.
- 188 earlier calls: seq 19–1269, restore with recall or recall_search
- [All green. Now commit in outer repo. Check git status for relevant paths first.] (thought seq 1275) → seq 1276, result seq 1279, 0.2 KB
- [I need to keep debugging: their live route is strata-llm/120KB (W=122880, O=32000), yet compaction fired at "28%". I must find the real live gate. The probe needs fixing (Session.create rejected the s…] (thought seq 1363) → seq 1364, result seq 1365, 0.3 KB
```
Full checkpoint: [budget-64k-window](C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\out\checkpoints\budget-64k-window.txt)

### budget-unlimited
```text
## Session-log references (dropped tool traffic): seq 19–3148
Restore any original with recall {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call recall_search for it first, then restore the seqs it reports.
- [First, let's load the dev-fast-compact skill.] (thought seq 18) → seq 19, result seq 20, 43.9 KB
- [The user is reporting two bugs: 1. thresholdRatio: 0.9 was set, but compaction ran at 0.5 — why? 2. Debug isn't working. Needs to dump the context window along with statistics data (e.g., current cont…] (thought seq 23) → seq 24, result seq 26, 0.1 KB
- (thought seq 23) → seq 27, result seq 28, 0.1 KB
```
Full checkpoint: [budget-unlimited](C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\out\checkpoints\budget-unlimited.txt)
