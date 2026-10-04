import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { command, event, liveHolds, meeting, preferences, refKey, source, type Actor, type Delivery, type Event, type EventRef, type Meeting, type Range, type Source } from "../src/model.ts";
import { Records, RejectedEffect } from "../src/records.ts";
import { Scheduling, type Compose } from "../src/scheduling.ts";
import type { Ports, WriteEvent } from "../src/providers.ts";
import { Inbound } from "../src/inbound.ts";
import { plan, wall, windows } from "../src/availability.ts";

const now = Date.parse("2026-10-05T08:00:00Z");
const ownerSource = source.parse({ channel: "plow", thread: "owner", messageId: "owner-request", at: new Date(now).toISOString(), handle: "+15550000001", owner: true, text: "Schedule a project review with Taylor." });
const guestSource = source.parse({ ...ownerSource, thread: "group", messageId: "guest-request", handle: "taylor@example.test", owner: false, text: "Could we meet for a project review?" });
const owner: Actor = { kind: "owner", source: ownerSource, mainDm: true, hostContext: { sessionKey: "agent:main:main" } };
const guest: Actor = { kind: "guest", source: guestSource };
const range: Range = { from: "2026-10-05T08:00:00Z", to: "2026-10-16T20:00:00Z" };
const prefs = preferences.parse({ ownerName: "Sam", timezone: "UTC", calendar: { account: "sam@example.test", id: "primary" }, busyCalendars: [{ account: "sam@example.test", id: "primary" }], video: { kind: "google_meet" }, noticeMin: 0 });
const prepare = { action: "prepare", contact: { name: "Taylor", handle: "taylor@example.test" }, details: { topic: "Project review", kind: "video", attendees: ["taylor@example.test"] }, range };
const compose: Compose = async context => {
  const facts = typeof context === "object" && context !== null && "facts" in context ? context.facts : context;
  return typeof facts === "string" ? facts : JSON.stringify(facts);
};

class CalendarFixture implements Ports {
  events = new Map<string, Event>();
  messages: Delivery[] = [];
  calls: { operation: string; input: unknown }[] = [];
  failedDeletes = new Set<string>();
  missingAttendee = false;
  missingLink = false;
  tentative = false;
  failCreate = 0;
  loseCreate = 0;
  loseSend = false;
  incomplete = false;
  async list(): Promise<Event[]> { if (this.incomplete) throw new Error("incomplete calendar"); return [...this.events.values()]; }
  async read(ref: EventRef): Promise<Event | null> { return this.events.get(refKey(ref)) ?? null; }
  make(input: WriteEvent, ref: EventRef): Event {
    const previous = this.events.get(refKey(ref));
    return event.parse({ ref, status: this.tentative ? "tentative" : "confirmed", start: input.start, end: input.end,
      title: input.title, location: input.conference === "zoom" ? "https://zoom.us/j/123456789?pwd=fixture" : input.location,
      attendees: this.missingAttendee ? [] : input.attendees,
      conference: this.missingLink ? "" : input.conference === "meet" ? "https://meet.google.com/abc-defg-hij" : input.conference === "zoom" ? "https://zoom.us/j/123456789?pwd=fixture" : previous?.conference ?? "",
      transparent: false, declined: false, marker: input.marker, createdByOwner: previous?.createdByOwner ?? true });
  }
  async create(input: WriteEvent): Promise<Event> {
    this.calls.push({ operation: "create", input });
    const count = this.calls.filter(value => value.operation === "create").length;
    if (this.failCreate === count) throw new RejectedEffect("calendar rejected hold");
    const created = this.make(input, { calendar: input.calendar, id: `event-${count}` });
    this.events.set(refKey(created.ref), created);
    if (this.loseCreate === count) throw new Error("connection lost after creating hold");
    return created;
  }
  async recoverCreate(input: WriteEvent): Promise<Event | null> { return [...this.events.values()].find(value => value.marker === input.marker) ?? null; }
  async update(ref: EventRef, input: WriteEvent): Promise<Event> {
    this.calls.push({ operation: "update", input });
    const updated = this.make(input, ref); this.events.set(refKey(ref), updated); return updated;
  }
  async remove(ref: EventRef): Promise<EventRef> {
    this.calls.push({ operation: "delete", input: ref });
    if (this.failedDeletes.has(ref.id)) throw new Error("temporary deletion failure");
    this.events.delete(refKey(ref)); return ref;
  }
  async send(thread: string, text: string): Promise<Delivery> {
    this.calls.push({ operation: "send", input: { thread, text } });
    const receipt = { thread, text, messageId: `message-${this.messages.length + 1}`, at: new Date(now).toISOString() };
    this.messages.push(receipt);
    if (this.loseSend) throw new Error("message delivery unknown");
    return receipt;
  }
  async openThread(_actor: Actor, key: string, _member: string, text: string): Promise<Delivery> {
    this.calls.push({ operation: "thread", input: key });
    return await this.recoverSend("group", text) ?? this.send("group", text);
  }
  async recoverSend(thread: string, text: string): Promise<Delivery | null> { return this.messages.find(value => value.thread === thread && value.text === text) ?? null; }
  async recoverThread(_member: string, text: string): Promise<Delivery | null> { return this.recoverSend("group", text); }
  async ownerThread(): Promise<string> { return "owner"; }
  async groupContact(): Promise<{ name: string; handle: string }> { return prepare.contact; }
  async message(): Promise<Source> { return guestSource; }
  async replies(): Promise<Source[]> { return []; }
  async research(): Promise<unknown> { return { texts: [], mail: [] }; }
  async discover(): Promise<unknown> { return {}; }
  async archive(): Promise<{ rowid: number; source: Source | null }[]> { return []; }
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "meetly-native-"));
  const records = new Records(root), ports = new CalendarFixture();
  records.remember(prefs, ownerSource);
  let clock = now;
  const app = new Scheduling(records, ports, compose, () => clock);
  t.after(() => { if (records.db.isOpen) records.close(); rmSync(root, { recursive: true }); });
  const held = async (external = false, format = "video") => meeting.parse(await app.run({ ...prepare,
    ...(external ? { source: { thread: "group", messageId: guestSource.messageId } } : {}),
    details: format === "in_person" ? { ...prepare.details, kind: format, location: "Fixture office" } : prepare.details }, owner));
  const sent = async (external = false, format = "video") => {
    const value = await held(external, format); assert.equal(value.status, "held");
    return meeting.parse(await app.run({ action: external ? "approve" : "publish", meetingId: value.id, revision: 1 }, owner));
  };
  const choose = async (value: Meeting, option = 1) => meeting.parse(await app.run({ action: "choose", meetingId: value.id, revision: 1, option }, guest));
  return { root, records, ports, app, held, sent, choose, advance: (ms: number) => { clock += ms; } };
}

