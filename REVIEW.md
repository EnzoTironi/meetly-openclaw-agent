# Review the native rewrite

The PR replaces Meetly's custom boot, model router, setup plugin and action
scripts with a native OpenClaw plugin. Plow retains infrastructure ownership;
the LLM interprets context and writes messages. The scheduling code owns
calendar/inbox confirmation and recovery.

Read in this order:

1. `prompt/AGENTS.md` and `skills/meetly/SKILL.md`: product behavior and tool contract.
2. `src/model.ts`, `availability.ts`, `invitation.ts`: meeting states and calendar guarantees.
3. `src/scheduling.ts` and `records.ts`: receipts, recovery and contact wiki.
4. `src/providers.ts`, `inbound.ts`, `extension.ts`: native boundaries and model conversations.
5. `tests/`: behavior and failure cases; then `Dockerfile` and the native manifests.

The [acceptance matrix](docs/scheduling-spec.md) maps the CEO spec to evidence.
Start with the [real iMessage journey, screenshots and 44-second video](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5979166570),
then the [seven fresh native model cases](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5979061578).
The [real receipt pairs](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5979170629)
make public/private texts and calendar observations directly comparable.
[Earlier physical failures](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5979174287)
remain attached and are labeled separately from final results.
Generated JSON, traces, screenshots and videos are deliberately outside Git.

The shared bootstrap change is separately reviewable in
[Plow PR #47](https://github.com/plow-pbc/plow-openclaw-agent/pull/47).
The app's Dockerfile pins its exact commit and checksum until it reaches the
published base.

Original scheduling reviews covered issues #34, #38 and #56, and PRs #39,
#49, #50, #51, #52, #53, #54, #55 and #57. The review also covered
travel/gate/priority PRs #61, #64, #67, #68 and #69. Their corresponding
behavior is represented by the acceptance matrix: group replies, private
owner gates, researched formats, minimum notice, honest delivery and invites,
re-proposal, wiki/DNC, travel lifecycle and permitted block moves. Ambiguous
choices always ask privately; this rewrite does not silently choose the first
slot. Format comes from context first, then an explicitly remembered default.
The latest feature pass adds existing-group owner requests, join reminders,
current travel buffers, live calendar links, request-scoped owner exceptions
and privately approved Mac discovery. The acceptance matrix distinguishes
code tests, real-model connector fixtures and physical iMessage evidence.

The current code has 108 passing behavior tests and typecheck. The earlier
feature pass recorded 40 distinct successful native model outcomes. Seven
fresh native cases verify the group-language correction, with exact public
and private receipts. The earlier 40 were not rerun after this correction.
Failed attempts and fixes are attached alongside them. Completed history stays
in the wiki and research instead of filling the current status response and
hiding active meetings.
Meetly's own monitor handles reminders; the deployment instructions disable
the separate OpenClaw heartbeat.

Fresh physical iMessage proposal, booking, move and cancellation each verify
one English guest message and one private Portuguese owner report. The
verified invitation includes Daniel and Google Meet; the move preserves the
event ID and link. Final independent calendar reads confirm all 12 test IDs
are absent, with no live holds, cleanup IDs or unfinished operations. These
are owner-authorized choices, not Daniel's RSVP. The failed physical language
attempts and duplicate private confirmation remain visible beside the
correction. A new genuine guest reply, Zoom account creation and an actual
elapsed 24-hour reminder remain physically unverified.

The group-fix structural audit compares against its actual preceding commit
and exits 2. It flags 22 major findings: ten required test API callback
methods that the scanner considers unreachable, ten production churn
findings, one fixture-helper churn finding, and one aggregate NativeMeetly
size increase from 115 to 142.
Two minor findings cover Scheduling size and registration churn. It has
no function-complexity, nesting, parameter or duplication regressions.
No suppressions or baseline reset were added. This is not a green quality score.
