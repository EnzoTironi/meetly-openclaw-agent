import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FIELDS, holdHours, parseField, parseTime, readableCalendars, validateConfig, type Config } from "../skills/meetly/scripts/config.ts";
import { finish, record } from "../skills/meetly/scripts/record-setup.ts";
import { status, statusFilling } from "../skills/meetly/scripts/setup-status.ts";
import { readJson } from "../skills/meetly/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const CALENDARS = JSON.stringify({ defaultAccount: "jean@example.com", calendars: [{ account: "jean@example.com", id: "work@group.calendar.google.com" }] });
const ANSWERS: [string, string][] = [
  ["ownerName", "Jean"],
  ["timezone", "America/Sao_Paulo"],
  ["days", "mon,tue,wed,thu,fri"],
  ["window", "09:00-18:00"],
  ["durationMin", "30"],
  ["horizonDays", "7"],
  ["calendars", CALENDARS],
];

function withHome<R>(fn: (home: string) => R): R {
  const saved = process.env.MEETLY_HOME;
  const home = tmpHome();
  process.env.MEETLY_HOME = home;
  try {
    return fn(home);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
}

test("empty home needs setup, starting with the owner's name", () => {
  withHome(() => {
    const s = status();
    assert.equal(s.status, "SETUP_NEEDED");
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "ownerName");
    assert.equal(s.status === "SETUP_NEEDED" && s.question, "When I talk to other people for you, I write about you by name, like \"Ana is free at 3pm\". What name should I use?");
  });
});

test("recording the seven fields in order walks the questions", () => {
  withHome(() => {
    const seen: (string | null)[] = [];
    for (const [field, value] of ANSWERS) {
      const out = record(field, value);
      assert.ok("next" in out);
      seen.push(out.next);
    }
    assert.deepEqual(seen, [...FIELDS.slice(1), null]);
    const s = status();
    assert.equal(s.status === "SETUP_NEEDED" && s.next, null);
  });
});

test("days are normalized to week order", () => {
  assert.deepEqual(parseField("days", "Mon, Tue ,wed"), { days: ["mon", "tue", "wed"] });
  assert.deepEqual(parseField("days", "friday monday Friday"), { days: ["mon", "fri"] });
  assert.throws(() => parseField("days", "funday"));
  assert.throws(() => parseField("days", " , "));
});

test("windows in natural form are accepted, backwards ones rejected", () => {
  const w = (v: string) => parseField("window", v);
  assert.deepEqual(w("9-18"), { windowStart: "09:00", windowEnd: "18:00" });
  assert.deepEqual(w("9h-18h"), { windowStart: "09:00", windowEnd: "18:00" });
  assert.deepEqual(w("09:00–18:00"), { windowStart: "09:00", windowEnd: "18:00" });
  assert.deepEqual(w("9:30 to 17"), { windowStart: "09:30", windowEnd: "17:00" });
  assert.deepEqual(w("9h30 até 17h"), { windowStart: "09:30", windowEnd: "17:00" });
  assert.deepEqual(w("10 a 16"), { windowStart: "10:00", windowEnd: "16:00" });
  assert.throws(() => w("18-9"));
  assert.throws(() => w("9"));
  assert.throws(() => w("9-25"));
});

test("parseTime accepts the documented shapes", () => {
  assert.equal(parseTime("9"), "09:00");
  assert.equal(parseTime("9h"), "09:00");
  assert.equal(parseTime("9:30"), "09:30");
  assert.equal(parseTime("9h30"), "09:30");
  assert.equal(parseTime("09:00"), "09:00");
  assert.throws(() => parseTime("9:75"));
});

