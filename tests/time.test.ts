import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, DAYS, localIso, offsetMs, wallParts, zonedToUtc } from "../skills/meetly/scripts/time.ts";

test("DAYS is in week order starting Monday", () => {
  assert.deepEqual(DAYS, ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
});

test("Sao Paulo wall time converts to UTC and back", () => {
  const ms = zonedToUtc(2026, 9, 28, 10, 0, "America/Sao_Paulo");
  assert.equal(new Date(ms).toISOString(), "2026-09-28T13:00:00.000Z");
  assert.equal(localIso(ms, "America/Sao_Paulo"), "2026-09-28T10:00:00-03:00");
  assert.equal(offsetMs(ms, "America/Sao_Paulo"), -3 * 3600_000);
});

test("Los Angeles across the end of daylight saving", () => {
  const pdt = zonedToUtc(2026, 10, 31, 9, 0, "America/Los_Angeles");
  const pst = zonedToUtc(2026, 11, 1, 9, 0, "America/Los_Angeles");
  assert.equal(new Date(pdt).toISOString(), "2026-10-31T16:00:00.000Z");
  assert.equal(new Date(pst).toISOString(), "2026-11-01T17:00:00.000Z");
  assert.equal(localIso(pst, "America/Los_Angeles"), "2026-11-01T09:00:00-08:00");
});

test("wallParts gives the local weekday and fields", () => {
  const p = wallParts(Date.parse("2026-09-28T13:05:07Z"), "America/Sao_Paulo");
  assert.deepEqual(p, { y: 2026, m: 9, d: 28, hh: 10, mm: 5, ss: 7, weekday: "mon" });
  assert.equal(wallParts(Date.parse("2026-09-28T02:00:00Z"), "America/Sao_Paulo").weekday, "sun");
});

test("localIso handles UTC and positive offsets", () => {
  assert.equal(localIso(Date.parse("2026-09-28T00:00:00Z"), "UTC"), "2026-09-28T00:00:00+00:00");
  assert.equal(localIso(Date.parse("2026-09-28T00:00:00Z"), "Asia/Kolkata"), "2026-09-28T05:30:00+05:30");
});

test("addDays crosses month and year ends", () => {
  assert.deepEqual(addDays(2026, 9, 29, 3), { y: 2026, m: 10, d: 2 });
  assert.deepEqual(addDays(2026, 12, 31, 1), { y: 2027, m: 1, d: 1 });
  assert.deepEqual(addDays(2026, 3, 1, -1), { y: 2026, m: 2, d: 28 });
});