for (const meal of ["lunch", "dinner", "coffee"] as const) test(`${meal} uses its remembered duration and sensible local times with verified holds`, async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, hours: { ...prefs.hours, to: "22:00" }, travelMin: 30 }), ownerSource);
  const held = meeting.parse(await f.app.run({ ...prepare, details: { ...prepare.details, kind: "in_person", location: "Guest's office", meal } }, owner));
  assert.equal(held.status, "held"); if (held.status !== "held") return;
  const start = meal === "lunch" ? "11:30" : meal === "dinner" ? "18:00" : "09:30";
  assert.deepEqual(held.proposal.slots.map(value => value.start), [5, 6, 7].map(date => `2026-10-0${date}T${start}:00.000Z`));
  assert.equal(held.details.durationMin, meal === "coffee" ? 30 : 60);
  assert.equal(f.ports.events.size, 9);
  const sent = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  const booked = await f.choose(sent); assert.equal(booked.status, "confirmed");
  assert.equal(f.ports.events.size, 3); assert.equal(booked.cleanup.length, 0);
});
test("explicit meal duration and daily hours win over defaults, while saved meal duration is reused", async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, durations: { ...prefs.durations, lunch: 45 } }), ownerSource);
  const details = { ...prepare.details, meal: "lunch" };
  const first = meeting.parse(await f.app.run({ ...prepare, details }, owner));
  assert.equal(first.status, "held"); if (first.status !== "held") return;
  assert.equal(first.details.durationMin, 45);
  await f.app.run({ action: "cancel", meetingId: first.id }, owner);
  const actor: Actor = { ...owner, source: source.parse({ ...ownerSource, messageId: "late-lunch", text: "A 20-minute lunch, after 2." }) };
  const second = meeting.parse(await f.app.run({ ...prepare, details: { ...details, durationMin: 20 }, range: { ...range, after: "14:00" } }, actor));
  assert.equal(second.status, "held"); if (second.status !== "held") return;
  assert.equal(second.details.durationMin, 20);
  assert.deepEqual(second.proposal.slots.map(value => value.start), [5, 6, 7].map(date => `2026-10-0${date}T14:00:00.000Z`));
});
test("dinner outside the owner's hours asks privately and creates no orphan reservations or pending writes", async t => {
  const f = fixture(t), details = { ...prepare.details, kind: "in_person", location: "Guest's office", meal: "dinner" };
  const blocked = meeting.parse(await f.app.run({ ...prepare, details }, owner));
  assert.equal(blocked.status, "waiting_on_us"); assert.equal(f.ports.events.size, 0);
  assert.ok(f.ports.messages.length > 0 && f.ports.messages.every(value => value.thread === "owner"));
  assert.deepEqual(f.records.uncertain(), []);
  const actor: Actor = { ...owner, source: source.parse({ ...ownerSource, messageId: "allow-dinner", text: "You may schedule this dinner outside working hours." }) };
  const held = meeting.parse(await f.app.run({ ...prepare, details, permissions: { outsideHours: true } }, actor));
  assert.equal(held.status, "held"); assert.equal(f.ports.events.size, 9);
  assert.deepEqual(f.records.owner()?.hours, prefs.hours);
});
test("weekday and daily limits apply in the owner's timezone and survive a restart and guest re-proposal", async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, timezone: "America/Sao_Paulo" }), ownerSource);
  const limited = { ...range, days: ["mon", "wed"], after: "14:00", before: "17:00" };
  const held = meeting.parse(await f.app.run({ ...prepare, range: limited }, owner));
  const sent = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  assert.deepEqual(sent.proposed?.slots.map(value => value.start), ["2026-10-05T17:00:00.000Z", "2026-10-07T17:00:00.000Z", "2026-10-12T17:00:00.000Z"]);
  const old = liveHolds(sent);
  f.records.close(); const reopened = new Records(f.root); t.after(() => reopened.close());
  const restarted = new Scheduling(reopened, f.ports, compose, () => now);
  const next = meeting.parse(await restarted.run({ action: "repropose", meetingId: sent.id, revision: 1, range }, guest));
  assert.equal(next.status, "held"); if (next.status !== "held") return;
  assert.deepEqual(next.range, limited); assert.deepEqual(next.ownerRange, limited);
  assert.deepEqual(next.proposal.slots.map(value => value.start), ["2026-10-05T17:15:00.000Z", "2026-10-07T17:15:00.000Z", "2026-10-12T17:15:00.000Z"]);
  assert.ok(old.every(ref => !f.ports.events.has(refKey(ref)))); assert.equal(f.ports.events.size, 3);
});
test("a guest cannot widen owner bounds; the owner can change them without a journal collision", async t => {
  const f = fixture(t), limited = { ...range, days: ["mon", "wed"], after: "14:00", before: "17:00" };
  const held = meeting.parse(await f.app.run({ ...prepare, range: limited }, owner));
  const sent = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  const refs = liveHolds(sent), previous = f.ports.messages.length;
  const blocked = meeting.parse(await f.app.run({ action: "repropose", meetingId: sent.id, revision: 1, range: { ...range, days: ["tue"] } }, guest));
  assert.equal(blocked.status, "sent"); assert.deepEqual(liveHolds(blocked), refs);
  assert.ok(f.ports.messages.slice(previous).length > 0 && f.ports.messages.slice(previous).every(value => value.thread === "owner"));
  assert.deepEqual(f.records.uncertain(), []);
  const actor: Actor = { ...owner, source: source.parse({ ...ownerSource, messageId: "allow-tuesday", text: "Tuesday after 3 is fine instead." }) };
  const permitted = { ...range, days: ["tue"], after: "15:00", before: "17:00" };
  const next = meeting.parse(await f.app.run({ action: "repropose", meetingId: sent.id, revision: 1, range: permitted }, actor));
  assert.equal(next.status, "sent"); if (next.status !== "sent") return;
  assert.deepEqual(next.ownerRange, permitted);
  assert.ok(next.proposal.slots.every(value => wall(Date.parse(value.start), "UTC").weekday === "tue"));
  assert.ok(refs.every(ref => !f.ports.events.has(refKey(ref)))); assert.deepEqual(f.records.uncertain(), []);
});
test("fewer than three replacement times retain the current sent proposal and every live hold", async t => {
  const f = fixture(t), sent = await f.sent(), refs = liveHolds(sent), previous = f.ports.messages.length;
  const next = meeting.parse(await f.app.run({ action: "repropose", meetingId: sent.id, revision: 1,
    range: { from: "2026-10-05T15:00:00Z", to: "2026-10-05T15:30:00Z" } }, guest));
  assert.equal(next.status, "sent"); assert.deepEqual(next.proposed, sent.proposed); assert.deepEqual(liveHolds(next), refs);
  assert.equal(f.ports.events.size, 3); assert.deepEqual(f.records.uncertain(), []);
  assert.ok(f.ports.messages.slice(previous).length > 0 && f.ports.messages.slice(previous).every(value => value.thread === "owner"));
});
test("a busy preferred time produces the nearest three permitted non-overlapping alternatives", async t => {
  const f = fixture(t), busy = event.parse({ ref: { calendar: prefs.calendar, id: "busy" }, status: "confirmed", start: "2026-10-05T13:30:00Z", end: "2026-10-05T14:30:00Z",
    title: "Private medical appointment", location: "", attendees: [], conference: "", transparent: false, declined: false, marker: "" });
  f.ports.events.set(refKey(busy.ref), busy);
  const held = meeting.parse(await f.app.run({ ...prepare, range: { ...range, days: ["mon"], after: "12:00", before: "16:00", near: "2026-10-05T14:00:00Z" } }, owner));
  assert.equal(held.status, "held"); if (held.status !== "held") return;
  assert.deepEqual(held.proposal.slots.map(value => value.start), ["2026-10-05T13:00:00.000Z", "2026-10-05T14:30:00.000Z", "2026-10-05T15:00:00.000Z"]);
  assert.deepEqual(f.ports.events.get(refKey(busy.ref)), busy);
  const sent = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  assert.doesNotMatch(sent.proposed?.text ?? "", /medical|appointment/);
});
test("nearest in-person options remain disjoint including both travel buffers", async t => {
  const f = fixture(t), held = meeting.parse(await f.app.run({ ...prepare, details: { ...prepare.details, kind: "in_person", location: "Guest's office", durationMin: 30 },
    range: { ...range, days: ["mon"], after: "11:00", before: "17:00", near: "2026-10-05T14:00:00Z" } }, owner));
  assert.equal(held.status, "held"); if (held.status !== "held") return;
  assert.deepEqual(held.proposal.slots.map(value => value.start), ["2026-10-05T12:30:00.000Z", "2026-10-05T14:00:00.000Z", "2026-10-05T15:30:00.000Z"]);
  const spans = held.proposal.slots.map(value => windows(value, held.details));
  for (let index = 1; index < spans.length; index++) assert.ok(spans[index - 1]!.every(a => spans[index]!.every(b => Date.parse(a.end) <= Date.parse(b.start))));
  assert.equal(f.ports.events.size, 9);
});
test("a displaced priority block uses free working time rather than inheriting lunch restrictions", async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, hours: { days: ["mon"], from: "09:00", to: "14:00" }, travelMin: 0, movableTitles: ["Prayer time"] }), ownerSource);
  const block = event.parse({ ref: { calendar: prefs.calendar, id: "prayer" }, status: "confirmed", start: "2026-10-05T11:30:00Z", end: "2026-10-05T12:30:00Z",
    title: "Prayer time", location: "", attendees: [], conference: "", transparent: false, declined: false, marker: "", createdByOwner: true });
  f.ports.events.set(refKey(block.ref), block);
  const held = meeting.parse(await f.app.run({ ...prepare, details: { ...prepare.details, kind: "in_person", location: "Guest's office", meal: "lunch", durationMin: 30 },
    range: { from: "2026-10-05T08:00:00Z", to: "2026-10-05T14:00:00Z" } }, owner));
  assert.equal(held.status, "held"); if (held.status !== "held") return;
  assert.deepEqual(held.proposal.slots.map(value => value.start), ["2026-10-05T11:30:00.000Z", "2026-10-05T12:00:00.000Z", "2026-10-05T12:30:00.000Z"]);
  assert.equal(f.ports.events.get(refKey(block.ref))?.start, "2026-10-05T09:00:00.000Z");
});
test("daily limits still constrain elapsed meeting time across the spring DST jump", () => {
  const search = { prefs: preferences.parse({ ...prefs, timezone: "America/New_York", noticeMin: 0 }), details: { kind: "phone" as const, durationMin: 60 },
    range: { from: "2027-03-14T00:00:00-05:00", to: "2027-03-15T00:00:00-04:00", days: ["sun" as const], after: "01:00", before: "03:00" },
    events: [], now: Date.parse("2027-03-13T00:00:00Z"), outsideHours: true };
  assert.throws(() => plan(search), /fewer than three/);
});

