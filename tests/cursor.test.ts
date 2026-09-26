import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markFail, markOk, setRowid, WARN_AFTER_MS, type Cursor } from "../skills/meetly/scripts/cursor.ts";
import { cli, tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-09-28T12:00:00Z");

test("setRowid moves forward only and clears failures", () => {
  const c = setRowid({ rowid: null, failingSince: "x", warnedAt: "y" }, 10, T0);
  assert.deepEqual(c, { rowid: 10, updatedAt: new Date(T0).toISOString() });
  assert.throws(() => setRowid(c, 5, T0), /cursor never moves back/);
  assert.equal(setRowid(c, 10, T0).rowid, 10);
  assert.throws(() => setRowid(c, -1, T0));
  assert.throws(() => setRowid(c, 1.5, T0));
});

test("markFail warns exactly once after 30 minutes", () => {
  let c: Cursor = { rowid: 3 };
  let r = markFail(c, T0);
  assert.equal(r.warn, false);
  assert.equal(r.cursor.failingSince, new Date(T0).toISOString());
  r = markFail(r.cursor, T0 + 10 * 60_000);
  assert.equal(r.warn, false);
  assert.equal(r.cursor.failingSince, new Date(T0).toISOString());
  r = markFail(r.cursor, T0 + WARN_AFTER_MS + 60_000);
  assert.equal(r.warn, true);
  assert.ok(r.cursor.warnedAt);
  r = markFail(r.cursor, T0 + 2 * WARN_AFTER_MS);
  assert.equal(r.warn, false);
  c = markOk(r.cursor);
  assert.deepEqual(c, { rowid: 3 });
});

test("CLI get, set, fail and ok", () => {
  const env = { MEETLY_HOME: tmpHome() };
  assert.deepEqual(cli("cursor.ts", ["get"], env).json, { rowid: null });
  assert.equal(cli("cursor.ts", ["set", "10"], env).json.rowid, 10);
  assert.equal(cli("cursor.ts", ["get"], env).json.rowid, 10);
  const back = cli("cursor.ts", ["set", "5"], env);
  assert.equal(back.status, 1);
  assert.match(back.stderr, /cursor never moves back/);
  const fail = cli("cursor.ts", ["fail"], env).json;
  assert.equal(fail.warn, false);
  assert.ok(fail.failingSince);
  assert.ok(cli("cursor.ts", ["get"], env).json.failingSince);
  assert.deepEqual(Object.keys(cli("cursor.ts", ["ok"], env).json).sort(), ["rowid", "updatedAt"]);
  cli("cursor.ts", ["fail"], env);
  assert.equal(cli("cursor.ts", ["set", "11"], env).json.failingSince, undefined);
  assert.equal(cli("cursor.ts", ["set", "x"], env).status, 1);
  assert.equal(cli("cursor.ts", ["jump"], env).status, 1);
});

test("a corrupt cursor.json fails and is left alone", () => {
  const home = tmpHome();
  const path = join(home, "cursor.json");
  writeFileSync(path, "{broken");
  for (const args of [["get"], ["set", "1"], ["fail"]]) {
    const r = cli("cursor.ts", args, { MEETLY_HOME: home });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(path, "utf8"), "{broken");
});
