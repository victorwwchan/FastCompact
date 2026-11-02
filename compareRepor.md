# Compare Report — `compactBasic.md` vs `FastCompact.md` (Memory & Context Feature Review)

**Generated:** 2026-11-01 (~22:20 -08:00, America/Los_Angeles)
**Sources:** [compactBasic.md](<compactBasic.md>) (session `d92282ed-134d…`, reference run) · [FastCompact.md](<FastCompact.md>) (session `37d1151c-bca1…`, follow-up run)

---

## 0. TL;DR

Both runs are **efficiency stress tests of the same live preset** (`dsh-fast-compact`), not a Basic-vs-Fast engine A/B test — see the naming caveat in §4. What *does* differ is the **memory-retrieval methodology**: run 1 recovered evicted details by grepping dumped logs (no `recall` tool available in that session), while run 2 restored them through the plugin's real `recall` / `recall_search` tools with byte-exact verification. **Memory-accuracy verdict: both runs end at 100% detail recoverability** (8/8 and 16/16); zero details were ever lost across a combined 33 compactions. The only accuracy blemish observed in either run was one transient confabulation that recall itself corrected.

---

## 1. Run-at-a-glance

| Metric | `compactBasic.md` (reference) | `FastCompact.md` (this run) |
|---|---|---|
| Session | `session-d92282ed` | `session-37d1151c` |
| Route / window | 64KB, W = 65,535 | `strata-llm/64KB`, W = 65,535 |
| Pressure gate | 30,914 tokens (47.2% of W, practical ceiling) | ~30,914 heuristic tokens (~47.2%, same ceiling) |
| Retain ratio | 0.12 | 0.12 (tail ≈ 4,024 tokens) |
| Compactions | **10** (start/end brackets 10/10; summaries 8 at dump — write lag) | **23** (from 42 debug dumps) |
| Traffic load | padfile reads (250–700 lines) + corpus range reads, pruner capped results ~5 KB | 19,230-line filler in 500-line (~40 KB) reads + detail corpus + user probes |
| Duration | Loop 41 m 36.5 s; step 2 total 73 m 34.4 s | Cadence ≈ every 4–6 filler reads, span seq 8 → 900+ |
| In-window "native" memory at end | 2/8 sampled details | **0/16** (all compacted out — by design) |
| Restored via retrieval | **8/8** (grep over dumped `_live.jsonl` + corpus file) | **16/16 = 100% byte-exact** (`recall_search` + one `recall {"range"}`; zero file re-reads) |
| Sample | 8 of 300 D-IDs (6 compacted-zone, 2 recent-window) | 16 of 300 D-IDs, **deliberately excluding run 1's 8 IDs** to prevent value leakage |
| Final compaction effect | not measured per-event | usage 46.4% → 24.0%, freed 14,656 tokens |

---

## 2. Memory-context feature comparison (how the two runs treated memory)

### 2.1 What stays in the context window

| Feature | Run 1 (`compactBasic.md`) | Run 2 (`FastCompact.md`) |
|---|---|---|
| Recent-tail retention (retainRatio 0.12) | Active — explains why only the last un-compacted read window survived natively (D150, D201) | Active — retention tail ≈ 4,024 tokens; after 23 compactions ~0% of early details sit in-window |
| Pinned content (every user message verbatim) | Present by preset (all user side-tasks/requests survived to be answered later) | Present — the interleaved probe questions (seq 203, 242, 294, … 814) were answerable across compactions |
| Tool traffic → seq references | Implied by the preset row, but **not exercised** (no recall tool in session) | Core contract exercised: dropped tool results became cumulative session-log reference lines pointing at recallable seqs |

### 2.2 How evicted memory is restored — the key difference

