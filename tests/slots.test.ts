import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Config } from "../skills/meetly/scripts/config.ts";
import { findSlots, type SlotQuery } from "../skills/meetly/scripts/slots.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const CONFIG: Config = {
  ownerName: "Jean",
  timezone: "America/Sao_Paulo",
  days: ["mon", "tue", "wed", "thu", "fri"],
  windowStart: "09:00",
  windowEnd: "18:00",
  durationMin: 30,
  horizonDays: 7,
  calendars: [{ account: "jean@example.com", id: "primary" }],
  defaultAccount: "jean@example.com",
  setupDoneAt: "2026-09-26T12:00:00.000Z",
};
const NOW = Date.parse("2026-09-28T08:00:00-03:00");
const q = (over: Partial<SlotQuery> = {}): SlotQuery => ({ now: NOW, config: CONFIG, busy: [], ...over });
const starts = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.start);
const labels = (over: Partial<SlotQuery> = {}) => findSlots(q(over)).slots.map((s) => s.label);

test("no busy: spread over the first days, after the minimum notice", () => {
  const { slots, unknownAfter } = findSlots(q());
  assert.deepEqual(slots, [
    { start: "2026-09-28T10:00:00-03:00", end: "2026-09-28T10:30:00-03:00", dayOfWeek: "mon", label: "mon 28/9 10:00" },
    { start: "2026-09-29T09:00:00-03:00", end: "2026-09-29T09:30:00-03:00", dayOfWeek: "tue", label: "tue 29/9 09:00" },
    { start: "2026-09-30T09:00:00-03:00", end: "2026-09-30T09:30:00-03:00", dayOfWeek: "wed", label: "wed 30/9 09:00" },
  ]);
  assert.equal(unknownAfter, undefined);
});

test("busy time is skipped unless its event may be overlapped", () => {
  const busy = [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly" }];
  assert.equal(starts({ busy })[0], "2026-09-28T11:00:00-03:00");
  assert.equal(starts({ busy, allowOverlap: ["weekly"] })[0], "2026-09-28T10:00:00-03:00");
});

test("weekends and after-hours are skipped", () => {
  assert.deepEqual(labels({ now: Date.parse("2026-10-02T17:00:00-03:00") }), ["mon 5/10 09:00", "tue 6/10 09:00", "wed 7/10 09:00"]);
});

test("request days intersect the config days and after narrows the window", () => {
  assert.deepEqual(labels({ days: ["thu"], after: "13:00" }), ["thu 1/10 13:00", "thu 1/10 13:30", "thu 1/10 14:00"]);
  assert.deepEqual(labels({ days: ["thu"], after: "13:10", before: "14:00" }), ["thu 1/10 13:30"]);
});

test("only the owner can go outside the configured days", () => {
  assert.deepEqual(starts({ days: ["sat"] }), []);
  assert.deepEqual(labels({ days: ["sat"], ownerOverride: true }), ["sat 3/10 09:00", "sat 3/10 09:30", "sat 3/10 10:00"]);
  assert.deepEqual(labels({ days: ["mon"], after: "19:00", before: "21:00", ownerOverride: true, count: 1 }), ["mon 28/9 19:00"]);
});

test("excluded starts are not offered", () => {
  assert.equal(starts({ exclude: ["2026-09-28T13:00:00.000Z"] })[0], "2026-09-28T10:30:00-03:00");
});

test("nothing is offered past the end of what was read", () => {
  const r = findSlots(q({ unknownAfter: "2026-09-29T09:15:00-03:00" }));
  assert.deepEqual(r.slots.map((s) => s.label), ["mon 28/9 10:00", "mon 28/9 10:30", "mon 28/9 11:00"]);
  assert.equal(r.unknownAfter, "2026-09-29T09:15:00-03:00");
});

test("a date range narrows a longer horizon", () => {
  const config = { ...CONFIG, horizonDays: 14 };
  const r = findSlots(q({ config, from: "2026-10-05", to: "2026-10-06" }));
  assert.deepEqual(r.slots.map((s) => s.label), ["mon 5/10 09:00", "mon 5/10 09:30", "tue 6/10 09:00"]);
});

test("a long meeting must end inside the window", () => {
  const busy = [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T20:00:00.000Z" }];
  assert.deepEqual(starts({ busy, durationMin: 60, days: ["mon"], count: 1 }), ["2026-09-28T17:00:00-03:00"]);
});

test("daylight saving ends: 09:00 stays 09:00 local", () => {
  const config: Config = {
    ...CONFIG,
    timezone: "America/Los_Angeles",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    windowStart: "09:00",
    windowEnd: "10:00",
    horizonDays: 5,
  };
  const r = findSlots({ now: Date.parse("2026-10-30T12:00:00-07:00"), config, busy: [], durationMin: 60 });
  assert.deepEqual(r.slots.map((s) => s.start), [
    "2026-10-31T09:00:00-07:00",
    "2026-11-01T09:00:00-08:00",
    "2026-11-02T09:00:00-08:00",
  ]);
});

test("labels follow the other person's locale", () => {
  assert.deepEqual(labels({ locale: "pt-BR" }), ["seg., 28/09, 10:00", "ter., 29/09, 09:00", "qua., 30/09, 09:00"]);
  assert.deepEqual(labels({ locale: "en-US", count: 1 }), ["Mon, 9/28, 10:00 AM"]);
  assert.deepEqual(labels({ locale: "de-DE", count: 1 }), ["Mo., 28.9., 10:00"]);
  assert.equal(findSlots(q({ locale: "en-US" })).slots[0]!.dayOfWeek, "mon");
  assert.throws(() => findSlots(q({ locale: "not a locale!" })), /unknown locale/);
});

test("the CLI reads busy.ts output and the stored config", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), CONFIG);
  const busyFile = join(home, "busy.json");
  writeFileSync(busyFile, JSON.stringify({
    busy: [{ start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T14:00:00.000Z", id: "weekly" }],
    degraded: ["other@example.com"],
  }));
  const env = { MEETLY_HOME: home };
  const now = ["--now", "2026-09-28T08:00:00-03:00"];
  const r = cli("slots.ts", ["--in", busyFile, ...now], env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.slots[0].start, "2026-09-28T11:00:00-03:00");
  assert.deepEqual(r.json.degraded, ["other@example.com"]);
  const allowed = cli("slots.ts", ["--in", busyFile, ...now, "--allow-overlap", "weekly", "--count", "1"], env);
  assert.deepEqual(allowed.json.slots.map((s: { label: string }) => s.label), ["mon 28/9 10:00"]);
  const owner = cli("slots.ts", ["--in", busyFile, ...now, "--days", "sat", "--owner", "--duration", "60"], env);
  assert.equal(owner.json.slots[0].end, "2026-10-03T10:00:00-03:00");
  const us = cli("slots.ts", ["--in", busyFile, ...now, "--locale", "en-US", "--count", "1"], env);
  assert.deepEqual(us.json.slots.map((s: { label: string }) => s.label), ["Mon, 9/28, 11:00 AM"]);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--locale", "??"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--days", "someday"], env).status, 1);
  assert.equal(cli("slots.ts", ["--in", busyFile, "--from", "5/10"], env).status, 1);
});
