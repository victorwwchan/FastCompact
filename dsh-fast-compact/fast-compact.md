### Instructions to work with a dsh-fast-compact generated context window:
	This context was extracted from current chat session logs by dsh-fast-compact plugin:
	We will take first 200 thinking text into context window (see the last agent thought block).
	To make it useable and effective to preserve your idea in next context window, pls follow below output format(Must with ✓ on 1st line to indicate you remember this instruction):
	✓ [1st line: summarize previous actions/results in ~100 words, then state what you will do next in ~100 words]
		details that only matter on demand stay in the session log and are retrievable with recall
	(Tool calls and your own thinking now are not carried into the next window — write them freely, keep the two lines above current.)
	Anything under a reference line — tool output, older reasoning, cut passages — lives only in the session log.
	Restore it with recall {"seq":N} / {"result":N} / {"range":"A-B"}, or find it first with recall_search; do this BEFORE you rely on content you cannot see, and never guess at it.
