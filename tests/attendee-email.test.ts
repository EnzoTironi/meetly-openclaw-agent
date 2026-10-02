import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const group = readFileSync(join(import.meta.dirname, "..", "skills", "meetly-group", "SKILL.md"), "utf8").replace(/\s+/g, " ");

test("the owner hears at the offer that a contact with only a phone gets no calendar invitation until they give an email", () => {
  assert.ok(group.includes("If the contact has a phone but no email, say so in your reply to the owner"));
  assert.ok(group.includes("the calendar invitation needs one, and without it the confirmation goes to the group only"));
});

test("the opener asks the person for an email only when none can be found, and only for a Meet", () => {
  assert.ok(group.includes("When the format is `meet` and neither a contact card nor the thread gives the person's email, the same opener also asks for it, for the calendar invitation"));
  assert.ok(group.includes("Search contacts and the thread first; never ask for what you can find"));
});

test("a booking attaches the person's email, and says apart what is on the calendar, what was confirmed and what was invited", () => {
  assert.ok(group.includes("Add the person's email, from contacts or the one they gave, as an attendee on every booking"));
  assert.ok(group.includes("state three things apart: the event is on the owner's calendar, this message is the confirmation, and the calendar invitation either went to that email or was not sent because there is no email"));
  assert.ok(group.includes("when there is none, ask for it once"));
  assert.ok(group.includes("An invitation that is pending is not an acceptance: never say the person accepted"));
});

test("an email given after booking is added to the event, and the invitation is reported as sent, not accepted", () => {
  assert.ok(group.includes("When the person gives their email after the booking, add it as an attendee with `plow-gog calendar update primary <eventId> --account <booked.account>` and `--send-updates all`"));
  assert.ok(group.includes("say the invitation was sent"));
});