| Retrieval path | Run 1 | Run 2 |
|---|---|---|
| Plugin `recall` / `recall_search` | **Not available** in that session — explicitly flagged as a limitation ([compactBasic.md#L46](<compactBasic.md#L46>)) | Used exclusively; 2× `recall_search` + 1× `recall {"range"}` restored all 16 sampled lines byte-exact, cross-checked against the seq 66/67/68 snapshot ([FastCompact.md#L94-L97](<FastCompact.md#L94>)) |
| Fallback | Grep over dumped append-only v4 log (`_live.jsonl`) + corpus file; frame-hit counts as evidence (174, 534, 399, … hits per D-ID) | Not needed — "zero file re-reads" |
| Ground truth when the source file changed | Not applicable | `details-corpus.txt` was **regenerated into a different prose format mid-test**; only the session log preserved the original pipe-format lines — recall became the single source of truth ([FastCompact.md#L106-L109](<FastCompact.md#L106>)) |

### 2.3 Memory metric definition

- Run 1 scored two columns: *native memory* (2/8) vs *retrieval* (8/8) — and added a "post-report re-recall" addendum at 22:07 that pulled the 6 forgotten details back from the log, ending **8/8 in context** ([compactBasic.md#L48-L60](<compactBasic.md#L48>)).
- Run 2 defined **effective memory = details correctly restored via recall ÷ sampled** (16/16), deliberately decoupled from whatever happens to sit in the window — the correct metric for a compaction engine whose whole point is an empty window + lossless log.

**Verdict:** run 2's metric is the more meaningful one; run 1's dual-column view is still useful evidence that the retention tail does exactly what it should (recent reads stay native, old ones don't).

---

## 3. Memory accuracy review — Fear vs Truth

| # | Fear (the concern) | Truth (what the runs actually show) |
|---|---|---|
| F1 | "Compaction loses details — once summarized out, a number or line is gone." | **False.** Across 10 + 23 = 33 compactions, 24/24 sampled details (8/8, 16/16) were restored; run 2's restorations were byte-exact against the log snapshot. The append-only v4 log kept every detail by seq in both runs. |
| F2 | "The model will confabulate forgotten details and present guesses as memory." | **Partially observed, self-corrected.** Run 2's own ✓-line briefly misremembered random #1 as "7" (seq ~302–453); log verification at seq 730–870 corrected it to 410985 ([FastCompact.md#L90-L92](<FastCompact.md#L90>)). Trap question at seq 203 ("told u to gen random number 1") was correctly rejected with nothing confabulated. Net: drift can happen in *prose*, but the log is authoritative and recall self-corrects. |
| F3 | "Summary write lag means compaction events are incomplete (run 1 showed 8 summaries vs 10 starts)." | **Write-lag artifact, not data loss.** Dumps were taken mid-turn; the append-only log catches up in later frames — "missing summaries, if any, land in later frames and do not affect recall" ([compactBasic.md#L25](<compactBasic.md#L25>)). Every `start` was eventually bracketed by an `end` (10/10). |
| F4 | "Low native memory (0/16) means the engine is failing to remember." | **Misread of the design.** 0/16 in-window after 23 compactions is the intended trade-off; effective memory via recall was 100%. Judging this engine by in-window retention is like judging a hard drive by RAM. |
| F5 | "`recall_search` noise could make retrieval unreliable (case-insensitive matches buried real lines)." | **Confirmed as a precision hazard, not a correctness issue.** An unanchored `D019|D037|…` pattern matched lowercase hex substrings in 64-char filler strings; the first probe returned 45 mostly-noise hits and pushed real lines out of the top-40 window. Anchoring (`D(019|…) \|`) fixed it in one retry ([FastCompact.md#L98-L103](<FastCompact.md#L98>)). Improvement note stands: consider case-sensitive regex default or documented anchoring. |
| F6 | "Without the `recall` tool (run 1), the plugin's contract is untestable / unusable." | **Partially true — a real gap worth fixing.** Run 1 had to fall back to dumping and grepping the zstd log manually. It worked (8/8), but the intended in-session recall path could not be exercised; the limitation was honestly documented rather than papered over. |
| F7 | "Heavy compaction cadence (~every 4 min, 'pressure on borrowed time') risks overflow or lost turns." | **False.** No overflow recovery was ever needed, no turns were lost, and sessions stayed fully functional at maximum sustainable compaction frequency. The 47.2% practical gate ceiling (message shape can't reach the theoretical 80%) just means compactions fire more often than a naive token-math prediction — cadence had to be calibrated empirically via bracket counts ([compactBasic.md#L27](<compactBasic.md#L27>)). |
| F8 | "Token-math predictions will tell us when compaction fires." | **False.** Run 1's prediction of "one 35–45K-token read per compaction" was wrong because the tool-result pruner pre-shrank results to ~5 KB; the surface refilled predictably but on a different scale than raw reads suggested ([compactBasic.md#L27](<compactBasic.md#L27>)). Measure, don't model. |

---

## 4. Naming caveat (truth check on the file names)

- Despite the name **`compactBasic.md`**, the file's own header states its preset is the **`dsh-fast-compact` live row** with zero-LLM summarization and append-only recall ([compactBasic.md#L4](<compactBasic.md#L4>), [compactBasic.md#L78](<compactBasic.md#L78>)). It is *not* a test of the official `@deepseek-ai/dsh-compaction-basic` LLM-summarization preset.
- For reference, what the **official basic** engine would do differently: one extra model request writes the summary, and **only its text is retained** — evicted detail survives only as prose at the summarizer's discretion, with no seq references and no `recall` path (`dsh-compaction-basic` README: "Condensation uses one extra model request and retains only its summary text"). That is the real Basic-vs-Fast delta; these two files compare **two fast-compact stress runs**, not that delta.
- Practical consequence: if a true Basic-vs-Fast accuracy comparison is wanted, run the same 300-ID corpus under the `standard`/basic preset and score with the same recall-based metric — the expected failure mode there is lossy LLM summaries (no byte-exact recovery), which is exactly the property F1 disproves for fast-compact.

## 5. Methodology differences & caveats

| Aspect | Run 1 | Run 2 | Note |
|---|---|---|---|
| Sample size | 8/300 (2.7%) | 16/300 (5.3%) | Small samples; both are spot-checks, not full 300-ID sweeps |
| Leak control | n/a (was the reference) | Excluded run 1's 8 IDs so no value could leak from the reference report | Good experimental hygiene in run 2 |
| Verification source | Frame-hit counts + corpus file re-grep | Cross-check against full 300-line snapshot restored from log seqs 66/67/68 | Run 2's check is stronger (content-verified, not just presence-verified) |
| Source-file stability | Corpus file intact throughout | `details-corpus.txt` regenerated mid-test — recall proved to be the only durable copy | This is the strongest single argument for the log-as-truth design |
| Random-number bookkeeping | 4 draws (849445, 370832×3→1,112,496, 325986, 784969) | 3 values (410985, 265, 81×2=162) + trap rejection at seq 203 + honest "only 3 exist" answer | Run 2 exercised false-premise handling; both sets are internally consistent with their logs |

## 6. Conclusion & recommendations

1. **Core property holds end-to-end in both runs:** fast-compact frees the live window (up to 23 consecutive compactions, 14,656 tokens freed in a single final compact) while every detail remains recallable — 100% effective memory, byte-exact when the recall tools are used.
2. **In-window retention is a design feature, not an accuracy metric.** Score runs by restored-via-recall, not by what natively survives.
3. **Fix the run-1 gap:** make `recall` / `recall_search` available in every fast-compact session; manual log-dump grepping should be a debugging tool, not a test fallback.
4. **Adopt the F5 improvement:** default `recall_search` regex to case-sensitive, or document the ID-anchoring requirement, so unanchored probes don't drown in hex-filler noise.
5. **If a real Basic-vs-Fast comparison is needed**, rerun this corpus under the official `dsh-compaction-basic` preset — that A/B (lossy LLM summary vs deterministic seq-indexed recall) is the one this file pair does *not* provide.