test("owner request holds three options, persists actual sent prose, verifies the invite and removes every sibling", async t => {
  const f = fixture(t), held = await f.held();
  assert.equal(held.status, "held"); assert.equal(f.ports.events.size, 3); assert.equal(f.ports.messages.length, 0);
  const sent = await f.sent(), booked = await f.choose(sent, 2);
  assert.equal(booked.status, "confirmed"); assert.equal(f.ports.events.size, 1); assert.equal(booked.cleanup.length, 0);
  assert.equal(sent.proposed?.text, f.ports.messages[0]?.text);
  const page = readFileSync(f.records.path(prepare.contact), "utf8");
  assert.match(page, /status: "confirmed"/); assert.match(page, /holds: \[\]/); assert.match(page, /Actual text:/);
});
test("a long completed history cannot hide a current meeting or pending cleanup from the owner", async t => {
  const f = fixture(t), held = await f.held();
  for (let index = 0; index < 40; index++) f.records.save(meeting.parse({ ...held, id: `archived-${index}`, status: "passed",
    contact: { name: `Archived ${index}`, handle: `archived-${index}@example.test` } }), "The provider verified cancellation. ".repeat(100));
  const cleanup = meeting.parse({ ...held, id: "unfinished-cleanup", status: "passed", cleanup: liveHolds(held).slice(0, 1) });
  f.records.save(cleanup, "The calendar verified cancellation; one recorded hold still needs deletion.");
  const status = JSON.stringify(await f.app.run({ action: "status" }, owner));
  assert.ok(status.includes(held.id)); assert.ok(status.includes(cleanup.id)); assert.ok(status.length < 8_000);
  const history = JSON.stringify(await f.app.run({ action: "research", query: "archived-39@example.test" }, owner));
  assert.ok(history.includes("archived-39")); assert.ok(history.includes("provider verified cancellation"));
});
test("external request holds first and sends all times only after a private owner approval", async t => {
  const f = fixture(t), held = await f.held(true, "in_person");
  assert.equal(f.ports.events.size, 9); assert.ok(f.ports.messages.every(value => value.thread === "owner"));
  await assert.rejects(f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner), /privately approve/);
  await assert.rejects(f.app.run({ action: "approve", meetingId: held.id, revision: 1 }, guest), /owner/);
  const sent = await f.sent(true, "in_person"), booked = await f.choose(sent);
  assert.equal(booked.status, "confirmed"); assert.equal(f.ports.events.size, 3); assert.equal(liveHolds(booked).length, 2);
});
test("a private clarification after holding preserves every reservation and the owner's authorization", async t => {
  const f = fixture(t), held = await f.held();
  const answer = meeting.parse(await f.app.run({ action: "ask", contact: prepare.contact, question: "Is there anything else to include?" }, owner));
  assert.equal(answer.status, "held");
  assert.deepEqual(liveHolds(answer), liveHolds(held));
  assert.equal(f.ports.events.size, 3);
  const sent = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  assert.equal(sent.status, "sent");
});
for (const mode of ["google_meet", "zoom_personal", "zoom_new"] as const) test(`stored ${mode} preference is used and preserved on a move`, async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, video: mode === "zoom_personal" ? { kind: mode, url: "https://zoom.us/my/fixture" } : { kind: mode } }), ownerSource);
  const booked = await f.choose(await f.sent()); assert.equal(booked.status, "confirmed");
  if (booked.status !== "confirmed") throw new Error("expected confirmed");
  const moved = meeting.parse(await f.app.run({ action: "move", meetingId: booked.id, start: "2026-10-12T13:00:00Z" }, owner));
  assert.equal(moved.status, "confirmed"); assert.equal(f.ports.events.size, 1);
  if (moved.status !== "confirmed") throw new Error("expected confirmed");
  assert.deepEqual(moved.invitation.event.ref, booked.invitation.event.ref);
  assert.equal(moved.invitation.event.conference, booked.invitation.event.conference);
  assert.equal(moved.invitation.event.location, booked.invitation.event.location);
});
test("missing stored video preference asks privately and creates no default conference or holds", async t => {
  const f = fixture(t); f.records.remember(preferences.parse({ ...prefs, video: null }), ownerSource);
  const app = new Scheduling(f.records, f.ports, async context => {
    assert.deepEqual((context as { request: unknown }).request, { origin: "owner", message: ownerSource.text });
    assert.equal((context as { owner: string }).owner, "Sam");
    assert.equal((context as { contact: string }).contact, "Taylor");
    return "Which video provider would you like for the meeting you requested?";
  }, () => now);
  const answer = await app.run(prepare, owner);
  assert.equal(meeting.parse(answer).status, "waiting_on_us");
  assert.equal(f.ports.events.size, 0); assert.ok(f.ports.messages.every(value => value.thread === "owner"));
});
for (const fault of ["missingAttendee", "missingLink", "tentative"] as const) test(`unverified ${fault} invitation retains every sibling until same-event recovery`, async t => {
  const f = fixture(t), sent = await f.sent(); f.ports[fault] = true;
  await assert.rejects(f.choose(sent)); assert.equal(f.ports.events.size, 3);
  assert.notEqual(f.records.find(sent.id).status, "confirmed");
  const observed = [...f.ports.events.values()].find(value => value.marker.includes("/book")); assert.ok(observed);
  f.ports.events.set(refKey(observed.ref), event.parse({ ...observed, status: "confirmed", attendees: ["taylor@example.test"], conference: "https://meet.google.com/abc-defg-hij" }));
  f.ports[fault] = false;
  await f.choose(sent); assert.equal(f.ports.events.size, 1); assert.equal(f.ports.calls.filter(value => value.operation === "update").length, 1);
});
test("partial hold rejection removes its verified holds, and an unknown creation is recovered without duplication", async t => {
  const f = fixture(t); f.ports.failCreate = 2;
  await assert.rejects(f.held()); assert.equal(f.ports.events.size, 0);
  const g = fixture(t); g.ports.loseCreate = 2;
  await assert.rejects(g.held()); assert.equal(g.ports.events.size, 2);
  assert.equal(liveHolds(g.records.pages()[0]!.meetings[0]!).length, 1);
  const recovered = await g.held(); assert.equal(recovered.status, "held"); assert.equal(g.ports.events.size, 3);
  assert.equal(g.ports.calls.filter(value => value.operation === "create").length, 3);
});
test("unknown ordinary message delivery recovers the exact inbox receipt without sending again", async t => {
  const f = fixture(t), sent = await f.sent();
  const held = meeting.parse(await f.app.run({ action: "repropose", meetingId: sent.id, revision: 1, range }, guest));
  assert.equal(held.status, "held"); f.ports.loseSend = true;
  await assert.rejects(f.app.run({ action: "publish", meetingId: held.id, revision: 2 }, owner));
  const count = f.ports.calls.filter(value => value.operation === "send").length;
  f.ports.loseSend = false;
  const result = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 2 }, owner));
  assert.equal(result.status, "sent"); assert.equal(f.ports.calls.filter(value => value.operation === "send").length, count);
});
test("failed sibling deletion retains its exact ID and later reconciliation removes only that hold", async t => {
  const f = fixture(t), sent = await f.sent();
  if (sent.status !== "sent") throw new Error("expected sent");
  const failed = sent.proposal.slots[2].meeting; f.ports.failedDeletes.add(failed.id);
  const booked = await f.choose(sent); assert.equal(booked.status, "confirmed"); assert.deepEqual(booked.cleanup, [failed]); assert.equal(f.ports.events.size, 2);
  f.ports.failedDeletes.clear(); await f.app.reconcile(); assert.equal(f.ports.events.size, 1); assert.equal(f.records.find(sent.id).cleanup.length, 0);
});
test("replacement proposals revoke old revisions and external approval never carries to new times", async t => {
  const f = fixture(t), sent = await f.sent(true);
  const next = meeting.parse(await f.app.run({ action: "repropose", meetingId: sent.id, revision: 1, range }, guest));
  assert.equal(next.status, "held"); assert.equal(next.proposed?.revision, 1); assert.equal(f.ports.events.size, 3);
  await assert.rejects(f.choose(sent), /no longer|unsent/);
  await assert.rejects(f.app.run({ action: "publish", meetingId: sent.id, revision: 2 }, owner), /approve/);
  await assert.rejects(f.app.run({ action: "approve", meetingId: sent.id, revision: 1 }, owner), /no longer/);
});
test("in-person moves replace travel and cancellation leaves no meeting or travel events", async t => {
  const f = fixture(t), sent = await f.sent(false, "in_person"), booked = await f.choose(sent);
  assert.equal(f.ports.events.size, 3);
  const moved = meeting.parse(await f.app.run({ action: "move", meetingId: booked.id, start: "2026-10-12T13:00:00Z" }, owner));
  assert.equal(f.ports.events.size, 3); assert.equal(moved.cleanup.length, 0);
  const cancelled = meeting.parse(await f.app.run({ action: "cancel", meetingId: booked.id }, owner));
  assert.equal(cancelled.status, "passed"); assert.equal(f.ports.events.size, 0);
});
test("guests cannot edit preferences, move or cancel the owner's meeting, or select another contact's proposal", async t => {
  const f = fixture(t), sent = await f.sent();
  await assert.rejects(f.app.run({ action: "remember", preferences: prefs }, guest), /owner/);
  await assert.rejects(f.app.run({ action: "cancel", meetingId: sent.id }, guest), /owner/);
  await assert.rejects(f.app.run({ action: "choose", meetingId: sent.id, revision: 1, option: 1 }, { kind: "guest", source: source.parse({ ...guestSource, handle: "other@example.test" }) }), /authenticated/);
  assert.equal(f.ports.events.size, 3);
});
test("incomplete calendars never produce holds, and expired offers cannot book", async t => {
  const f = fixture(t); f.ports.incomplete = true; await assert.rejects(f.held(), /incomplete/); assert.equal(f.ports.events.size, 0);
  const g = fixture(t), sent = await g.sent(); g.advance(49 * 3_600_000);
  await assert.rejects(g.choose(sent), /expired/); await g.app.reconcile(); assert.equal(g.ports.events.size, 0);
});
test("owner block closes the pipeline and prevents another request for the contact", async t => {
  const f = fixture(t); await f.sent();
  await f.app.run({ action: "block", handle: prepare.contact.handle }, owner); assert.equal(f.ports.events.size, 0);
  await assert.rejects(f.app.run(prepare, owner), /blocked|rejected/);
});

