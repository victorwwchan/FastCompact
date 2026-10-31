# cross-span safety — real log, a window that holds real human turns


- input log: `C:\Users\vic\.dsh\fast-compact\dsh-fast-compact\test\fixtures\session-fa7af7bf-afee-45bf-b552-e2b5b21276eb.v4.jsonl.zstd`
- events used: 1478 of 3358 (cut after the human turn at seq 1475)
- open tail turn closed in memory: yes (turn 6)
- committed span: seq 1357–1467 (67 nodes, 1364,1369,1374,1389,1394,1399,1404,1409,1414,1419,1424,1429,1434,1439,1446,1453,1458,1463 tool calls)
- pinned human turns: 1 inside the span + 3 older ones an earlier compaction shadowed (re-read off the log) = 4 lines, every one kept at any output budget (clipped to retainLength=200, restorable by recall)
- shadowed calls the LOG re-indexed for older spans: 189 (stats carriedRefs 189) of 69 printed — every prior checkpoint in this window was written by ANOTHER backend, yet its traffic is still indexed because the log, not that body, is the source
- oldest seq still named in the section: 1013 (span starts at 1357)

## Reference section of the run (first lines)

```text
: seq 19–1464
Restore any original with recall {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call recall_search for it first, then restore the seqs it reports.
- 139 earlier calls: seq 19–1009, restore with recall or recall_search
- [Header is pushed at the END of every fixture (config provider 'p', model 'm') ✓ — requestHeader() returns it since events include it (and header fold applies once log includes that seq). Now append th…] (thought seq 1013) → seq 1014, result seq 1015, 0.1 KB
- [The `.concat(...).reduce(...)` spread trick is convoluted; replace with a clean object built from deriveRoutePressure. Also `expectedBefore` computation is meaningless (unused assert) — remove it and …] (thought seq 1019) → seq 1020, result seq 1021, 0.1 KB
- [Now the shadowed/before assertions: `priced` defined before compactNow ✓ (I moved it). Replace the old expectedShadowed/expectedBefore block below accordingly. Note: `result.shadowedSeqs` are seqs tha…] (thought seq 1024) → seq 1025, result seq 1026, 0.1 KB, error
- [The earlier block ordering — my first appended version had asserts in a different position. Read the new test region to fix precisely.] (thought seq 1029) → seq 1030, result seq 1031, 4.7 KB
- [Fix: remove duplicate `priced` definition and the stale expectedBefore block (lines 292-302), replacing with asserts using outer `priced`/`expectedBefore`. Also `stats.route === 'p/m'` — describeRoute…] (thought seq 1034) → seq 1035, result seq 1036, 0.1 KB
- [Also: `entry.headroomTokens` assertion — pressureTable is the raw row value I passed, whose perRoute[0].headroomTokens = routePressure.headroomTokens ✓ (deriveRoutePressure returns {headroomTokens, th…] (thought seq 1039) → seq 1040, result seq 1041, 0.1 KB
- [Also `surfaceBefore` now unused except via expectedBefore ✓ used. Add groupInt to imports (compiler.mjs exports it). Then run engine tests. One more risk: base's overflow/retry may re-enter summarize …] (thought seq 1044) → seq 1045, result seq 1046, 0.1 KB
- [Now, before running: the stray `test/probe-header.mjs` I created earlier must be deleted.] (thought seq 1049) → seq 1050, result seq 1053, 1.0 KB
- [Forgot DSH_ENTRY env (findDsh probes `where` which fails in sandbox). Rerun with env pinned.] (thought seq 1056) → seq 1057, result seq 1060, 1.5 KB
```
