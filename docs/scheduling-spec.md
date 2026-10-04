# Scheduling contract and acceptance

The LLM researches context, interprets requests and dates, and writes all
outgoing prose. The native workflow verifies side effects and remembers
receipts. Owner authority comes from Plow's authenticated roster and inbox,
never from a name or a claim inside a message.

## CEO specification

| Requirement | Implementation and regression evidence |
|---|---|
| Owner or external request | `inbound.ts` interprets incoming messages on the agent's served Plow threads; the native owner tool verifies private/group owner identity. New direct Mac requests need a captured source receipt and private owner approval; archive research has no authority. Workflow tests cover both origins and implicit meeting language. |
| Research before proposing | `research` reads texts, full email bodies, earlier calendar meetings, served Plow threads and contact wiki. Missing context goes privately to the owner. A supplied iMessage email bypasses Contacts lookup. |
| Three held slots | `availability.ts` checks all configured calendars, timezone, working hours and notice. Workflow tests verify three calendar holds, or nine events with in-person travel. |
| External owner gate | Only private approval of the current revision permits publication. Tests reject guest approval, premature publication and carried approval after re-proposal. |
| Invite, link, cleanup | `invitation.ts` verifies time, every attendee and the saved provider link. Tests retain siblings on a missing link/attendee/tentative invite and delete them only after recovery. |
| Monitor every X minutes | Native service uses `monitorMin`. Tests cover expiry, pending writes, replies, owner/contact/join reminders, current links, unavailable providers and pause. |
| Re-propose | Reject-all excludes old starts, preserves owner weekday/daily/date limits, and verifies a feasible three-option plan before retiring holds. An impossible request retains the sent proposal and goes privately to the owner. Old revisions cannot book; external replacements need fresh approval. |
| Priorities | Only owner-listed exact titles on the write calendar may move, with verified owner creation and without attendees or conferences. Creator email must match the queried account, or the provider must supply its compact ownership proof; `self` flags are insufficient. Tests preserve collaborator/unproven blocks and hard appointments, and exclude private titles from outgoing context. |
| One contact wiki | `records.ts` retains a stable contact page with exact IDs, sent receipts, advisory `next_step` and dated prose. Tests cover renamed contacts and interrupted page writes. |
| Meals and nearest alternatives | Lunch/dinner/coffee durations are remembered, explicit durations win, and sensible meal windows stay inside owner hours. Daily restrictions apply in the owner's timezone. Nearest alternatives remain disjoint including travel. Tests verify DST, meal-hour exceptions and independent priority-block relocation. |
| Remember preferences | Owner-confirmed provider, room mode, durations, travel and explicit link steps are stored under `entities/owner`. Tests cover all three video modes, zero travel, current buffers on move, remembered default format and link preservation on move. |
| Write as assistant | Model instructions require third-person owner wording. Validate the actual model's outgoing text in the integration and iMessage runs. |
| Natural guest conversation | The LLM addresses the guest in their meeting group, using their latest verified language. Answers use verified attendees, links and date-aware timezone conversions. Owner reports and decisions stay private; their current authenticated request supplies the language cue. Verified deliveries prevent an extra final notice. Person-to-person chatter can remain silent through native group silence. Booking and move notices include the link automatically. Native hook tests prevent public owner reports. |
| Find answers first / private clarification | Context research precedes missing-detail questions. Fixtures cover an email-only contact, missing provider and the origin of private owner questions. |
| Reveal no personal reasons | Guest context contains its meeting and sent options, not busy-event titles, other contacts or credentials. Adversarial model tests exercise owner impersonation and private calendar requests. |

## Failure and boundary cases