test("an external iMessage request on the agent's Plow thread creates held times and a private gate without a Contacts card", async t => {
  const f = fixture(t), incoming = source.parse({ ...guestSource, messageId: "42" });
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "request", name: "Taylor", details: prepare.details, question: null, text: "I'll check with Sam.", evidence: "project review" }));
  f.records.receive(incoming); await inbound.handle(incoming);
  const value = f.records.pages()[0]!.meetings[0]!;
  assert.equal(value.status, "held"); assert.equal(f.ports.events.size, 3); assert.equal(f.records.pendingSources().length, 0);
  assert.deepEqual(f.ports.messages.filter(value => value.thread === "group").map(value => value.text), ["I'll check with Sam."]);
});
test("a calendar booking survives a wiki interruption and expiry without a second invitation", async t => {
  const f = fixture(t), sent = await f.sent();
  const save = f.records.save.bind(f.records); let interrupted = false;
  t.mock.method(f.records, "save", (value: Meeting, text: string) => {
    if (value.status === "confirmed" && !interrupted) { interrupted = true; throw new Error("disk temporarily unavailable"); }
    save(value, text);
  });
  await assert.rejects(f.choose(sent), /disk/); assert.equal(f.ports.events.size, 3);
  f.advance(49 * 3_600_000); await f.app.reconcile();
  assert.equal(f.records.find(sent.id).status, "confirmed"); assert.equal(f.ports.events.size, 1);
  assert.equal(f.ports.calls.filter(value => value.operation === "update").length, 1);
});
test("owner cancellation recovers and deletes an interrupted hold whose creation response was lost", async t => {
  const f = fixture(t); f.ports.loseCreate = 2; await assert.rejects(f.held());
  const value = f.records.pages()[0]!.meetings[0]!;
  await f.app.run({ action: "cancel", meetingId: value.id }, owner);
  assert.equal(f.ports.events.size, 1); await f.app.reconcile();
  assert.equal(f.ports.events.size, 0); assert.equal(liveHolds(f.records.find(value.id)).length, 0);
});
test("a manually moved in-person event gets verified replacement travel while an unreadable calendar is never cancellation", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent(false, "in_person"));
  if (booked.status !== "confirmed") throw new Error("expected booked");
  const ref = booked.invitation.event.ref, oldTravel = booked.invitation.travel;
  f.ports.events.set(refKey(ref), event.parse({ ...booked.invitation.event, start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" }));
  await f.app.reconcile(); const moved = f.records.find(booked.id);
  assert.equal(moved.status, "confirmed"); assert.equal(f.ports.events.size, 3);
  assert.ok(oldTravel.every(value => !f.ports.events.has(refKey(value))));
  t.mock.method(f.ports, "read", async () => { throw new Error("calendar read failed"); });
  const report = await f.app.reconcile(); assert.ok(report.failures.length); assert.equal(f.records.find(booked.id).status, "confirmed");
});
test("only owner-listed unattached blocks move, and their private titles never appear in a proposal", async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, hours: { days: ["mon"], from: "09:00", to: "11:15" }, movableTitles: ["Prayer time"] }), ownerSource);
  const block = event.parse({ ref: { calendar: prefs.calendar, id: "prayer" }, status: "confirmed", start: "2026-10-05T09:15:00Z", end: "2026-10-05T09:30:00Z", title: "Prayer time", location: "", attendees: [], conference: "", transparent: false, declined: false, marker: "", createdByOwner: true });
  const hard = event.parse({ ...block, ref: { calendar: prefs.calendar, id: "medical" }, title: "Private medical appointment", start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", attendees: ["clinician@example.test"] });
  f.ports.events.set(refKey(block.ref), block); f.ports.events.set(refKey(hard.ref), hard);
  const held = meeting.parse(await f.app.run({ ...prepare, range: { from: "2026-10-05T08:00:00Z", to: "2026-10-05T12:00:00Z" } }, owner));
  assert.equal(held.status, "held"); assert.equal(f.ports.events.get(refKey(block.ref))?.start, "2026-10-05T11:00:00.000Z");
  assert.deepEqual(f.ports.events.get(refKey(hard.ref)), hard);
  const sent = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  assert.doesNotMatch(sent.proposed?.text ?? "", /Prayer|medical|appointment/);
});
test("an owner-listed title cannot move a collaborator's or unproven calendar block", async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, hours: { days: ["mon"], from: "09:00", to: "11:15" }, movableTitles: ["Prayer time"] }), ownerSource);
  const block = event.parse({ ref: { calendar: prefs.calendar, id: "foreign-prayer" }, status: "confirmed", start: "2026-10-05T09:15:00Z", end: "2026-10-05T09:30:00Z", title: "Prayer time", location: "", attendees: [], conference: "", transparent: false, declined: false, marker: "", createdByOwner: false });
  const hard = event.parse({ ...block, ref: { calendar: prefs.calendar, id: "medical" }, title: "Private appointment", start: "2026-10-05T10:00:00Z", end: "2026-10-05T10:30:00Z", attendees: ["clinician@example.test"] });
  f.ports.events.set(refKey(block.ref), block); f.ports.events.set(refKey(hard.ref), hard);
  const result = meeting.parse(await f.app.run({ ...prepare, range: { from: "2026-10-05T08:00:00Z", to: "2026-10-05T12:00:00Z" } }, owner));
  assert.equal(result.status, "waiting_on_us"); assert.equal(result.proposed, null);
  assert.deepEqual(f.ports.events.get(refKey(block.ref)), block);
  assert.ok(f.ports.calls.every(value => value.operation !== "update" && value.operation !== "create"));
});
test("a second guest choice cannot move an invitation already booked for another option", async t => {
  const f = fixture(t), sent = await f.sent();
  const results = await Promise.allSettled([f.choose(sent, 1), f.choose(sent, 2)]);
  assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected"); assert.equal(f.ports.events.size, 1);
  assert.equal(f.ports.calls.filter(value => value.operation === "update").length, 1);
});
test("maintenance recovers an unknown first group message after expiry without opening or sending again", async t => {
  const f = fixture(t), held = await f.held(); f.ports.loseSend = true;
  await assert.rejects(f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  const original = f.ports.messages.find(value => value.thread === "group"); assert.ok(original);
  f.ports.loseSend = false; f.advance(49 * 3_600_000);
  await new Scheduling(f.records, f.ports, compose, () => now + 49 * 3_600_000).reconcile();
  assert.deepEqual(f.records.find(held.id).proposed?.messageId, original.messageId);
  assert.equal(f.ports.calls.filter(value => value.operation === "thread").length, 1);
  assert.equal(f.ports.messages.filter(value => value.thread === "group").length, 1);
  assert.equal(f.ports.events.size, 0);
});
test("a private approval with lost delivery recovers the actual sent proposal even after its holds expire", async t => {
  const f = fixture(t), held = await f.held(true); f.ports.loseSend = true;
  await assert.rejects(f.app.run({ action: "approve", meetingId: held.id, revision: 1 }, owner));
  const original = f.ports.messages.find(value => value.thread === "group"); assert.ok(original);
  f.ports.loseSend = false; f.advance(49 * 3_600_000); await f.app.reconcile();
  assert.equal(f.records.find(held.id).proposed?.messageId, original.messageId);
  assert.equal(f.ports.messages.filter(value => value.thread === "group").length, 1);
  assert.equal(f.ports.events.size, 0);
});
test("owner repair restores a missing attendee on the original event without regenerating its Meet link", async t => {
  const f = fixture(t), sent = await f.sent(); f.ports.missingAttendee = true;
  await assert.rejects(f.choose(sent)); f.ports.missingAttendee = false;
  const repaired = meeting.parse(await f.app.run({ action: "repair", meetingId: sent.id }, owner));
  assert.equal(repaired.status, "confirmed"); assert.equal(f.ports.events.size, 1);
  const updates = f.ports.calls.filter(value => value.operation === "update").map(value => value.input as WriteEvent);
  assert.equal(updates.length, 2); assert.equal(updates[1]?.conference, "none");
  assert.equal(updates.filter(value => value.conference === "meet").length, 1);
});
test("owner repair supplies a missing Meet link before deleting any sibling hold", async t => {
  const f = fixture(t), sent = await f.sent(); f.ports.missingLink = true;
  await assert.rejects(f.choose(sent)); assert.equal(f.ports.events.size, 3); f.ports.missingLink = false;
  const repaired = meeting.parse(await f.app.run({ action: "repair", meetingId: sent.id }, owner));
  assert.equal(repaired.status, "confirmed"); assert.equal(f.ports.events.size, 1);
});
test("an uncertain Zoom room requires its existing owner-supplied URL and cannot create another room", async t => {
  const f = fixture(t); f.records.remember(preferences.parse({ ...prefs, video: { kind: "zoom_new" } }), ownerSource);
  const sent = await f.sent(); f.ports.missingAttendee = true; await assert.rejects(f.choose(sent)); f.ports.missingAttendee = false;
  const observed = [...f.ports.events.values()].find(value => value.marker.includes("/book")); assert.ok(observed);
  f.ports.events.set(refKey(observed.ref), event.parse({ ...observed, conference: "", location: "" }));
  await assert.rejects(f.app.run({ action: "repair", meetingId: sent.id }, guest), /owner/);
  await assert.rejects(f.app.run({ action: "repair", meetingId: sent.id }, owner), /existing Zoom/);
  const zoomUrl = "https://zoom.us/j/123456789?pwd=fixture";
  await assert.rejects(f.app.run({ action: "repair", meetingId: sent.id, zoomUrl }, owner), /supplied by the owner/);
  assert.equal(f.ports.events.size, 3);
  const repaired = meeting.parse(await f.app.run({ action: "repair", meetingId: sent.id, zoomUrl }, { ...owner, source: source.parse({ ...ownerSource, messageId: "owner-repair", text: `Use the existing room ${zoomUrl}` }) }));
  assert.equal(repaired.status, "confirmed"); assert.equal(f.ports.events.size, 1);
  const updates = f.ports.calls.filter(value => value.operation === "update").map(value => value.input as WriteEvent);
  assert.equal(updates.filter(value => value.conference === "zoom").length, 1); assert.equal(updates[1]?.conference, "none");
});
test("a hold repurposed by a calendar user is never overwritten with a guest invitation", async t => {
  const f = fixture(t), sent = await f.sent(); if (sent.status !== "sent") throw new Error("expected sent");
  const ref = sent.proposal.slots[0].meeting, observed = await f.ports.read(ref); assert.ok(observed);
  f.ports.events.set(refKey(ref), event.parse({ ...observed, attendees: ["other@example.test"] }));
  await assert.rejects(f.choose(sent), /changed/);
  assert.equal(f.ports.calls.filter(value => value.operation === "update").length, 0); assert.equal(f.ports.events.size, 3);
});
test("private Mac correspondence never starts outreach even when it contains meeting language", async t => {
  const f = fixture(t), incoming = source.parse({ ...guestSource, channel: "messages", thread: "iMessage;-;taylor@example.test", messageId: "42" });
  t.mock.method(f.ports, "research", async () => ({ texts: [{ rowid: 43, is_from_me: true }] }));
  const inbound = new Inbound(f.app, async () => assert.fail("Mac correspondence is research only"));
  f.records.receive(incoming); await inbound.handle(incoming);
  assert.equal(f.ports.events.size, 0); assert.equal(f.ports.messages.length, 0); assert.equal(f.records.pendingSources().length, 0);
});
test("paused inbox work stays durable and a replay of a handled guest choice makes no extra model call or invite", async t => {
  const f = fixture(t); await f.sent(); let calls = 0;
  const incoming = source.parse({ ...guestSource, messageId: "choice", text: "Tuesday at nine works" });
  const inbound = new Inbound(f.app, async () => { calls++; return JSON.stringify({ action: "choose", option: 2, evidence: incoming.text }); });
  f.records.remember(preferences.parse({ ...prefs, paused: true }), ownerSource); f.records.receive(incoming);
  await inbound.handle(incoming); assert.equal(calls, 0); assert.equal(f.records.pendingSources().length, 1);
  f.records.remember(prefs, ownerSource); await inbound.handle(incoming); await inbound.handle(incoming);
  assert.equal(calls, 1); assert.equal(f.ports.events.size, 1); assert.equal(f.ports.calls.filter(value => value.operation === "update").length, 1);
});

test("calendar-confirmed move and cancellation notices recover lost receipts without repeating a write or send", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent());
  f.ports.loseSend = true;
  await assert.rejects(f.app.run({ action: "move", meetingId: booked.id, start: "2026-10-12T13:00:00Z" }, owner));
  assert.equal(f.records.find(booked.id).status, "confirmed");
  const updates = f.ports.calls.filter(call => call.operation === "update").length;
  f.ports.loseSend = false; await f.app.reconcile();
  assert.equal(f.ports.calls.filter(call => call.operation === "update").length, updates);
  assert.equal(f.ports.messages.filter(message => message.thread === "group" && /new time/.test(message.text)).length, 1);
  f.ports.loseSend = true;
  await assert.rejects(f.app.run({ action: "cancel", meetingId: booked.id }, owner));
  assert.equal(f.records.find(booked.id).status, "passed"); assert.equal(f.ports.events.size, 0);
  const deletes = f.ports.calls.filter(call => call.operation === "delete").length;
  f.ports.loseSend = false; await f.app.reconcile();
  assert.equal(f.ports.calls.filter(call => call.operation === "delete").length, deletes);
  assert.equal(f.ports.messages.filter(message => message.thread === "group" && /cancelled/.test(message.text)).length, 1);
});
test("blocking a contact releases its invitation and travel without contacting the blocked person", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent(false, "in_person"));
  const messages = f.ports.messages.length;
  await f.app.run({ action: "block", handle: booked.contact.handle }, owner);
  await f.app.reconcile();
  assert.equal(f.records.find(booked.id).status, "do_not_contact");
  assert.equal(f.ports.events.size, 0); assert.equal(f.ports.messages.length, messages);
});