test("an unknown time zone fails through the CLI", () => {
  const r = cli("record-setup.ts", ["--field", "timezone", "--value", "Mars/Olympus"], { MEETLY_HOME: tmpHome() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown time zone/);
  assert.equal(r.stdout, "");
});

test("durations and horizons are bounded integers", () => {
  assert.throws(() => parseField("durationMin", "5"));
  assert.throws(() => parseField("durationMin", "abc"));
  assert.throws(() => parseField("durationMin", "241"));
  assert.deepEqual(parseField("durationMin", "45"), { durationMin: 45 });
  assert.throws(() => parseField("horizonDays", "0"));
  assert.throws(() => parseField("horizonDays", "31"));
  assert.deepEqual(parseField("horizonDays", "14"), { horizonDays: 14 });
});

test("calendars always include the default account's primary, by the id the events listing takes", () => {
  assert.deepEqual(parseField("calendars", CALENDARS), {
    defaultAccount: "jean@example.com",
    calendars: [
      { account: "jean@example.com", id: "work@group.calendar.google.com" },
      { account: "jean@example.com", id: "jean@example.com" },
    ],
  });
  // `primary` and the account's address are the same calendar: one entry, never the alias.
  for (const ids of [["primary"], ["a@x"], ["a@x", "primary"], ["primary", "a@x"]]) {
    const value = JSON.stringify({ defaultAccount: "a@x", calendars: ids.map((id) => ({ account: "a@x", id })) });
    assert.deepEqual(parseField("calendars", value).calendars, [{ account: "a@x", id: "a@x" }], JSON.stringify(ids));
  }
  assert.deepEqual(readableCalendars([{ account: "b@x", id: "primary" }], "a@x"),
    [{ account: "b@x", id: "b@x" }, { account: "a@x", id: "a@x" }]);
  assert.throws(() => parseField("calendars", "not json"));
  assert.throws(() => parseField("calendars", JSON.stringify({ defaultAccount: "", calendars: [] })));
  assert.throws(() => parseField("calendars", JSON.stringify({ defaultAccount: "a@x", calendars: [{ account: "a@x" }] })));
});

test("a duration longer than the window is rejected", () => {
  const draft: Partial<Config> = {};
  for (const [f, v] of ANSWERS) Object.assign(draft, parseField(f, v));
  Object.assign(draft, parseField("window", "9-10"), parseField("durationMin", "90"));
  assert.throws(() => validateConfig(draft), /longer than/);
});

test("finish writes config, removes the draft, registers once", () => {
  withHome((home) => {
    for (const [f, v] of ANSWERS) record(f, v);
    let calls = 0;
    const out = finish(() => { calls++; return { paused: false, actions: [] }; }, Date.parse("2026-09-26T12:00:00Z"));
    assert.equal(calls, 1);
    assert.equal(out.done, true);
    const config = readJson<Config | null>(join(home, "config.json"), null);
    assert.equal(config?.setupDoneAt, "2026-09-26T12:00:00.000Z");
    assert.equal(existsSync(join(home, "config.draft.json")), false);
    finish(() => { calls++; }, Date.now());
    assert.equal(calls, 2);
  });
});

test("finish keeps config.json when registration fails", () => {
  withHome((home) => {
    for (const [f, v] of ANSWERS) record(f, v);
    assert.throws(() => finish(() => { throw new Error("scheduler down"); }, Date.now()), /scheduler down/);
    assert.ok(readJson<Config | null>(join(home, "config.json"), null)?.setupDoneAt);
  });
});

test("finish refuses an incomplete draft", () => {
  withHome(() => {
    record("ownerName", "Jean");
    assert.throws(() => finish(() => undefined, Date.now()));
  });
});

test("editing a field after setup updates config.json and keeps setupDoneAt", () => {
  withHome((home) => {
    for (const [f, v] of ANSWERS) record(f, v);
    finish(() => undefined, Date.parse("2026-09-26T12:00:00Z"));
    const out = record("window", "10-17");
    assert.ok("config" in out);
    const config = readJson<Config | null>(join(home, "config.json"), null)!;
    assert.equal(config.windowStart, "10:00");
    assert.equal(config.windowEnd, "17:00");
    assert.equal(config.setupDoneAt, "2026-09-26T12:00:00.000Z");
    assert.throws(() => record("durationMin", "600"));
    assert.throws(() => record("color", "blue"), /unknown field/);
  });
});

test("READY carries the calendar range in the owner's zone", () => {
  withHome(() => {
    for (const [f, v] of ANSWERS) record(f, v);
    finish(() => undefined, Date.parse("2026-09-26T12:00:00Z"));
    const s = status(Date.parse("2026-09-28T11:00:00Z"));
    assert.equal(s.status, "READY");
    assert.deepEqual(s.status === "READY" && s.range, { from: "2026-09-28T08:00:00-03:00", to: "2026-10-06T08:00:00-03:00" });
  });
});

test("the CLI walks setup and finishes", () => {
  const home = tmpHome();
  const first = cli("setup-status.ts", [], { MEETLY_HOME: home });
  assert.equal(first.json.status, "SETUP_NEEDED");
  const r = cli("record-setup.ts", ["--field", "ownerName", "--value", "Jean"], { MEETLY_HOME: home });
  assert.equal(r.status, 0);
  assert.equal(r.json.next, "timezone");
  const done = cli("record-setup.ts", ["--done"], { MEETLY_HOME: home });
  assert.equal(done.status, 1);
  assert.match(done.stderr, /^error: /);
});

test("hold hours default to 48 and accept an override", () => {
  const saved = process.env.MEETLY_HOLD_HOURS;
  try {
    delete process.env.MEETLY_HOLD_HOURS;
    assert.equal(holdHours(), 48);
    process.env.MEETLY_HOLD_HOURS = "0.1";
    assert.equal(holdHours(), 0.1);
    process.env.MEETLY_HOLD_HOURS = "-1";
    assert.equal(holdHours(), 48);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOLD_HOURS;
    else process.env.MEETLY_HOLD_HOURS = saved;
  }
});

test("the owner's Plow profile name answers the first question, so setup starts at the time zone", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    const s = await statusFilling({ ownerName: async () => "  Jean Jacintho " });
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "timezone");
    assert.equal(s.status === "SETUP_NEEDED" && s.draft.ownerName, "Jean Jacintho");
    // Once filled it is not looked up again, and the owner can still change it.
    const again = await statusFilling({ ownerName: async () => { throw new Error("not called"); } });
    assert.equal(again.status === "SETUP_NEEDED" && again.next, "timezone");
    record("ownerName", "Jean");
    assert.equal(status().status === "SETUP_NEEDED" && (status() as { draft: { ownerName?: string } }).draft.ownerName, "Jean");
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("with no name on Plow, or Plow unreachable, the owner is asked", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    for (const lookup of [async () => undefined, async () => "   ", async () => { throw new Error("down"); }]) {
      const s = await statusFilling({ ownerName: lookup });
      assert.equal(s.status === "SETUP_NEEDED" && s.next, "ownerName");
    }
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("the Mac's time zone answers its question right after the name, so setup starts at the days", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    const s = await statusFilling({ ownerName: async () => "Ana Lima", timezone: async () => "America/Sao_Paulo" });
    assert.equal(s.status === "SETUP_NEEDED" && s.next, "days");
    assert.deepEqual(s.status === "SETUP_NEEDED" && [s.draft.ownerName, s.draft.timezone], ["Ana Lima", "America/Sao_Paulo"]);
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("a Mac that cannot answer, or answers something that is not a zone, leaves the question to the owner", async () => {
  const saved = process.env.MEETLY_HOME;
  process.env.MEETLY_HOME = tmpHome();
  try {
    for (const timezone of [async () => undefined, async () => { throw new Error("no Mac"); }, async () => "Not/AZone"]) {
      const s = await statusFilling({ ownerName: async () => "Ana", timezone });
      assert.equal(s.status === "SETUP_NEEDED" && s.next, "timezone");
    }
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