The behavior tests exercise unknown create/send responses, restart recovery,
partial hold failure, delayed receipt recovery after expiry, incomplete or
unreadable calendars, all-day daylight-saving boundaries, duplicate inbound
delivery, competing choices, cross-contact choices, repurposed holds,
blocked contacts, and calendar-side moves/cancellations. New tests cover
owner requests inside existing groups, exact contact/roster scope, private
external approval inside those groups, current travel preferences (0→45→0),
same-time calendar link changes, and guest answers while calendar reads fail.
Owner exceptions allow only explicit working-hours changes and exact event
IDs for one proposal; future conflicts remain busy and preferences stay
unchanged. Every proposal still has exactly three held options.
Reused contact groups select the newest sent proposal. Research excludes
other phone lines and closed chats. Native Code Mode may orchestrate the
scheduling tool while raw calendar, message and file writes stay guarded.
Mac discovery captures new direct receipts per sender and starts after a
baseline cursor. The LLM ignores unrelated conversations; discovered
requests can only prepare privately gated meetings. Tests verify that
previously queued archive rows without new provenance cause no model calls
or sends, and owner-answered messages do not trigger a second response.
An unanchored private-decision interpretation cannot start a new task. The
first verified interpretation persists across receipt retries, preventing a
second interpretation from creating a different question for the same message.
Explicit source references are verified before a durable task is admitted.
Invented IDs and completed inbox reads that reject a source never become a
retry loop; unavailable provider reads remain unconfirmed.

Repair updates the original event. It preserves a verified Meet link, or
creates a missing Meet link before cleanup. An uncertain new Zoom room needs
its existing join URL, supplied privately by the owner; it cannot create a
second room. Model-written drafts persist before a send and are reused on
retry. Inbox verification tolerates transport Markdown escaping and removal of
hard-break trailing spaces while storing the exact returned body. Recovery
uses the existing send receipt; changes to times, dates or links still fail
verification. An authorized proposal awaiting its receipt does not need a
second owner approval. Private booking drafts carry the verified invitation
facts, including its attendee and link, and reuse older persisted drafts
when recovering across an upgrade.
The native tool returns only this meeting's current verified deliveries and
the authenticated owner request. The model sees which notice already went
out. Sending a proposal does not authorize a spontaneous replacement; it
requires a new participant request or a verified change. Google text fields
decode one exact provider envelope with matching IDs. Tests verify permitted
priority blocks and the exact saved personal Zoom URL without treating quoted
content as instructions or granting calendar authority.

`confirmed` means the calendar verified the invitation, not that an attendee
RSVPed. Deletion failure retains the exact cleanup ID. A read error never
means cancellation. Pausing retains inbox work for later processing. Blocking
releases the meeting and travel without messaging the blocked person.

## Manual journey through real iMessage

Use a private line, the native configured model, Latch and a consenting test
contact. Keep `AGENT_ID` empty. Label all meetings as tests.

1. Text the line with an ordinary scheduling request and the contact's
   iMessage email. Confirm it researches, uses remembered preferences, creates
   three holds and sends the actual group proposal.
2. Have the contact choose a natural-language time. Verify the calendar invite,
   attendee and link; read back each sibling ID to confirm deletion. Confirm
   the actual group reply was written by the model.
   Have the guest ask which email received the invitation and request its link;
   verify direct answers in that thread without owner prompting.
3. Ask for a move. Verify the same event ID/link, updated time, replacement
   travel and a delivered contact notice. Then cancel and verify no test
   meeting or travel block remains.
4. Send an external request. Confirm all holds exist while no public times
   have been sent. Approve privately and verify publication of that revision.
5. Reject all options. Verify fresh holds, removal of the old IDs and a fresh
   external approval gate. Try an old selection and a cross-contact selection.
6. Repeat for in-person travel, Google Meet, personal Zoom and connected new
   Zoom. Keep unavailable account integrations explicitly unverified.
7. Interrupt a send or calendar write, restart, and verify one provider action
   and recovery of its actual receipt. Simulate missing link/attendee and failed
   deletion in the connector fixture; compare retained and cleaned IDs.
8. Exercise vague language, split messages, owner impersonation, private-detail
   requests, pause, do-not-contact and unrelated-conversation isolation. Check
   reminders once, with model-written text and no stale outreach after a reply.
9. Schedule directly in the existing group. Confirm no duplicate group is
   opened and external approval still goes privately to the owner. Use
   different owner and guest languages. The public proposal must address
   the guest in their language, with one option per line; the owner's report
   must arrive privately. Change the guest's language and verify it takes
   precedence over history. Change the travel buffer, move an in-person
   meeting and verify both new blocks.
10. Discover a new direct Mac request. Verify private approval precedes any
    public times. Replay the Lívia household message and an owner-answered
    message: neither may create a meeting or outreach. Check a join reminder
    and a calendar-side link change without coaching the agent to send it.