test("monitor nudges the owner and contact once, keeps approval private and suppresses contact nudges after a reply", async t => {
  const f = fixture(t), external = meeting.parse(await f.app.run({ ...prepare, source: { thread: "group", messageId: guestSource.messageId }, range: { ...range, from: "2026-10-06T08:00:00Z" } }, owner));
  f.advance(5 * 3_600_000); await f.app.reconcile(); await f.app.reconcile();
  assert.equal(f.ports.messages.filter(message => message.thread === "owner").length, 2);
  assert.equal(f.ports.messages.filter(message => message.thread === "group").length, 0);
  const sent = meeting.parse(await f.app.run({ action: "approve", meetingId: external.id, revision: 1 }, owner));
  f.advance(20 * 3_600_000); await f.app.reconcile(); await f.app.reconcile();
  assert.equal(f.ports.messages.filter(message => message.thread === "group" && /Would any/.test(message.text)).length, 1);
  assert.equal(f.records.find(sent.id).status, "waiting_on_them");
  const g = fixture(t); await g.sent(); g.advance(25 * 3_600_000);
  t.mock.method(g.ports, "replies", async () => [guestSource]);
  await g.app.reconcile();
  assert.equal(g.ports.messages.filter(message => /Would any/.test(message.text)).length, 0);
});
test("the LLM interprets implicit meeting language and the requested dates without a keyword filter", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, messageId: "77", text: "Lunch at our office on October 20?" });
  const requested = { from: "2026-10-20T08:00:00Z", to: "2026-10-20T18:00:00Z" };
  const inbound = new Inbound(f.app, async payload => {
    assert.equal(JSON.parse(payload).timezone, "UTC");
    return JSON.stringify({ action: "request", name: "Taylor", details: { ...prepare.details, kind: "in_person", location: "Fixture office" }, range: requested, question: null, text: "I'll check with Sam.", evidence: input.text });
  });
  f.records.receive(input); await inbound.handle(input);
  const value = f.records.pages()[0]!.meetings[0]!;
  assert.equal(value.status, "held"); if (value.status !== "held") throw new Error("expected held");
  assert.deepEqual(value.range, requested); assert.equal(f.ports.events.size, 9);
  assert.ok(value.proposal.slots.every(slot => slot.start.startsWith("2026-10-20")));
});
test("an invalid selection or replacement of an unsent hold creates no durable retry or calendar write", async t => {
  const f = fixture(t), held = await f.held(), writes = f.ports.calls.length;
  await assert.rejects(f.app.run({ action: "choose", meetingId: held.id, revision: 1, option: 1 }, owner), /Publish/);
  await assert.rejects(f.app.run({ action: "repropose", meetingId: held.id, revision: 1, range }, owner), /Publish/);
  assert.deepEqual(f.records.uncertain(), []); assert.equal(f.ports.calls.length, writes);
});

test("all outbound prose comes from the LLM and a lost receipt reuses its durable draft", async t => {
  const f = fixture(t), held = await f.held(); let drafts = 0;
  const app = new Scheduling(f.records, f.ports, async context => {
    drafts++; assert.equal((context as { contact: string }).contact, "Taylor");
    return "An original model-written proposal for the three verified options.";
  }, () => now);
  f.ports.loseSend = true;
  await assert.rejects(app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  assert.equal(f.ports.messages[0]?.text, "An original model-written proposal for the three verified options.");
  f.ports.loseSend = false;
  const sent = meeting.parse(await app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  assert.equal(sent.proposed?.text, f.ports.messages[0]?.text); assert.equal(drafts, 1);
  assert.equal(f.ports.messages.filter(message => message.thread === "group").length, 1);
});

test("the LLM answers a contact's ordinary invitation question from verified facts without asking the owner", async t => {
  const f = fixture(t); await f.choose(await f.sent());
  const question = source.parse({ ...guestSource, messageId: "email-question", text: "To which email did you send the invitation?" });
  const answer = "I sent the invitation to taylor@example.test. Your Google Meet link is https://meet.google.com/abc-defg-hij.";
  let completions = 0;
  const inbound = new Inbound(f.app, async payload => {
    completions++; const context = JSON.parse(payload).context;
    assert.deepEqual(context.booked.attendees, ["taylor@example.test"]);
    assert.equal(context.booked.link, "https://meet.google.com/abc-defg-hij");
    return JSON.stringify({ action: "reply", text: answer, evidence: "which email" });
  });
  const before = f.ports.messages.length;
  f.records.receive(question); await inbound.handle(question); await inbound.handle(question);
  assert.equal(completions, 1); assert.equal(f.ports.messages.length, before + 1);
  assert.equal(f.ports.messages.at(-1)?.thread, "group"); assert.equal(f.ports.messages.at(-1)?.text, answer);
});

test("the owner can write a natural reply only into the meeting's authorized group, with a verified receipt", async t => {
  const f = fixture(t), held = await f.held(), text = "I sent it to taylor@example.test.";
  await assert.rejects(f.app.run({ action: "reply", meetingId: held.id, text }, owner), /authorized/);
  const sent = await f.sent();
  await assert.rejects(f.app.run({ action: "reply", meetingId: sent.id, text }, guest), /owner/);
  await f.app.run({ action: "reply", meetingId: sent.id, text }, owner);
  assert.equal(f.ports.messages.at(-1)?.thread, "group"); assert.equal(f.ports.messages.at(-1)?.text, text);
});

test("a moved video meeting supplies its verified link and attendees to the model that writes the group update", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent());
  assert.equal(booked.status, "confirmed");
  if (booked.status !== "confirmed") throw new Error("expected booked");
  const contexts: unknown[] = [];
  const app = new Scheduling(f.records, f.ports, async context => {
    contexts.push(context); return "A natural model-written time update with the verified link.";
  }, () => now);
  await app.run({ action: "move", meetingId: booked.id, start: "2026-10-08T10:00:00Z" }, owner);
  const invitation = (contexts[0] as { invitation: { start: string; link: string; attendees: string[] } }).invitation;
  assert.equal((contexts[0] as { audience: string }).audience, "meeting group");
  assert.equal((contexts[0] as { recipient: string }).recipient, "Taylor");
  assert.equal(invitation.start, "2026-10-08T10:00:00Z");
  assert.equal(invitation.link, booked.invitation.event.conference);
  assert.deepEqual(invitation.attendees, ["taylor@example.test"]);
  assert.equal(f.ports.messages.at(-1)?.thread, "group");
  assert.equal(f.ports.messages.at(-1)?.text, "A natural model-written time update with the verified link.");
});

test("an ordinary guest answer recovers its first delivery even if the retried model writes different prose", async t => {
  const f = fixture(t); await f.choose(await f.sent());
  const question = source.parse({ ...guestSource, messageId: "lost-email-reply", text: "Where did you send it?" });
  let attempts = 0;
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "reply", evidence: question.text,
    text: ++attempts === 1 ? "I sent it to taylor@example.test." : "The invitation went to taylor@example.test." }));
  f.records.receive(question); f.ports.loseSend = true;
  await assert.rejects(inbound.handle(question), /unknown/);
  assert.equal(f.records.isHandled(question), false);
  f.ports.loseSend = false; await inbound.handle(question);
  assert.equal(f.records.isHandled(question), true);
  assert.equal(f.ports.messages.at(-1)?.text, "I sent it to taylor@example.test.");
  assert.equal(f.ports.messages.filter(message => message.text === "I sent it to taylor@example.test.").length, 1);
  assert.equal(attempts, 1);
});

