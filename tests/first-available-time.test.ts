import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const group = readFileSync(join(import.meta.dirname, "..", "skills", "meetly-group", "SKILL.md"), "utf8").replace(/\s+/g, " ");

test("the owner is told the rule before it is used: say book it and the first option is taken, or name one", () => {
  assert.ok(group.includes("end it with the rule, in the owner's language: say \"book it\" and Meetly takes the first option, or name another"));
});

test("a booking the owner authorizes without naming a time takes the first offered time, and says so", () => {
  assert.ok(group.includes("When the owner tells you to book or schedule it without naming a time, and more than one offered time is open, book the first offered time"));
  assert.ok(group.includes("say in the confirmation that it is the first option because no time was named"));
  // A time the guest already picked, or the owner names, is never overridden by the rule.
  assert.ok(group.includes("A time the other person already picked, or the owner names, is the time"));
});

test("the same holds when the owner says it in their DM about a person with an open offer", () => {
  assert.ok(group.includes("When the owner's message only tells you to book or schedule a request that is already open, with no time, do not offer again"));
  assert.ok(group.includes("book the first offered time as in \"The owner writes in the group\" and confirm in that group"));
});
