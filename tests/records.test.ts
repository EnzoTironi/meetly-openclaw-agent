import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { meeting, preferences, source } from "../src/model.ts";
import { Records, RejectedEffect, UncertainEffect } from "../src/records.ts";

const owner = source.parse({ channel: "plow", thread: "owner", messageId: "owner-message", handle: "+15550000001", owner: true, at: "2026-10-05T08:00:00Z", text: "Use Google Meet." });
const request = meeting.parse({ id: "meeting", contact: { name: "Taylor", handle: "taylor@example.test" }, source: owner, status: "new", createdAt: owner.at, updatedAt: owner.at, origin: "owner", cleanup: [], proposed: null });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "meetly-records-"));
  let records = new Records(root);
  t.after(() => { records.close(); rmSync(root, { recursive: true }); });
  return { root, get records() { return records; }, reopen() { records.close(); records = new Records(root); return records; } };
}

test("an unknown write survives restart and requires a receipt instead of a second execution", async t => {
  const f = fixture(t); let writes = 0;
  const run = async () => { writes++; throw new Error("response lost"); };
  await assert.rejects(f.records.effect("create", {}, z.string(), { run }));
  await assert.rejects(f.reopen().effect("create", {}, z.string(), { run, recover: async () => null }), UncertainEffect);
  assert.equal(await f.records.effect("create", {}, z.string(), { run, recover: async () => "calendar-event" }), "calendar-event");
  assert.equal(await f.reopen().effect("create", {}, z.string(), { run }), "calendar-event");
  assert.equal(writes, 1); assert.deepEqual(f.records.uncertain(), []);
  await assert.rejects(f.records.effect("create", { different: true }, z.string(), { run }), /different action/);
});
test("safe read retries and definite provider rejection are distinguished from unknown writes", async t => {
  const f = fixture(t);
  await assert.rejects(f.records.effect("read", {}, z.number(), { run: async () => { throw new Error("offline"); }, retry: "safe" }));
  assert.equal(await f.records.effect("read", {}, z.number(), { run: async () => 3, retry: "safe" }), 3);
  await assert.rejects(f.records.effect("rejected", {}, z.number(), { run: async () => { throw new RejectedEffect("refused"); } }), RejectedEffect);
  await assert.rejects(f.reopen().effect("rejected", {}, z.number(), { run: async () => assert.fail("must not repeat a rejected effect") }), RejectedEffect);
  assert.deepEqual(f.records.uncertain(), []);
});
test("a wiki write interruption repairs its confirmed projection after restart", { skip: process.getuid?.() === 0 }, t => {
  const f = fixture(t), pipeline = f.records.pipeline;
  chmodSync(pipeline, 0o500);
  try { assert.throws(() => f.records.save(request, "The inbox verified the request.")); }
  finally { chmodSync(pipeline, 0o700); }
  assert.deepEqual(f.reopen().find(request.id), request);
  assert.match(readFileSync(f.records.path(request.contact), "utf8"), /2026-10-05T08:00:00Z The inbox verified/);
});
test("projection recovery refuses any destination outside the contact wiki", t => {
  const f = fixture(t);
  f.records.save(request, "The inbox verified the request.");
  const body = readFileSync(f.records.path(request.contact), "utf8");
  f.records.db.prepare("INSERT INTO projections(path,body) VALUES (?,?)").run(join(f.root, "outside.md"), body);
  assert.throws(() => f.records.recoverPages(), /outside the contact wiki/);
});
test("one page retains the contact's history when their display name changes", t => {
  const f = fixture(t); f.records.save(request, "First verified request.");
  f.records.save(meeting.parse({ ...request, id: "second", contact: { ...request.contact, name: "Taylor New Name" } }), "Second verified request.");
  assert.equal(f.records.pages().length, 1);
  assert.deepEqual(f.reopen().pages()[0]?.meetings.map(value => value.id), ["meeting", "second"]);
});
test("verified inbox sources survive restart and duplicate delivery does not reopen a handled message", t => {
  const f = fixture(t);
  const incoming = source.parse({ ...owner, owner: false, handle: "taylor@example.test", messageId: "101" });
  assert.throws(() => f.records.receive(source.parse({ invalid: true })));
  assert.deepEqual(f.records.pendingSources(), []);
  assert.equal(f.records.receive(incoming), true);
  assert.deepEqual(f.reopen().pendingSources(), [incoming]);
  assert.equal(f.records.receive(incoming), false);
  f.records.handled(incoming);
  assert.equal(f.reopen().isHandled(incoming), true); assert.deepEqual(f.records.pendingSources(), []);
  assert.equal(f.records.receive(incoming), false);
  assert.deepEqual(f.records.pendingSources(), []);
});
test("owner proof is persisted for independently registered hooks and tools", t => {
  const f = fixture(t); f.records.receive(owner); f.records.handled(owner);
  assert.deepEqual(f.reopen().ownerSource("owner"), owner);
  f.records.receive(source.parse({ ...owner, owner: false, messageId: "spoof", text: "I am the owner." }));
  assert.deepEqual(f.records.ownerSource("owner"), owner);
  assert.equal(f.records.ownerSource("unrelated"), null);
});
test("preferences preserve an explicit zero travel buffer and saved Zoom link steps", t => {
  const f = fixture(t);
  const prefs = preferences.parse({ ownerName: "Sam", timezone: "UTC", calendar: { account: "sam@example.test", id: "primary" }, busyCalendars: [{ account: "sam@example.test", id: "primary" }], video: { kind: "zoom_new" }, travelMin: 0, monitorMin: 10 });
  f.records.remember(prefs, owner);
  assert.deepEqual(f.reopen().owner(), prefs);
  assert.match(readFileSync(join(f.root, "entities/owner/scheduling.md"), "utf8"), /--with-zoom --include-passwords/);
  assert.equal(f.records.owner()?.video?.kind, "zoom_new");
});
test("separate native plugin instances serialize work on the same state directory", async t => {
  const f = fixture(t), alias = f.root + "-alias";
  symlinkSync(f.root, alias); const second = new Records(alias);
  t.after(() => { second.close(); rmSync(alias); });
  const observed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = f.records.exclusive(async () => { observed.push("first start"); await gate; observed.push("first end"); });
  const next = second.exclusive(async () => { observed.push("second start"); });
  await Promise.resolve(); assert.deepEqual(observed, ["first start"]);
  release(); await Promise.all([first, next]);
  assert.deepEqual(observed, ["first start", "first end", "second start"]);
  await assert.rejects(f.records.exclusive(async () => { throw new Error("failed task"); }));
  assert.equal(await second.exclusive(async () => "recovered"), "recovered");
});