test("queued Mac conversations and their interrupted tasks cannot trigger model replies or outreach", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, channel: "messages", thread: "iMessage;-;+15550000003", messageId: "old-archive-row",
    text: "Another assistant asked whether to share a household task page." });
  f.records.receive(input);
  const admission = { command: { action: "ask", contact: { name: input.handle, handle: input.handle }, question: "May I share that page?" },
    authority: { kind: "guest", source: input, mainDm: false } };
  const key = `task:${createHash("sha256").update(JSON.stringify(admission)).digest("hex").slice(0, 24)}`;
  await assert.rejects(f.records.effect(key, admission, meeting.nullable(), { run: async () => { throw new Error("old task interrupted"); } }));
  const inbound = new Inbound(f.app, async () => assert.fail("research archives are not live requests"));
  await inbound.handle(input);
  assert.equal(f.records.isHandled(input), true);
  assert.deepEqual(await f.app.reconcile(), { pending: 0, failures: [] });
  assert.equal(f.records.operation(key)?.state, "rejected");
  await assert.rejects(f.app.run({ action: "ask", contact: admission.command.contact, question: admission.command.question }, { kind: "guest", source: input }), /research context/);
  assert.deepEqual(f.records.pages(), []); assert.deepEqual(f.ports.calls, []);
});
test("an invalid explicit inbox reference creates no durable task, calendar hold or notice", async t => {
  const f = fixture(t);
  await assert.rejects(f.app.run({ ...prepare, contact: { name: "Someone else", handle: "other@example.test" }, source: { thread: "group", messageId: guestSource.messageId } }, owner), /source contact/);
  assert.deepEqual(f.records.uncertain(), []);
  t.mock.method(f.ports, "message", async () => { throw new RejectedEffect("The inbox did not verify this incoming scheduling message."); });
  const input = command.parse({ ...prepare, source: { thread: "group", messageId: "invented-current-message" } });
  await assert.rejects(f.app.run(input, owner), RejectedEffect);
  assert.deepEqual(f.records.uncertain(), []); assert.deepEqual(f.records.pages(), []); assert.deepEqual(f.ports.calls, []);
  const admission = { command: input, authority: { kind: "owner", source: ownerSource, mainDm: true } };
  const key = `task:${createHash("sha256").update(JSON.stringify(admission)).digest("hex").slice(0, 24)}`;
  await assert.rejects(f.records.effect(key, admission, meeting.nullable(), { run: async () => { throw new Error("old source lookup interrupted"); } }));
  assert.deepEqual(await f.app.reconcile(), { pending: 0, failures: [] });
  assert.equal(f.records.operation(key)?.state, "rejected"); assert.deepEqual(f.ports.calls, []);
});

test("a private-decision interpretation without a current meeting cannot create a task or send a promise", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, messageId: "unrelated-document", text: "Can I send the household page to someone?" });
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "owner", evidence: input.text,
    question: "Should this document be sent?", text: "I will send that page." }));
  f.records.receive(input); await inbound.handle(input);
  assert.equal(f.records.isHandled(input), true);
  assert.deepEqual(f.records.pages(), []); assert.deepEqual(f.ports.calls, []);
});

test("a new meeting with missing details remains a tracked request and gets a model-written acknowledgement", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, messageId: "missing-meeting-details", text: "Can I meet with Sam next week?" });
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "request", name: "Taylor", details: null, question: "Which meeting format should I use?",
    evidence: input.text, text: "I'll check the details with Sam." }));
  f.records.receive(input); await inbound.handle(input);
  assert.equal(f.records.pages()[0]?.meetings[0]?.status, "waiting_on_us");
  assert.equal(f.ports.events.size, 0);
  assert.equal(f.ports.messages.at(-1)?.thread, "group");
  assert.equal(f.ports.messages.at(-1)?.text, "I'll check the details with Sam.");
});

test("retrying an uncertain private question keeps the first interpretation and sends one notice", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, messageId: "uncertain-private-question", text: "Can Sam meet next week?" });
  let interpretations = 0;
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "request", name: "Taylor", details: null,
    question: ++interpretations === 1 ? "Which format?" : "Which provider?", evidence: input.text, text: "I'll check with Sam." }));
  f.records.receive(input); f.ports.loseSend = true;
  await assert.rejects(inbound.handle(input), /unknown/);
  f.ports.loseSend = false; await inbound.handle(input);
  assert.equal(interpretations, 1);
  assert.equal(f.ports.messages.filter(value => value.thread === "owner").length, 1);
  assert.equal(f.ports.messages.filter(value => value.thread === "group").length, 1);
  assert.equal(f.records.pages()[0]?.meetings[0]?.status, "waiting_on_us");
  assert.equal(f.records.isHandled(input), true);
});

test("an external scheduling request gets a model-written acknowledgement while its times remain privately gated", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, messageId: "new-external-request", text: "Could Sam and I meet next week?" });
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "request", name: "Taylor", details: prepare.details,
    range, question: null, evidence: input.text, text: "I'll check with Sam and get back to you." }));
  f.records.receive(input); await inbound.handle(input);
  const value = f.records.pages()[0]!.meetings[0]!;
  assert.equal(value.status, "held"); assert.equal(value.proposed, null);
  assert.equal(f.ports.events.size, 3);
  assert.deepEqual(f.ports.messages.filter(message => message.thread === "group").map(message => message.text), ["I'll check with Sam and get back to you."]);
});

test("a guest's request to change a booked meeting is acknowledged in its thread while the decision goes privately to the owner", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent());
  const input = source.parse({ ...guestSource, messageId: "guest-change", text: "Could we move this to Thursday?" });
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "owner", evidence: input.text,
    question: "Can Taylor's booked meeting move to Thursday?", text: "I'll check with Sam about Thursday." }));
  const writes = f.ports.calls.filter(call => call.operation === "update").length;
  f.records.receive(input); await inbound.handle(input);
  assert.equal(f.ports.calls.filter(call => call.operation === "update").length, writes);
  assert.equal(f.ports.messages.at(-1)?.thread, "group");
  assert.equal(f.ports.messages.at(-1)?.text, "I'll check with Sam about Thursday.");
  assert.equal(f.records.find(booked.id).status, "confirmed");
});

test("a reused contact thread routes a guest choice to its newest sent proposal instead of an older invitation", async t => {
  const f = fixture(t), first = await f.choose(await f.sent());
  const nextOwner: Actor = { ...owner, source: source.parse({ ...ownerSource, messageId: "another-meeting", at: new Date(now + 1000).toISOString() }) };
  const held = meeting.parse(await f.app.run(prepare, nextOwner));
  const originalSend = f.ports.send.bind(f.ports);
  t.mock.method(f.ports, "send", async (thread: string, text: string) => ({ ...await originalSend(thread, text), at: new Date(now + 1000).toISOString() }));
  const second = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, nextOwner));
  assert.equal(second.proposed?.thread, first.proposed?.thread);
  const input = source.parse({ ...guestSource, messageId: "second-meeting-choice", text: "The second one works." });
  const inbound = new Inbound(f.app, async payload => {
    assert.equal(JSON.parse(payload).context.id, second.id);
    return JSON.stringify({ action: "choose", option: 2, evidence: input.text });
  });
  f.records.receive(input); await inbound.handle(input);
  assert.equal(f.records.find(first.id).status, "confirmed");
  assert.equal(f.records.find(second.id).status, "confirmed");
});

test("rejecting options preserves the requested dates unless the guest asks for a different range", async t => {
  const f = fixture(t), sent = await f.sent();
  const input = source.parse({ ...guestSource, messageId: "none-work", text: "None of those times works. Can you suggest other options?" });
  const inbound = new Inbound(f.app, async payload => {
    assert.deepEqual(JSON.parse(payload).context.requestedRange, range);
    return JSON.stringify({ action: "repropose", range: null, text: "I'll check other options.", evidence: "None of those times works" });
  });
  await inbound.handle(input);
  const replacement = f.records.find(sent.id);
  assert.equal(replacement.status, "sent");
  if (replacement.status !== "sent") throw new Error("The replacement was not sent.");
  assert.deepEqual(replacement.range, range);
  assert.ok(replacement.proposal.slots.every(slot => Date.parse(slot.start) >= Date.parse(range.from) && Date.parse(slot.start) < Date.parse(range.to)));
});

