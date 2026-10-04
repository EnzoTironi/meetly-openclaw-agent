# Review native scheduling

The PR completes Meetly's native scheduling workflow: existing groups,
private owner approval, Mac discovery, meals and daily limits, live links,
and natural conversation without duplicate notices. Plow owns infrastructure;
the LLM interprets context and writes messages. Scheduling code verifies
calendar/inbox actions and recovers their receipts.

Read in this order:

1. `prompt/AGENTS.md` and `skills/meetly/SKILL.md`: product behavior and tool contract.
2. `src/model.ts`, `availability.ts`, `invitation.ts`: meeting states and calendar guarantees.
3. `src/scheduling.ts` and `records.ts`: receipts, recovery and contact wiki.
4. `src/providers.ts`, `inbound.ts`, `extension.ts`: native boundaries and model conversations.
5. `tests/`: behavior and failure cases; then `Dockerfile` and the native manifests.

The [acceptance matrix](docs/scheduling-spec.md) maps the CEO spec to evidence.
Start with the [real Daniel iMessage journey](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982406166),
then [meal, daily-limit and nearest-time model cases S00–S05](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5981783951)
and [fresh group cases G01–G07](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5981793583).
The [eight conversation cases](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982405271)
include intentional silence, current state after a guest books, Pacific
daylight saving time and one notice per action. Panels identify their code
revision, delivered text, source IDs and independent calendar observations.
The [final installed-source and calendar proof](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982574760)
includes the last provider-boundary correction and final checks.
[Retained failures](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982410703)
remain visible beside the corrections. The 54-second video is an evidence
slideshow, not a continuous screen recording; raw Messages captures accompany it.
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

Code `9efc52a` has 125 passing behavior tests, typecheck and Docker build.
Native OpenClaw/Codex runs record 21 distinct outcomes: six planning, seven
group and eight conversation cases, at their labeled revisions. Connectors
are simulated; Messages screenshots and live calendar reads are separate.
All 21 were not rerun on the final parser commit. The earlier 40 native
feature outcomes remain historical evidence and were not all rerun.

The physical journey includes Daniel's own choice and timezone question,
without owner impersonation or technical instructions. Three replacement
holds preserve Monday/Wednesday and daily limits; all old IDs disappear.
The invitation verifies his email and Google Meet. The corrected move retains
the event ID/link and sends one English guest notice and one Portuguese private
report. Final cancellation sends one guest notice; the LLM chooses no optional
private acknowledgement. Fresh reads after the final install verify all six
IDs absent, status `passed`, no live holds, cleanup IDs or unfinished operations.
Connected new Zoom creation, a consenting SMS/RCS carrier recipient and an
actual elapsed 24-hour reminder remain physically unverified.

The real run exposed stripped Markdown hard breaks and a stale wiki after a
Docker restart. Publication recovery now uses its confirmed inbox receipt;
atomic wiki writes flush the file and directory before retiring recovery data.
Model context includes the verified booking facts. The conversation run also
exposed OpenClaw forcing a visible answer after NO_REPLY. The shared Plow
patch seeds native group silence; the README includes the native command for
existing installs. An owner answering a guest is not a request to relay it.
The LLM makes that decision, and unrelated chatter creates no scheduling task.
The native tool returns verified deliveries so the model can see that a notice
already went out. Its authenticated current owner request anchors the private
reply's language in an existing conversation. Date-aware timezone facts come
from the verified invitation. A sent proposal is not replaced without a new
participant request or verified change. The final provider correction decodes
the exact quoted Google text envelope observed through Plow, allowing exact
priority-title and saved personal Zoom comparisons; the content stays data.
Meetly's native monitor handles reminders; the separate heartbeat is disabled.

Production remains eight TypeScript modules, 2,066 physical source lines.
This planning and recovery pass adds 91 lines against `6355777`, and the full
PR adds 330 against its actual base `72a6a9c`, with no new production module
or dependency. The announced Plow
preview had 33 production files and 3,416 lines. The module count does not
make the structural audit green.

The full PR structural audit compares the actual base 72a6a9c with the final
code and exits 2. It flags 15 major findings: ten required test API callback
methods considered unreachable, and five aggregate production class sizes.
One minor finding concerns the calendar fixture. The planning/recovery wave
against `6355777` has two major aggregate class increases: NativeMeetly
142→152 and Scheduling 721→757. Receipt recovery and calendar transitions
remain together in the existing workflow. Aggregate class size remains a
maintainability cost.
Neither audit finds a function-complexity, nesting, parameter or duplication
regression. Committed-tree scans cannot measure churn; earlier working-tree
churn findings remain in the attached audit. No suppressions or baseline
reset were added. This is not a green quality score.

The shared Plow commit `e778c51` passes 274 tests inside its published
OpenClaw SDK image and typecheck. The suite uses the base's `ask` trust default;
the private Meetly line remains `untrusted`. Earlier host/image-setup failures
are retained. Its structural scan has no gating regression, but still flags
one new getter and a minor dispatcher size increase. Local test success is
not a claim about configured CI or a green structural score.
