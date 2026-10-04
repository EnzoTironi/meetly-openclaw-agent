import assert from "node:assert/strict";
import { test } from "node:test";
import { calendar, eventRef, source } from "../src/model.ts";
import { parseEvent, parseListing, Providers, type NativeChannel } from "../src/providers.ts";

const cal = calendar.parse({ account: "sam@example.test", id: "primary" });
const range = { from: "2026-10-05T08:00:00Z", to: "2026-10-16T20:00:00Z" };
const raw = { id: "event", status: "confirmed", start: { dateTime: "2026-10-05T09:00:00Z" }, end: { dateTime: "2026-10-05T09:30:00Z" }, summary: "Project review", attendees: [{ email: "taylor@example.test", responseStatus: "needsAction" }] };
const self = { type: "agent", relationship: "self", line: { uid: "line", provider_key: "+15550000999" } };
const owner = { type: "member", uid: "owner", role: "owner", provider_key: "+15550000001" };
const guest = { type: "member", uid: "guest", role: "member", provider_key: "taylor@example.test" };
const group = { uid: "group", status: "active", trusted: false, participants: [self, owner, guest] };
const home = { ...group, uid: "owner", participants: [self, owner] };
const incoming = { uid: "incoming", body: "Option 2 works.", direction: "inbound", sender: guest, created_at: "2026-10-05T08:00:00Z" };
const outgoing = { ...incoming, uid: "sent", direction: "outbound", sender: self, body: "Sam could do Tuesday." };
const native: NativeChannel = { send: async () => ({ messageId: "sent" }), start: async () => ({ chat_uid: "group", message_sent: true }) };
const env = { PLOW_API_BASE: "http://fixture", PLOW_AGENT_TOKEN: "fixture-token" };
const provider = (fetcher: typeof fetch, mac: (argv: string[], paths?: string[]) => Promise<string> = async () => assert.fail("unexpected Mac command")) => new Providers(native, () => "UTC", env, fetcher, mac);
const api = (messages = [incoming, outgoing]): typeof fetch => async input => {
  const url = String(input);
  if (url.endsWith("/agents/me")) return Response.json({ line: self.line, chats: [home, group] });
  if (url.includes("/messages?")) return Response.json({ data: messages, has_more: false });
  return Response.json(url.endsWith("/owner") ? home : group);
};

test("a served group derives exactly one guest from the roster and rejects mixed-contact groups", async () => {
  assert.equal((await provider(api()).groupContact("group")).handle, guest.provider_key);
  await assert.rejects(provider(api()).groupContact("owner"), /single verified/);
  const extra = { ...guest, uid: "other", provider_key: "other@example.test" };
  await assert.rejects(provider(async input => String(input).endsWith("/agents/me") ? api()(input) : Response.json({ ...group, participants: [...group.participants, extra] })).groupContact("group"), /single verified/);
});