test("the owner schedules naturally inside the contact's served group, without opening another group", async t => {
  const f = fixture(t), actor: Actor = { ...owner, source: source.parse({ ...ownerSource, thread: "group" }), mainDm: false };
  const research = t.mock.method(f.ports, "research", async (query: string) => ({ contact: query }));
  for (const query of ["Find context for our project meeting next week", "other@example.test"]) {
    const result = await f.app.run({ action: "research", query }, actor) as { contact: unknown; context: { contact: string } };
    assert.deepEqual(result.contact, prepare.contact); assert.equal(result.context.contact, prepare.contact.handle);
  }
  assert.ok(research.mock.calls.every(call => call.arguments[0] === prepare.contact.handle));
  await f.app.run(prepare, actor);
  const held = f.records.contact(prepare.contact.handle)?.meetings[0]; assert.ok(held);
  assert.equal(held.status, "held"); assert.equal(f.ports.events.size, 3);
  await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, actor);
  const sent = f.records.find(held.id);
  assert.equal(sent.proposed?.thread, "group"); assert.equal(f.ports.calls.filter(value => value.operation === "thread").length, 0);
  const booked = await f.choose(sent);
  assert.equal(booked.status, "confirmed");
  await f.app.run({ action: "move", meetingId: booked.id, start: "2026-10-08T12:00:00Z" }, actor);
  await f.app.run({ action: "cancel", meetingId: booked.id }, actor);
  assert.equal(f.ports.events.size, 0);
});
test("group ownership cannot access other contacts, approve external options, or alter owner preferences", async t => {
  const f = fixture(t);
  const privateRoom = "https://zoom.us/my/private-owner-room";
  f.records.remember(preferences.parse({ ...prefs, video: { kind: "zoom_personal", url: privateRoom } }), ownerSource);
  const held = await f.held(true), actor: Actor = { ...owner, source: source.parse({ ...ownerSource, thread: "group" }), mainDm: false };
  for (const command of [
    { ...prepare, contact: { name: "Someone else", handle: "other@example.test" } },
    { action: "approve", meetingId: held.id, revision: 1 },
    { action: "remember", preferences: prefs },
  ]) await assert.rejects(f.app.run(command, actor));
  const status = JSON.stringify(await f.app.run({ action: "status" }, actor));
  assert.ok(!status.includes(held.status === "held" ? held.proposal.slots[0].start : "no-slot"));
  assert.ok(!status.includes("busyCalendars"));
  assert.ok(status.includes('"videoProvider":"zoom_personal"')); assert.ok(!status.includes(privateRoom));
  assert.equal(f.ports.messages.filter(value => value.thread === "group").length, 0);
  await f.sent(true);
  const result = JSON.stringify(await f.app.run({ action: "repropose", meetingId: held.id, revision: 1, range }, actor));
  const replacement = f.records.find(held.id); assert.equal(replacement.status, "held"); if (replacement.status !== "held") return;
  assert.ok(replacement.proposal.slots.every(slot => !result.includes(slot.start))); assert.ok(!result.includes('"source"'));
  assert.equal(replacement.approval, "required"); assert.equal(f.ports.messages.filter(value => value.thread === "group").length, 1);
});
test("in-person rescheduling uses current travel preferences, including enabling and disabling travel", async t => {
  const f = fixture(t);
  f.records.remember(preferences.parse({ ...prefs, travelMin: 0 }), ownerSource);
  const booked = await f.choose(await f.sent(false, "in_person")); assert.equal(booked.status, "confirmed");
  f.records.remember(preferences.parse({ ...prefs, travelMin: 45 }), ownerSource);
  const moved = meeting.parse(await f.app.run({ action: "move", meetingId: booked.id, start: "2026-10-08T12:00:00Z" }, owner));
  assert.equal(moved.status, "confirmed"); if (moved.status !== "confirmed") return;
  assert.equal(moved.details.kind === "in_person" && moved.details.travelMin, 45);
  assert.equal(moved.invitation.travel.length, 2); assert.equal(f.ports.events.size, 3);
  for (const ref of moved.invitation.travel) { const span = await f.ports.read(ref); assert.ok(span); assert.equal(Date.parse(span.end) - Date.parse(span.start), 45 * 60_000); }
  f.records.remember(preferences.parse({ ...prefs, travelMin: 0 }), ownerSource);
  const final = meeting.parse(await f.app.run({ action: "move", meetingId: booked.id, start: "2026-10-09T12:00:00Z" }, owner));
  assert.equal(final.status, "confirmed"); assert.equal(f.ports.events.size, 1); assert.equal(liveHolds(final).length, 0);
});
test("a verified same-time Meet link change reaches the guest's own thread and their natural answer", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent()); assert.equal(booked.status, "confirmed"); if (booked.status !== "confirmed") return;
  const link = "https://meet.google.com/xyz-wxyz-uvw";
  f.ports.events.set(refKey(booked.invitation.event.ref), { ...booked.invitation.event, conference: link });
  const input = source.parse({ ...guestSource, messageId: "new-link-question", text: "What's the meeting link?" });
  f.records.receive(input);
  const inbound = new Inbound(f.app, async message => {
    const context = JSON.parse(message).context;
    assert.equal(context.booked.link, link);
    return JSON.stringify({ action: "reply", evidence: input.text, text: `Here's the current link: ${link}` });
  });
  await inbound.handle(input);
  const saved = f.records.find(booked.id); assert.equal(saved.status === "confirmed" && saved.invitation.event.conference, link);
  assert.equal(f.ports.messages.at(-1)?.text, `Here's the current link: ${link}`); assert.equal(f.ports.messages.at(-1)?.thread, "group");
});
test("join reminders are drafted by the LLM with the verified link, once per booked time, and survive a lost receipt", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent()); assert.equal(booked.status, "confirmed");
  f.advance(50 * 60_000);
  let drafts = 0;
  const app = new Scheduling(f.records, f.ports, async context => {
    const facts = context as { invitation: { link: string }; facts: { purpose: string } };
    assert.match(facts.facts.purpose, /Remind/); assert.equal(facts.invitation.link, "https://meet.google.com/abc-defg-hij");
    drafts++; return `Sam's meeting starts soon. Join here: ${facts.invitation.link}`;
  }, () => now + 50 * 60_000);
  f.ports.loseSend = true;
  await assert.rejects(app.nudge(booked));
  f.ports.loseSend = false;
  assert.deepEqual((await app.reconcile()).failures, []);
  await app.nudge(f.records.find(booked.id));
  assert.equal(drafts, 1); assert.equal(f.ports.messages.filter(message => /starts soon/.test(message.text)).length, 1);
  assert.equal(f.records.uncertain().length, 0);
});
test("paused, cancelled and late meetings do not send join reminders", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent());
  const before = f.ports.messages.length;
  f.records.remember(preferences.parse({ ...prefs, paused: true }), ownerSource);
  f.advance(50 * 60_000); await f.app.nudge(booked); assert.equal(f.ports.messages.length, before);
  f.records.remember(prefs, ownerSource); f.advance(20 * 60_000); await f.app.nudge(booked); assert.equal(f.ports.messages.length, before);
  const app = new Scheduling(f.records, f.ports, async () => {
    assert.equal(booked.status, "confirmed"); if (booked.status === "confirmed") f.ports.events.delete(refKey(booked.invitation.event.ref));
    return "This draft cannot be sent after cancellation.";
  }, () => now + 50 * 60_000);
  await assert.rejects(app.nudge(booked), RejectedEffect);
  assert.equal(f.ports.messages.length, before);
});
test("an unavailable calendar gets a natural guest acknowledgement and a private check, never a cached link", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent());
  t.mock.method(f.ports, "read", async () => { throw new Error("calendar offline"); });
  const input = source.parse({ ...guestSource, messageId: "offline-link", text: "Could I get the link?" }); f.records.receive(input);
  const inbound = new Inbound(f.app, async message => {
    assert.equal(JSON.parse(message).context.booked, null);
    return JSON.stringify({ action: "reply", evidence: input.text, text: "I'm checking the current invitation and will get back to you." });
  });
  await inbound.handle(input);
  assert.equal(f.ports.messages.at(-1)?.thread, "group"); assert.ok(!f.ports.messages.at(-1)?.text.includes("meet.google.com"));
  assert.equal(f.records.find(booked.id).status, "confirmed");
});
test("owner exceptions stay local to one three-option proposal and guests cannot grant them", async t => {
  const f = fixture(t), evening = { from: "2026-10-10T20:00:00Z", to: "2026-10-11T02:00:00Z" };
  const allowed = { outsideHours: true, conflicts: [] };
  await assert.rejects(f.app.run({ ...prepare, range: evening, permissions: allowed }, guest));
  assert.equal(f.ports.events.size, 0);
  const held = meeting.parse(await f.app.run({ ...prepare, range: evening, permissions: allowed }, owner));
  assert.equal(held.status, "held"); if (held.status !== "held") return;
  assert.equal(held.proposal.slots.length, 3); assert.equal(held.permissions.outsideHours, true);
  const sent = meeting.parse(await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner));
  assert.equal((await f.choose(sent)).status, "confirmed"); assert.deepEqual(f.records.owner()?.hours, prefs.hours);
});
test("an overlap exception covers only the owner's exact event ID and leaves that event unchanged", async t => {
  const f = fixture(t), blocked = event.parse({ ref: { calendar: prefs.calendar, id: "personal-block" }, status: "confirmed", start: range.from, end: range.to,
    title: "Private reason", location: "", attendees: [], conference: "", transparent: false, declined: false, marker: "" });
  f.ports.events.set(refKey(blocked.ref), blocked);
  const held = meeting.parse(await f.app.run({ ...prepare, permissions: { conflicts: [blocked.ref] } }, owner));
  assert.equal(held.status, "held"); if (held.status !== "held") return;
  const extra = { ...blocked, ref: { ...blocked.ref, id: "new-conflict" } }; f.ports.events.set(refKey(extra.ref), extra);
  await assert.rejects(f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, owner), /no longer available/);
  assert.deepEqual(f.ports.events.get(refKey(blocked.ref)), blocked); assert.equal(f.ports.messages.length, 0);
});
test("verified Mac discovery prepares exactly three holds, keeps every time private, and only private owner approval publishes", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, channel: "messages", thread: "iMessage;-;taylor@example.test", messageId: "100" });
  await f.records.capture(input);
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "request", name: "Taylor", details: prepare.details, range, question: null, text: "I'll check with Sam.", evidence: input.text }));
  await inbound.handle(input);
  const held = f.records.contact(input.handle)?.meetings[0]; assert.equal(held?.status, "held"); if (held?.status !== "held") return;
  assert.equal(held.origin, "external"); assert.equal(held.approval, "required"); assert.equal(f.ports.events.size, 3);
  assert.ok(f.ports.messages.every(message => message.thread === "owner"));
  await assert.rejects(f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, { kind: "discovery", source: input }));
  assert.equal(meeting.parse(await f.app.run({ action: "approve", meetingId: held.id, revision: 1 }, owner)).status, "sent");
  assert.equal(f.ports.messages.at(-1)?.thread, "group");
});
test("Mac discovery ignores household replies, other-assistant tasks and messages the owner already answered", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, channel: "messages", thread: "iMessage;-;taylor@example.test", messageId: "100", text: "Claro! Vou informar à Lívia que não há uma lista compartilhada e enviar a página Casa & Corpo." });
  await f.records.capture(input);
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "reply", text: "This household task is unrelated.", evidence: input.text }));
  await inbound.handle(input); assert.equal(f.ports.events.size, 0); assert.equal(f.ports.messages.length, 0);
  const request = source.parse({ ...input, messageId: "102", text: guestSource.text }); await f.records.capture(request);
  t.mock.method(f.ports, "research", async () => ({ texts: [{ rowid: 103, is_from_me: true }] }));
  await new Inbound(f.app, async () => assert.fail("The owner already answered this conversation")).handle(request);
  assert.equal(f.ports.events.size, 0); assert.equal(f.ports.messages.length, 0);
});
test("the remembered meeting format is model context and a discovered sender cannot request another contact", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, channel: "messages", thread: "iMessage;-;taylor@example.test", messageId: "100" });
  f.records.remember(preferences.parse({ ...prefs, defaultFormat: "phone" }), ownerSource); await f.records.capture(input);
  const inbound = new Inbound(f.app, async message => {
    assert.equal(JSON.parse(message).context.preferences.defaultFormat, "phone");
    return JSON.stringify({ action: "ignore" });
  });
  await inbound.handle(input);
  await assert.rejects(f.app.run({ ...prepare, contact: { name: "Another person", handle: "other@example.test" } }, { kind: "discovery", source: input }));
  assert.equal(f.records.pages().length, 0);
});
test("Mac discovery baselines history, captures each new sender once and preserves its cursor on a read failure", async t => {
  const f = fixture(t), input = source.parse({ ...guestSource, channel: "messages", thread: "iMessage;-;taylor@example.test", messageId: "101" });
  const inbound = new Inbound(f.app, async () => assert.fail("Discovery capture does not call the model"));
  t.mock.method(f.ports, "archive", async (after: number | null) => after === null ? [{ rowid: 100, source: { ...input, messageId: "100" } }]
    : [{ rowid: 101, source: input }, { rowid: 102, source: null }]);
  await inbound.discover(); assert.equal(f.records.cursor(), 100); assert.equal(f.records.pendingSources().length, 0);
  await inbound.discover(); await inbound.discover();
  assert.equal(f.records.cursor(), 102); assert.equal(f.records.pendingSources().length, 1); assert.equal(f.records.isDiscovered(input), true);
  assert.equal(f.records.isDiscovered({ ...input, text: "forged request" }), false);
  t.mock.method(f.ports, "archive", async () => { throw new Error("Latch disconnected"); });
  await assert.rejects(inbound.discover()); assert.equal(f.records.cursor(), 102); assert.equal(f.records.pendingSources().length, 1);
});
test("a new source cannot re-point an active contact request into another chat or inherit owner-origin authority", async t => {
  const f = fixture(t), held = await f.held(), before = f.records.uncertain();
  await assert.rejects(f.app.run(prepare, { kind: "guest", source: { ...guestSource, thread: "other-group" } }), /another conversation/);
  assert.deepEqual(f.records.uncertain(), before); assert.equal(f.records.find(held.id).source.thread, "owner");
  assert.equal(f.ports.events.size, 3); assert.equal(f.ports.messages.length, 0);
});
test("a changed group roster cannot receive a booking notice or join link for the former contact", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent());
  const before = f.ports.messages.length;
  t.mock.method(f.ports, "groupContact", async () => ({ name: "Someone else", handle: "other@example.test" }));
  await assert.rejects(f.app.publicNotice(booked, "fresh-link", "Verified invitation"), /verified contact/);
  assert.equal(f.ports.messages.length, before);
});
test("a definitively rejected cross-group request is answered naturally, deferred privately and removed from retries", async t => {
  const f = fixture(t), held = await f.held();
  const input = source.parse({ ...guestSource, thread: "other-group", messageId: "cross-group-request" }); f.records.receive(input);
  const inbound = new Inbound(f.app, async () => JSON.stringify({ action: "request", name: "Taylor", details: prepare.details, range, question: null,
    evidence: input.text, text: "I'll check with Sam about this request." }));
  await inbound.handle(input);
  assert.equal(f.records.isHandled(input), true); assert.equal(f.records.uncertain().length, 0);
  assert.equal(f.records.find(held.id).source.thread, "owner"); assert.equal(f.ports.events.size, 3);
  assert.equal(f.ports.messages.at(-1)?.thread, "other-group"); assert.equal(f.ports.messages.at(-1)?.text, "I'll check with Sam about this request.");
  assert.ok(f.ports.messages.some(message => message.thread === "owner"));
});
test("private drafting separates the owner's language sample from this guest's actual request and origin", async t => {
  const f = fixture(t), booked = await f.choose(await f.sent());
  const old = source.parse({ ...ownerSource, messageId: "unrelated-owner-turn", text: "Cancele outra reunião com Quinn." }); f.records.receive(old);
  const input = source.parse({ ...guestSource, messageId: "guest-change", text: "Could we move our meeting to Friday afternoon?" });
  t.mock.method(f.app, "compose", async (context: unknown) => {
    const value = context as { languageSample: string; request: { origin: string; message: string }; conversation?: unknown };
    assert.equal(value.languageSample, old.text); assert.equal(value.request.origin, "external"); assert.equal(value.request.message, input.text);
    assert.equal(value.conversation, undefined);
    return "Taylor asked to move this meeting. Can we change it?";
  });
  await new Inbound(f.app, async () => assert.fail("Only the actual private draft is tested here")).defer(booked, input, "Please approve the guest's move privately.");
  assert.equal(f.ports.messages.at(-1)?.thread, "owner");
});

