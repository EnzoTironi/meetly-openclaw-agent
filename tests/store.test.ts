import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, updateJson, withLock, writeJson } from "../skills/meetly/scripts/store.ts";
import { file, home } from "../skills/meetly/scripts/paths.ts";
import { tmpHome } from "./helpers.ts";

test("home reads MEETLY_HOME at call time", () => {
  const saved = process.env.MEETLY_HOME;
  try {
    delete process.env.MEETLY_HOME;
    assert.equal(home(), "/var/lib/plow/meetly");
    process.env.MEETLY_HOME = "/tmp/x";
    assert.equal(file("a.json"), "/tmp/x/a.json");
  } finally {
    if (saved === undefined) delete process.env.MEETLY_HOME;
    else process.env.MEETLY_HOME = saved;
  }
});

test("missing file returns the fallback", () => {
  assert.deepEqual(readJson(join(tmpHome(), "none.json"), { a: 1 }), { a: 1 });
});

test("corrupt JSON throws with the path and leaves the file alone", () => {
  const path = join(tmpHome(), "ledger.json");
  writeFileSync(path, "{not json");
  assert.throws(() => readJson(path, { requests: [] }), (err: Error) => err.message.includes(path));
  assert.equal(readFileSync(path, "utf8"), "{not json");
  assert.throws(() => updateJson(path, { requests: [] }, (v) => v));
  assert.equal(readFileSync(path, "utf8"), "{not json");
});

test("write then read round-trips and leaves no temp file", () => {
  const dir = join(tmpHome(), "nested");
  const path = join(dir, "x.json");
  writeJson(path, { b: [1, 2] });
  assert.deepEqual(readJson(path, null), { b: [1, 2] });
  assert.deepEqual(readdirSync(dir), ["x.json"]);
});

test("updateJson applies the change and releases the lock", () => {
  const dir = tmpHome();
  const path = join(dir, "c.json");
  const out = updateJson(path, { n: 0 }, (v) => ({ n: v.n + 1 }));
  assert.deepEqual(out, { n: 1 });
  assert.deepEqual(updateJson(path, { n: 0 }, (v) => ({ n: v.n + 1 })), { n: 2 });
  assert.deepEqual(readdirSync(dir), ["c.json"]);
});

test("a held lock throws lock busy after waitMs", () => {
  const path = join(tmpHome(), "c.json");
  mkdirSync(`${path}.lock`);
  let clock = Date.now();
  let slept = 0;
  let ran = false;
  assert.throws(
    () =>
      withLock(path, () => { ran = true; }, {
        waitMs: 1000,
        now: () => clock,
        sleep: (ms) => { slept += ms; clock += ms; },
      }),
    /lock busy: .*c\.json\.lock/,
  );
  assert.equal(ran, false);
  assert.ok(slept >= 1000);
});

test("a stale lock is broken and fn runs", () => {
  const path = join(tmpHome(), "c.json");
  const lock = `${path}.lock`;
  mkdirSync(lock);
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
  assert.equal(withLock(path, () => 42, { sleep: () => { throw new Error("should not wait"); } }), 42);
  assert.throws(() => readdirSync(lock), /ENOENT/);
});

test("the lock is released when fn throws", () => {
  const path = join(tmpHome(), "c.json");
  assert.throws(() => withLock(path, () => { throw new Error("boom"); }), /boom/);
  assert.equal(withLock(path, () => "ok"), "ok");
});
