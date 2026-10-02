import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const group = readFileSync(join(import.meta.dirname, "..", "skills", "meetly-group", "SKILL.md"), "utf8").replace(/\s+/g, " ");

test("a new offer for a person with an open group is sent there, by the route that reaches it from where the owner asked", () => {
  assert.ok(group.includes("An open request that already has a `chatUid`: post the new times there."));
  assert.ok(group.includes("From the owner's main DM use `plow_reply_to` with that `chatUid` and the new times"));
  assert.ok(group.includes("in the poll use `message` with that chat uid as its target"));
  assert.ok(group.includes("in the group itself reply normally"));
});

test("an update is reported as sent only when the send went through, and a failed send names its blocker", () => {
  assert.ok(group.includes("Say the new times were sent only after that send succeeded"));
  assert.ok(group.includes("If it fails, tell the owner the specific error in one line and that the holds and the saved offer are kept"));
  assert.ok(group.includes("never say the request was updated or sent"));
  assert.ok(group.includes("the new times sent to that group"));
});
