import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { instant, toBusy } from "../skills/meetly/scripts/busy.ts";
import { writeJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const TZ = "America/Sao_Paulo";
const FIX = join(import.meta.dirname, "fixtures", "calendar");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"));
const opts = { tz: TZ, max: 100 };

test("instant reads dates as local midnight and rejects junk", () => {
  assert.equal(new Date(instant("2026-09-30", TZ)).toISOString(), "2026-09-30T03:00:00.000Z");
  assert.equal(new Date(instant("2026-09-28T10:00:00-03:00", TZ)).toISOString(), "2026-09-28T13:00:00.000Z");
  assert.throws(() => instant("tomorrow", TZ));
});

test("fan-out: transparent and declined are skipped, all-day covers the local day", () => {
  const r = toBusy([fixture("fanout.json")], opts);
  assert.deepEqual(r, {
    busy: [
      { start: "2026-09-28T13:00:00.000Z", end: "2026-09-28T13:30:00.000Z", id: "ev1", account: "owner@example.com" },
      { start: "2026-09-29T12:00:00.000Z", end: "2026-09-29T13:00:00.000Z", id: "ev6", account: "work@example.com" },
      { start: "2026-09-30T03:00:00.000Z", end: "2026-10-01T03:00:00.000Z", id: "ev4", account: "owner@example.com" },
    ],
    degraded: [],
  });
});

test("the raw Google shape: cancelled and self-declined are skipped", () => {
  const r = toBusy([fixture("single.json")], opts);
  assert.deepEqual(r.busy.map((b) => b.id), ["g1", "g4"]);
  assert.deepEqual(r.busy[0], { start: "2026-09-29T15:00:00.000Z", end: "2026-09-29T16:00:00.000Z", id: "g1" });
});

test("a multi-day all-day event blocks every day it spans", () => {
  const r = toBusy([fixture("single.json")], opts);
  const vacation = r.busy.find((b) => b.id === "g4")!;
  assert.equal(vacation.start, "2026-10-05T03:00:00.000Z");
  assert.equal(vacation.end, "2026-10-08T03:00:00.000Z");
  const multi = toBusy([[{ id: "v", startLocal: "2026-10-05", endLocal: "2026-10-10", allDay: true }]], opts);
  assert.deepEqual(multi.busy, [{ start: "2026-10-05T03:00:00.000Z", end: "2026-10-10T03:00:00.000Z", id: "v" }]);
});

test("truncated.after sets unknownAfter, earliest wins", () => {
  const a = toBusy([{ items: [], truncated: { omitted: 4, after: "2026-10-02" } }], opts);
  assert.equal(a.unknownAfter, "2026-10-02T03:00:00.000Z");
  const b = toBusy([
    { items: [], truncated: { omitted: 1, after: "2026-10-03T12:00:00-03:00" } },
    { items: [], truncated: { omitted: 1, after: "2026-10-01T09:00:00-03:00" } },
  ], opts);
  assert.equal(b.unknownAfter, "2026-10-01T12:00:00.000Z");
});

test("an account at max items: unknown after its last start", () => {
  const items = [
    { id: "1", startLocal: "2026-09-28T10:00:00-03:00", endLocal: "2026-09-28T11:00:00-03:00", account: "a" },
    { id: "2", startLocal: "2026-09-29T10:00:00-03:00", endLocal: "2026-09-29T11:00:00-03:00", account: "a" },
    { id: "3", startLocal: "2026-09-28T12:00:00-03:00", endLocal: "2026-09-28T13:00:00-03:00", account: "b" },
  ];
  const r = toBusy([{ items }], { tz: TZ, max: 2 });
  assert.equal(r.unknownAfter, "2026-09-29T13:00:00.000Z");
  assert.equal(toBusy([{ items }], { tz: TZ, max: 3 }).unknownAfter, undefined);
  const single = toBusy([{ events: [items[0], items[1]].map(({ account: _a, ...e }) => e) }], { tz: TZ, max: 2 });
  assert.equal(single.unknownAfter, "2026-09-29T13:00:00.000Z");
});

test("degraded accounts are reported as strings", () => {
  const r = toBusy([{ items: [], degraded: ["a@example.com", { account: "b@example.com", error: "401" }, { error: "x" }] }], opts);
  assert.deepEqual(r.degraded, ["a@example.com", "b@example.com", '{"error":"x"}']);
});

test("the CLI merges several files using the configured zone", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { timezone: TZ, setupDoneAt: "2026-09-26T00:00:00Z" });
  const r = cli("busy.ts", ["--in", join(FIX, "fanout.json"), "--in", join(FIX, "single.json")], { MEETLY_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.busy.map((b: { id: string }) => b.id), ["ev1", "ev6", "g1", "ev4", "g4"]);
  const stdin = cli("busy.ts", [], { MEETLY_HOME: home }, readFileSync(join(FIX, "single.json"), "utf8"));
  assert.equal(stdin.json.busy.length, 2);
  const noSetup = cli("busy.ts", ["--in", join(FIX, "fanout.json")], { MEETLY_HOME: tmpHome() });
  assert.equal(noSetup.status, 1);
});
