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
The PR description and attached comments contain fresh visual results;
older screenshots from the previous implementation are superseded.
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
slot. Format comes from context rather than an invented default.