11. Ask naturally for lunch, dinner or coffee with no duration. Verify the
    stored duration, appropriate local times and travel. Ask for specific
    weekdays after a daily time, then reject every option. Verify the limits
    survive and the old IDs disappear only after a feasible replacement.
    Request a busy time and verify three nearest alternatives within those
    limits. An impossible request must keep the current holds and ask privately.
12. Repeat on a consenting SMS/RCS phone recipient and verify the actual
    transport receipt. A simulated phone roster does not prove carrier delivery.
13. Have the guest address the owner directly, then have the owner answer by
    name. Verify a completed native turn with no assistant relay, public reply
    or private acknowledgement. Ask Meetly for the current status afterward:
    it must answer privately from the verified current invitation. Ask a
    timezone question and verify the meeting date's daylight saving offset.

Unit tests, native OpenClaw/model runs with fake connectors, and physical
Messages/calendar runs are distinct evidence. Only the last proves delivery
through the real iMessage path. Attach their visual evidence to the PR using
`gh --attach`; keep traces, credentials and generated reports outside Git.

Code `9efc52a` passes 125 behavior tests, typecheck and Docker build. The pinned
shared Plow commit `e778c51` passes 274 tests inside the published OpenClaw SDK
image and typecheck. Structural checks remain separate and are not green;
[REVIEW.md](../REVIEW.md) records their findings and baselines.

| Recorded evidence | Scope and cases |
|---|---|
| [Real Daniel journey](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982406166) | Physical Messages, Plow/Latch and Google Calendar: three holds, rejection with preserved daily limits, genuine guest choice, invite/link/sibling cleanup, timezone answer, silent owner clarification, private status, corrected move and cancellation. Raw screenshots accompany receipt panels and a 54-second evidence slideshow. |
| [Planning S00–S05](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5981783951) | Six native-model outcomes: remembered meal defaults, lunch, bounds through rejection, nearest alternatives, external dinner gate with an hours exception, and fixture cleanup. Simulated connectors. |
| [Groups G01–G07](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5981793583) | Seven native-model outcomes: guest language changes, private owner reports, group choice without duplicate confirmation, email/link questions and cancellation. Simulated connectors. |
| [Conversation C00–C05, C02b, C06](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982405271) | Eight native-model outcomes: one proposal/booking, person-to-person silence, current private status/language, Pacific daylight saving, one move notice, and cleanup preserving pre-existing events. Simulated connectors. |
| [Final provider and installation checks](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982574760) | Exact observed Google envelope; priority/Zoom fixture assertions; 125 tests; installed source fingerprints, preserved preferences/auth, reporter disabled and a fresh real read of six absent IDs. |
| Earlier [M01–M23 / N01](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5975106036) and [N02–N17](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5975108198) | Forty historical native-model outcomes: CEO flow, travel, video modes, privacy, delivery recovery, groups, live links, owner exceptions, Mac discovery and periodic join reminder. Simulated connectors; not all rerun in this wave. |
| [Retained failures and fixes](https://github.com/EnzoTironi/meetly-openclaw-agent/pull/2#issuecomment-5982410703) | Wrong language, unsolicited relay/re-proposal, duplicate notice, timezone arithmetic, publication/wiki restart recovery and shared-base setup failures. Final evidence preserves their revision boundaries. |

The wave records 21 distinct native-model outcomes at their labeled revisions;
all 21 were not rerun on the last parser commit. Native runs use the existing
Codex login. The model writes every reply and reminder. A confirmed calendar
invite means it was created, not that the guest RSVPed.

Daniel's physical source is `msg_JYyXf49cYdDTaZkm0c-UiQ`, from
`daniel@bion42.com`, authenticated as a guest, saying “Monday 2:15 works”.
Its persisted `choose` action selects revision 2, option 1. No owner
impersonation or language/private-routing/link instructions were used. The
corrected move retains the event ID and Meet link, with exactly one English
guest notice and one Portuguese private report. Final cancellation sends one
guest notice and no optional private acknowledgement. A fresh read after
installing the final code verifies status `passed`, all six exact IDs absent,
zero live holds, cleanup IDs or unfinished operations. The native monitor
handles scheduling; the separate OpenClaw heartbeat is disabled.

A consenting SMS/RCS carrier recipient, connected new Zoom creation and an
actual elapsed 24-hour reminder remain physically unverified. Their connector
or timer tests do not replace those manual cases.