test("group proposals and updates use the verified guest's current language, excluding the owner and other contacts", async t => {
  const f = fixture(t), contexts: unknown[] = [], privateContexts: unknown[] = [];
  const actor: Actor = { ...owner, mainDm: false, source: { ...ownerSource, thread: "group", text: "Please schedule our meeting." } };
  const currentGuest = source.parse({ ...guestSource, messageId: "current-guest-language", text: "Podemos conversar na próxima semana?" });
  t.mock.method(f.ports, "replies", async () => [
    { ...currentGuest, text: "Can we meet?", at: new Date(now - 86_400_000).toISOString() }, currentGuest,
    { ...currentGuest, owner: true, text: "Speak English to me.", at: new Date(now + 1).toISOString() },
    { ...currentGuest, handle: "someone-else@example.test", text: "My language is English.", at: new Date(now + 2).toISOString() },
  ]);
  t.mock.method(f.app, "compose", async (context: unknown) => {
    if (typeof context === "object" && context !== null && "audience" in context && context.audience === "meeting group") {
      assert.ok("languageSample" in context); assert.equal(context.languageSample, currentGuest.text);
      assert.ok("recipientLanguage" in context); assert.equal(context.recipientLanguage, undefined);
      assert.ok("conversation" in context); assert.equal(context.conversation, undefined);
      assert.ok("recipient" in context); assert.equal(context.recipient, "Taylor"); contexts.push(context);
    }
    if (typeof context === "object" && context !== null && "audience" in context && context.audience === "private owner") {
      assert.ok("status" in context); assert.equal(context.status, "confirmed");
      assert.ok("facts" in context); assert.match(String(context.facts), /calendar verified the invitation/); privateContexts.push(context);
    }
    return "Mensagem escrita pelo modelo para Taylor.";
  });
  await f.app.run({ ...prepare, contact: { ...prepare.contact, language: "English" } }, actor);
  const held = f.records.contact(prepare.contact.handle)?.meetings.at(-1); assert.ok(held);
  await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, actor);
  await f.app.run({ action: "repropose", meetingId: held.id, revision: 1, range: prepare.range }, actor);
  await f.app.run({ action: "choose", meetingId: held.id, revision: 2, option: 1 }, actor);
  assert.equal(contexts.length, 3); assert.equal(f.ports.messages.filter(message => message.thread === "group").length, 3);
  assert.equal(privateContexts.length, 1);
});

test("a newly opened group uses the researched guest language without exposing the private owner request", async t => {
  const f = fixture(t);
  const actor: Actor = { ...owner, source: { ...ownerSource, text: "A private owner request with personal context." } };
  t.mock.method(f.app, "compose", async (context: unknown) => {
    assert.ok(typeof context === "object" && context !== null);
    assert.ok("recipientLanguage" in context); assert.equal(context.recipientLanguage, "Portuguese");
    assert.ok("conversation" in context); assert.equal(context.conversation, undefined);
    return "Taylor, qual destes horários funciona para você?";
  });
  const held = meeting.parse(await f.app.run({ ...prepare, contact: { ...prepare.contact, language: "Portuguese" } }, actor));
  await f.app.run({ action: "publish", meetingId: held.id, revision: 1 }, actor);
  assert.equal(f.ports.messages[0]?.thread, "group");
});

test("an owner choice and its native final reply share one durable private confirmation across restart", async t => {
  const f = fixture(t), sent = await f.sent();
  const input = source.parse({ ...ownerSource, thread: "group", messageId: "owner-group-choice", text: "Pode confirmar a primeira opção para esse teste." });
  const actor: Actor = { ...owner, source: input, mainDm: false };
  const booked = await f.app.run({ action: "choose", meetingId: sent.id, revision: 1, option: 1 }, actor);
  assert.ok(booked);
  const confirmation = f.ports.messages.filter(value => value.thread === "owner");
  assert.equal(confirmation.length, 1);
  await f.app.sendReply("owner", input, "A redundant final answer from the host model.");
  f.records.close();
  const recovered = new Records(f.root);
  const restarted = new Scheduling(recovered, f.ports, compose, () => now);
  try { await restarted.sendReply("owner", input, "Another final answer after restart."); }
  finally { recovered.close(); }
  assert.equal(f.ports.messages.filter(value => value.thread === "owner").length, 1);
  assert.equal(f.ports.messages.filter(value => value.thread === "group").length, 2, "The actual proposal and booking notice remain public");
});
