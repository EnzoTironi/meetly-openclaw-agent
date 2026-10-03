# Scheduling contract and acceptance

The LLM researches context, interprets requests and dates, and writes all
outgoing prose. The native workflow verifies side effects and remembers
receipts. Owner authority comes from Plow's authenticated roster and inbox,
never from a name or a claim inside a message.

## CEO specification

| Requirement | Implementation and regression evidence |
|---|---|
| Owner or external request | `inbound.ts` interprets incoming messages on the agent's served Plow threads; the native owner tool uses the verified private conversation. Mac texts are research only. Workflow tests cover both origins and implicit meeting language. |
| Research before proposing | `research` reads texts, full email bodies, earlier calendar meetings, served Plow threads and contact wiki. Missing context goes privately to the owner. A supplied iMessage email bypasses Contacts lookup. |
| Three held slots | `availability.ts` checks all configured calendars, timezone, working hours and notice. Workflow tests verify three calendar holds, or nine events with in-person travel. |
| External owner gate | Only private approval of the current revision permits publication. Tests reject guest approval, premature publication and carried approval after re-proposal. |
| Invite, link, cleanup | `invitation.ts` verifies time, every attendee and the saved provider link. Tests retain siblings on a missing link/attendee/tentative invite and delete them only after recovery. |
| Monitor every X minutes | Native service uses `monitorMin`. Tests cover expiry, pending writes, replies, owner/contact reminders, unavailable providers and pause. |
| Re-propose | Reject-all replaces the old holds and excludes their starts. Old revisions cannot book. External replacements need fresh approval. |
| Priorities | Only owner-listed exact titles on the write calendar may move, with verified owner creation and without attendees or conferences. Creator email must match the queried account, or the provider must supply its compact ownership proof; `self` flags are insufficient. Tests preserve collaborator/unproven blocks and hard appointments, and exclude private titles from outgoing context. |
| One contact wiki | `records.ts` retains a stable contact page with exact IDs, sent receipts, advisory `next_step` and dated prose. Tests cover renamed contacts and interrupted page writes. |
| Remember preferences | Owner-confirmed provider, room mode, durations, travel and explicit link steps are stored under `entities/owner`. Tests cover all three video modes, zero travel and link preservation on move. |
| Write as assistant | Model instructions require third-person owner wording. Validate the actual model's outgoing text in the integration and iMessage runs. |
| Natural guest conversation | The LLM answers ordinary questions in the guest's thread from verified attendees and links. Owner-gated requests get a model-written acknowledgement. Booking and move notices include the link automatically. |
| Find answers first / private clarification | Context research precedes missing-detail questions. Fixtures cover an email-only contact, missing provider and the origin of private owner questions. |
| Reveal no personal reasons | Guest context contains its meeting and sent options, not busy-event titles, other contacts or credentials. Adversarial model tests exercise owner impersonation and private calendar requests. |

## Failure and boundary cases

The behavior tests exercise unknown create/send responses, restart recovery,
partial hold failure, delayed receipt recovery after expiry, incomplete or
unreadable calendars, all-day daylight-saving boundaries, duplicate inbound
delivery, competing choices, cross-contact choices, repurposed holds,
blocked contacts, and calendar-side moves/cancellations.
Reused contact groups select the newest sent proposal. Research excludes
other phone lines and closed chats. Native Code Mode may orchestrate the
scheduling tool while raw calendar, message and file writes stay guarded.
Unrelated Mac conversations cannot enter the scheduling inbox. Tests verify
that previously queued archive rows and tasks cause no model calls or sends.
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
retry. Inbox verification tolerates transport Markdown escaping while
storing the exact returned body.

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

Unit tests, native OpenClaw/model runs with fake connectors, and physical
Messages/calendar runs are distinct evidence. Only the last proves delivery
through the real iMessage path. Attach their visual evidence to the PR using
`gh --attach`; keep traces, credentials and generated reports outside Git.
