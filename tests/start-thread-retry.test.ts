import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startThread } from "../skills/meetly/scripts/start-thread.ts";

const identity = {
  line: { uid: "line_me" },
  chats: [{
    uid: "dm", status: "active",
    participants: [
      { type: "agent", relationship: "self", line: { uid: "line_me" } },
      { type: "member", role: "owner", provider_key: "+5511999990000" },
    ],
  }],
};
const base = "https://api.plow.test/";
const args = { members: ["+15551234567"], body: "Hi Ana, this is Meetly.", key: "rowid:42", retryDelayMs: 0, base, token: "t" };

// Answers the identity lookup, then each POST /v1/chats from the list in order, recording the idempotency keys.
function plow(posts: (() => Response)[], keys: string[] = []): typeof fetch {
  let n = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/v1/agents/me")) return new Response(JSON.stringify(identity));
    keys.push(JSON.parse(String(init?.body)).idempotency_key);
    const next = posts[Math.min(n++, posts.length - 1)]!;
    return next();
  }) as typeof fetch;
}
const lost = () => { throw new TypeError("fetch failed"); };
const ok = () => new Response('{"uid":"chat_9"}', { status: 201 });

test("an unknown delivery is tried once more with the same key, which finds the group that was opened", async () => {
  for (const first of [lost, () => new Response("", { status: 502 }), () => new Response("", { status: 408 })]) {
    const keys: string[] = [];
    assert.deepEqual(await startThread({ ...args, fetch: plow([first, ok], keys) }), { chatUid: "chat_9", messageSent: true });
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  }
});

test("a group that is confirmed the first time is posted once", async () => {
  const keys: string[] = [];
  assert.deepEqual(await startThread({ ...args, fetch: plow([ok], keys) }), { chatUid: "chat_9", messageSent: true });
  assert.equal(keys.length, 1);
});

test("still unknown after the retry stays unknown, even if the retry is answered with a refusal", async () => {
  for (const second of [lost, () => new Response("", { status: 502 }), () => new Response('{"error":"duplicate"}', { status: 409 })]) {
    const keys: string[] = [];
    assert.deepEqual(await startThread({ ...args, fetch: plow([lost, second], keys) }), { chatUid: null, deliveryUnknown: true });
    assert.equal(keys.length, 2);
  }
});

test("a request Plow refuses is not retried", async () => {
  const keys: string[] = [];
  await assert.rejects(startThread({ ...args, fetch: plow([() => new Response('{"error":"nope"}', { status: 422 })], keys) }), /HTTP 422/);
  assert.equal(keys.length, 1);
});

test("an unconfirmed group is explained to the owner in plain words, and a later retry reuses the key to find it", () => {
  const group = readFileSync(join(import.meta.dirname, "..", "skills", "meetly-group", "SKILL.md"), "utf8").replace(/\s+/g, " ");
  assert.ok(group.includes("`start-thread.ts` already tries twice with the same key"));
  assert.ok(group.includes("Plow did not confirm it"));
  assert.ok(group.includes("the holds are kept and the request is saved"));
  assert.ok(group.includes("run the same `start-thread.ts` command again with the same `--key` and `--body`"));
  assert.ok(group.includes("never quote a status code or say you cannot confirm anything else"));
});
