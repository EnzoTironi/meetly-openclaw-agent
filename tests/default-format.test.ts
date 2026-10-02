import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseField } from "../skills/meetly/scripts/config.ts";
import { finish, record } from "../skills/meetly/scripts/record-setup.ts";
import { readJson } from "../skills/meetly/scripts/store.ts";
import { tmpHome } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const flat = (path: string) => readFileSync(join(ROOT, path), "utf8").replace(/\s+/g, " ");
const CALENDARS = JSON.stringify({ defaultAccount: "jean@example.com", calendars: [] });

function finished(): string {
  const home = tmpHome();
  process.env.MEETLY_HOME = home;
  record("ownerName", "Jean");
  record("timezone", "America/Sao_Paulo");
  record("calendars", CALENDARS);
  finish(() => ({}), Date.parse("2026-09-26T12:00:00Z"));
  return home;
}

test("the default meeting format is meet, in_person or phone, and ask clears it", () => {
  assert.deepEqual(parseField("defaultFormat", "meet"), { defaultFormat: "meet" });
  assert.deepEqual(parseField("defaultFormat", " in_person "), { defaultFormat: "in_person" });
  assert.deepEqual(parseField("defaultFormat", "phone"), { defaultFormat: "phone" });
  assert.deepEqual(parseField("defaultFormat", "ask"), { defaultFormat: undefined });
  assert.throws(() => parseField("defaultFormat", "zoom"), /meet, in_person, phone or ask/);
});

test("no default format is set until the owner says one, so a request that names none is still asked", () => {
  const home = finished();
  assert.equal("defaultFormat" in readJson<object>(join(home, "config.json"), {}), false);
});

test("the owner's default format is kept in config.json, changed later and cleared with ask", () => {
  const home = finished();
  record("defaultFormat", "meet");
  assert.equal(readJson<{ defaultFormat?: string }>(join(home, "config.json"), {}).defaultFormat, "meet");
  record("defaultFormat", "in_person");
  assert.equal(readJson<{ defaultFormat?: string }>(join(home, "config.json"), {}).defaultFormat, "in_person");
  record("defaultFormat", "ask");
  assert.equal("defaultFormat" in readJson<object>(join(home, "config.json"), {}), false);
});

test("a request that names no format uses the owner's default, and anything they name wins", () => {
  const group = flat("skills/meetly-group/SKILL.md");
  assert.ok(group.includes("Anything else is `config.defaultFormat` when the owner set one, otherwise `unknown`"));
  assert.ok(group.includes("What the owner or the other person says about the format always wins over `config.defaultFormat`"));
  assert.ok(group.includes("A default of `in_person` still asks where"));
  const setup = flat("skills/meetly-setup/SKILL.md");
  assert.ok(setup.includes("`record-setup.ts --field defaultFormat --value meet|in_person|phone`"));
  assert.ok(setup.includes("\"ask me each time\" → `ask`"));
  assert.ok(flat("README.md").includes("default meeting type"));
});
