import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_NOTICE_MIN, parseField, type Config } from "../skills/meetly/scripts/config.ts";
import { finish, record } from "../skills/meetly/scripts/record-setup.ts";
import { checkTime, findSlots } from "../skills/meetly/scripts/slots.ts";
import { readJson } from "../skills/meetly/scripts/store.ts";
import { tmpHome } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const flat = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
const CONFIG: Config = {
  ownerName: "Jean", timezone: "America/Sao_Paulo", days: ["mon", "tue", "wed", "thu", "fri"], windowStart: "09:00", windowEnd: "18:00",
  durationMin: 30, horizonDays: 7, calendars: [{ account: "jean@example.com", id: "jean@example.com" }], defaultAccount: "jean@example.com",
  setupDoneAt: "2026-09-26T12:00:00.000Z",
};
// Monday 08:00 in the owner's zone.
const NOW = Date.parse("2026-09-28T08:00:00-03:00");
const first = (minNoticeMin?: number) =>
  findSlots({ now: NOW, config: minNoticeMin === undefined ? CONFIG : { ...CONFIG, minNoticeMin }, busy: [] }).slots[0]!.start;

test("the notice is a number of hours or minutes, 2 hours by default, and default clears it", () => {
  assert.equal(MIN_NOTICE_MIN, 120);
  for (const [value, minutes] of [["3", 180], ["3h", 180], ["3 hours", 180], ["1.5h", 90], ["45m", 45], ["45 min", 45], ["0", 0], [" 24h ", 1440]] as const) {
    assert.deepEqual(parseField("minNotice", value), { minNoticeMin: minutes }, value);
  }
  assert.deepEqual(parseField("minNotice", "default"), { minNoticeMin: undefined });
  for (const bad of ["soon", "-1", "73h", "", "2 days"]) assert.throws(() => parseField("minNotice", bad), /notice/, bad);
});

test("offers start at least the owner's notice ahead, on the same day when they allow it", () => {
  assert.equal(first(), "2026-09-28T10:00:00-03:00");
  assert.equal(first(0), "2026-09-28T09:00:00-03:00");
  assert.equal(first(180), "2026-09-28T11:00:00-03:00");
  assert.equal(first(24 * 60), "2026-09-29T09:00:00-03:00");
});

test("a time the other person asks for is too soon only inside the owner's notice", () => {
  const at = (minNoticeMin?: number) => checkTime({ now: NOW, config: minNoticeMin === undefined ? CONFIG : { ...CONFIG, minNoticeMin }, busy: [], start: "2026-09-28T09:30:00-03:00" });
  assert.equal(at().reason, "too-soon");
  assert.equal(at(60).free, true);
  assert.equal(at(120).reason, "too-soon");
});

test("the notice is kept in config.json after setup and cleared with default", () => {
  const home = tmpHome();
  process.env.MEETLY_HOME = home;
  record("ownerName", "Jean");
  record("timezone", "America/Sao_Paulo");
  record("calendars", JSON.stringify({ defaultAccount: "jean@example.com", calendars: [] }));
  finish(() => ({}), Date.parse("2026-09-26T12:00:00Z"));
  assert.equal("minNoticeMin" in readJson<object>(join(home, "config.json"), {}), false);
  record("minNotice", "1h");
  assert.equal(readJson<{ minNoticeMin?: number }>(join(home, "config.json"), {}).minNoticeMin, 60);
  record("minNotice", "default");
  assert.equal("minNoticeMin" in readJson<object>(join(home, "config.json"), {}), false);
});

test("the owner can set their notice by saying so, and the README names the default", () => {
  const setup = flat("skills/meetly-setup/SKILL.md");
  assert.ok(setup.includes("`record-setup.ts --field minNotice --value <hours, like 3h>`"));
  assert.ok(setup.includes("`0` allows a time right away"));
  assert.ok(flat("README.md").includes("at least 2 hours ahead"));
});