test("lossless calendar reads preserve the native managed Zoom URL, including its password", () => {
  const zoom = "https://zoom.us/j/123456789?pwd=exact_password";
  const value = parseEvent({ event: { ...raw, description: `<!-- gog-zoom-meeting:123456789 -->\nJoin Zoom Meeting: ${zoom}\n<!-- /gog-zoom-meeting -->` } }, cal, "UTC");
  assert.equal(value?.conference, zoom);
  assert.deepEqual(value?.attendees, ["taylor@example.test"]);
  assert.throws(() => parseEvent({ ...raw, hangoutLink: "https://meet.google.com/abc-defg-hij", description: `<!-- gog-zoom-meeting:123456789 -->\nJoin Zoom Meeting: ${zoom}` }, cal, "UTC"), /conflicting/);
});
test("all-day calendar blocks use local midnight across daylight-saving changes", () => {
  const [value] = parseListing({ events: [{ ...raw, start: { date: "2026-03-08" }, end: { date: "2026-03-09" } }] }, cal, "America/New_York");
  assert.equal(value?.start, "2026-03-08T05:00:00.000Z");
  assert.equal(value?.end, "2026-03-09T04:00:00.000Z");
});
test("movable ownership uses the creator address or the compact provider proof, never Google's self flags", () => {
  for (const [metadata, expected] of [
    [{ creator: { email: "SAM@EXAMPLE.TEST" } }, true],
    [{ createdByOwner: true }, true],
    [{ creator: { email: "collaborator@example.test", self: true }, organizer: { self: true } }, false],
    [{ creator: { self: true }, organizer: { self: true } }, false],
    [{}, false],
  ] as const) assert.equal(parseEvent({ ...raw, ...metadata }, cal, "UTC")?.createdByOwner, expected);
});
for (const extra of [{ nextPageToken: "more" }, { has_more: true }, { degraded: ["unavailable"] }, { truncated: true }]) test("an incomplete calendar never becomes free time: " + JSON.stringify(extra), () => {
  assert.throws(() => parseListing({ events: [], ...extra }, cal, "UTC"), /incomplete/);
});
test("cancelled, declined and transparent events remain distinguishable, and invalid times fail closed", () => {
  const values = parseListing({ events: [{ id: "cancelled", status: "cancelled" }, { ...raw, transparency: "transparent", attendees: [{ email: cal.account, self: true, responseStatus: "declined" }] }] }, cal, "UTC");
  assert.equal(values.length, 1); assert.equal(values[0]?.transparent, true); assert.equal(values[0]?.declined, true);
  assert.throws(() => parseListing([{ ...raw, start: { dateTime: "2026-10-05T09:00:00" } }], cal, "UTC"));
  assert.throws(() => parseListing([{ ...raw, end: raw.start }], cal, "UTC"));
});
test("a wrong calendar event ID, including a cancelled one, cannot confirm deletion", async () => {
  const p = provider(api(), async () => JSON.stringify({ id: "other", status: "cancelled" }));
  await assert.rejects(p.read(eventRef.parse({ calendar: cal, id: "event" })), /different event/);
});
test("a confirmed event 404 means absence; a failed or unauthorized calendar read does not", async () => {
  const ref = eventRef.parse({ calendar: cal, id: "event" });
  assert.equal(await provider(api(), async () => { throw new Error("HTTP 404 event not found"); }).read(ref), null);
  for (const error of ["HTTP 401 expired login", "HTTP 403 forbidden", "network offline"]) {
    await assert.rejects(provider(api(), async () => { throw new Error(error); }).read(ref));
  }
});
test("native writes preserve argv boundaries and verify the raw read instead of redacted output", async () => {
  const calls: string[][] = [];
  const p = provider(api(), async argv => {
    calls.push(argv);
    if (argv[2] === "update") return JSON.stringify({ ...raw, description: "redacted output" });
    return JSON.stringify({ ...raw, description: "<!-- gog-zoom-meeting:123456789 -->\nJoin Zoom Meeting: https://zoom.us/j/123456789?pwd=exact_password" });
  });
  const value = await p.update({ calendar: cal, id: "event" }, { calendar: cal, start: range.from, end: "2026-10-05T08:30:00Z", title: "$(must stay literal) ' review", location: "", attendees: ["taylor@example.test"], conference: "zoom", marker: "operation" });
  assert.equal(value.conference, "https://zoom.us/j/123456789?pwd=exact_password");
  assert.ok(calls[0]?.includes("$(must stay literal) ' review"));
  assert.ok(calls[0]?.includes("--with-zoom")); assert.ok(calls[0]?.includes("--include-passwords"));
  assert.deepEqual(calls[1]?.slice(0, 5), ["plow-gog", "calendar", "raw", cal.id, "event"]);
});
test("calendar listing requests every page on each configured calendar", async () => {
  const calls: string[][] = [];
  const p = provider(api(), async argv => { calls.push(argv); return JSON.stringify({ events: [] }); });
  await p.list([cal, { ...cal, id: "second" }], range);
  assert.equal(calls.length, 2); assert.ok(calls.every(argv => argv.includes("--all-pages") && argv.includes("2500")));
});
test("roster roles determine owner authority even when the incoming payload claims to be owner", async () => {
  const p = provider(api([{ ...incoming, sender: { ...guest, role: "owner" } }, outgoing]));
  const verified = await p.message("group", "incoming");
  assert.equal(verified.owner, false); assert.equal(verified.handle, guest.provider_key);
  await assert.rejects(provider(async input => String(input).includes("/agents/me") ? Response.json({ line: { uid: "other-line" } }) : Response.json(group)).message("group", "incoming"), /not served/);
});
test("only the exact outbound self-line message confirms a native send", async () => {
  assert.equal((await provider(api()).send("group", outgoing.body)).messageId, "sent");
  await assert.rejects(provider(api([{ ...outgoing, direction: "inbound" }])).send("group", outgoing.body), /not confirmed/);
  await assert.rejects(provider(api([{ ...outgoing, body: "different text" }])).send("group", outgoing.body), /not confirmed/);
  await assert.rejects(provider(api([{ ...outgoing, sender: { ...self, line: { ...self.line, uid: "other" } } }])).send("group", outgoing.body), /not confirmed/);
});
test("send recovery respects time, uniqueness and paginated inbox receipts", async () => {
  const p = provider(api());
  assert.equal(await p.recoverSend("group", outgoing.body, "2026-10-05T08:01:00Z"), null);
  await assert.rejects(provider(api([outgoing, { ...outgoing, uid: "duplicate" }])).recoverSend("group", outgoing.body, outgoing.created_at), /multiple/);
  const paginated: typeof fetch = async input => {
    const url = String(input);
    if (!url.includes("/messages?")) return api()(input);
    return Response.json(url.includes("starting_after") ? { data: [incoming], has_more: false } : { data: [outgoing], has_more: true });
  };
  assert.equal((await provider(paginated).message("group", incoming.uid)).text, incoming.body);
  const repeated: typeof fetch = async input => String(input).includes("/messages?") ? Response.json({ data: [incoming], has_more: true }) : api()(input);
  await assert.rejects(provider(repeated).message("group", "absent"), /repeated page/);
});
test("a supplied iMessage email is researched directly without requiring a Contacts card", async () => {
  const calls: string[][] = [];
  const p = provider(api(), async argv => { calls.push(argv); return argv[0] === "plow-messages" ? "" : JSON.stringify({ messages: [] }); });
  await p.research("new@example.test");
  assert.deepEqual(calls[0], ["plow-messages", "search", "--handle", "new@example.test", "--order", "desc", "--limit", "30"]);
  assert.ok(calls.every(argv => !argv.includes("contacts")));
});
test("contact research ignores other phone lines and inactive chats instead of rejecting its own served group", async () => {
  const reads: string[] = [];
  const foreign = { ...group, uid: "other-agent-group", participants: [{ ...self, line: { uid: "another-line" } }, owner, guest] };
  const inactive = { ...group, uid: "inactive-group", status: "closed" };
  const fetcher: typeof fetch = async input => {
    const url = String(input); reads.push(url);
    if (url.endsWith("/agents/me")) return Response.json({ line: self.line, chats: [home, foreign, inactive, group] });
    assert.ok(!url.includes(foreign.uid) && !url.includes(inactive.uid));
    return api()(input);
  };
  const p = provider(fetcher, async argv => argv[0] === "plow-messages" ? "" : JSON.stringify({ messages: [] }));
  const result = await p.research("Taylor@EXAMPLE.test") as { plow: { thread: string }[] };
  assert.deepEqual(result.plow.map(value => value.thread), ["group"]);
  assert.ok(reads.some(url => url.includes("/chats/group/messages?")));
});
test("research reads complete email bodies and earlier calendar meetings using the owner's selected account", async () => {
  const calls: string[][] = [];
  const p = provider(api(), async argv => {
    calls.push(argv);
    if (argv[0] === "plow-messages") return "";
    return JSON.stringify(argv[1] === "gmail" ? { messages: [{ body: "The earlier invitation included the venue and 45-minute duration." }] } : { events: [raw] });
  });
  const result = await p.research(guest.provider_key, cal) as { mail: { messages: { body: string }[] }; priorMeetings: { events: unknown[] } };
  assert.ok(result.mail.messages[0]?.body.includes("venue"));
  assert.deepEqual(result.priorMeetings.events, [raw]);
  assert.ok(calls.some(argv => argv.includes("--include-body") && argv.includes(cal.account)));
  assert.ok(calls.some(argv => argv[1] === "calendar" && argv[2] === "search" && argv.includes(cal.id) && argv.includes("--from")));
});
test("unknown group creation recovers only one exact outbound receipt in the authenticated contact's served group", async () => {
  assert.equal((await provider(api()).recoverThread(guest.provider_key, outgoing.body, outgoing.created_at))?.thread, "group");
  assert.equal(await provider(api()).recoverThread("unrelated@example.test", outgoing.body, outgoing.created_at), null);
  const duplicate: typeof fetch = async input => String(input).endsWith("/agents/me")
    ? Response.json({ line: self.line, chats: [home, group, { ...group, uid: "second-group" }] }) : api()(input);
  await assert.rejects(provider(duplicate).recoverThread(guest.provider_key, outgoing.body, outgoing.created_at), /More than one group/);
});

test("native iMessage Markdown escapes confirm the same displayed message while proposed retains the actual inbox body", async () => {
  const expected = "Options:\n1. Monday at 9:00\n2. Tuesday at 9:00\n3. Wednesday at 9:00\nTopic: Research & development | project review";
  const actual = expected.replace(/[.!&|:]/g, "\\\\$&");
  const p = provider(api([{ ...outgoing, body: actual }]));
  assert.equal((await p.send("group", expected)).text, actual);
  assert.equal((await p.recoverSend("group", expected, outgoing.created_at))?.text, actual);
  assert.equal(await provider(api([{ ...outgoing, body: actual.replace("Monday at 9", "Monday at 10") }])).recoverSend("group", expected, outgoing.created_at), null);
});
