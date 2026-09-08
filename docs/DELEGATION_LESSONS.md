# Delegation lessons — 2026-09

Operational notes from the parallel review batch (5 concurrent agents over Chorus). Concerns how to
run subagents, not this codebase. Read before dispatching another multi-agent batch.

## 1. Structured output can swallow the prose body — verify before trusting

`UiReview`'s `report` field never reached the artifact: only `summary` / `files` / `architecture`
survived, and `agent://UiReview?q=.report` returned `null`. Recovery required `hub send` asking it to
re-send the body as an ordinary reply.

`DataLayerReview` / `AdapterReview` / `MV3Review` all carried `report` fine, so this was **one
agent's output being truncated, not a schema fault**.

Rule: markdown sections demanded in a `context` contract are not guaranteed to land in structured
fields. On receipt, check the key field is non-empty before synthesizing; if empty, `hub send` for a
plain-prose resend rather than re-running the agent.

## 2. Evidence-heavy tasks stall in self-verification loops

`SecReview` ran 20+ minutes. Its transcript showed `"I have all evidence needed... then yield"`,
then **8 further grep rounds re-pinning line numbers**, never finishing. The stricter the citation
standard, the more such an agent re-audits itself.

Rule: give evidence-strict agents an explicit stop condition — *"once a line number is written, stop;
do not re-verify"* — or plan to cancel and take over. Taking over cost far less than waiting.

## 3. `hub wait` returns on the first event, not on "all done"

Several consecutive calls came back `[Uneventful result elided]` — empty spins. It must be re-issued
in a loop, and narrowing `ids` to the single stuck job does **not** speed anything up. Budget for
re-issuing; don't read one quiet return as "still healthy, keep waiting".

## 4. Five concurrent reviewers produced more than the merge could absorb

The slicing was sound — adapter / mv3 / data / ui / security had clean boundaries and no edit
conflicts — but four reports totalled several thousand lines and roughly 30% got used. Asking each
slice for `max ~450 lines` actively manufactured context pressure.

Rule: cap at ~3 slices, or demand **findings only** — no `strengths`, no `architecture`, no `files`
restatement. Those sections read well and inform little.

## 5. Read-only research belongs on `scout`

Four slices used `scout` (correct: faster, read-only). The one that used `security-reviewer` was
precisely the one that never yielded. Prefer `scout` for investigation unless a specialist's judgment
is genuinely required, and even then apply lesson 2.

## 6. Unrelated: `bash` returned output belonging to another command

Two `wc -l` pipelines returned `clean — nothing to commit` — output with no relationship to the
command. Filed via `report_issue`. `eval` produced correct line counts.

Rule: if tool output is nonsensical for the command issued, don't try to interpret it — switch tools
and report it.
