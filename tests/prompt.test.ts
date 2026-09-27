import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { POLL_MESSAGE } from "../skills/meetly/scripts/register-crons.ts";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS = join(ROOT, "skills");
const SCRIPTS = join(SKILLS, "meetly", "scripts");
const prompt = readFileSync(join(ROOT, "prompt", "AGENTS.md"), "utf8");
const skillFiles = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ dir: d.name, path: join(SKILLS, d.name, "SKILL.md") }))
  .filter((s) => existsSync(s.path));

test("AGENTS.md is the base prompt byte for byte plus a Meetly section", () => {
  const base = readFileSync(join(ROOT, "tests", "fixtures", "base-AGENTS.md"), "utf8");
  assert.ok(prompt.startsWith(base), "the base prompt changed");
  const added = prompt.slice(base.length);
  assert.match(added, /^\n## Meetly\n/);
  assert.ok(added.includes("Meetly poll."));
});

test("the four Meetly skills exist", () => {
  assert.deepEqual(skillFiles.map((s) => s.dir).sort(), ["meetly", "meetly-group", "meetly-poll", "meetly-setup"]);
});

test("every skill has frontmatter naming its directory and a description", () => {
  for (const { dir, path } of skillFiles) {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"));
    assert.ok(m, `${dir}: no frontmatter`);
    const fields = Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    assert.equal(fields.name, dir);
    assert.ok(fields.description && fields.description.length > 20, `${dir}: description`);
  }
});

test("every script the prompt or a skill names exists", () => {
  const texts = [prompt, ...skillFiles.map((s) => readFileSync(s.path, "utf8"))];
  const named = new Set(texts.flatMap((t) => [...t.matchAll(/\b([a-z][a-z-]*)\.ts\b/g)].map((m) => m[1]!)));
  assert.ok(named.size >= 9);
  for (const name of named) assert.ok(existsSync(join(SCRIPTS, `${name}.ts`)), `missing script ${name}.ts`);
  for (const t of texts) {
    for (const m of t.matchAll(/\/opt\/plow\/skills\/meetly\/scripts\/([a-z-]+)\.ts/g)) {
      assert.ok(existsSync(join(SCRIPTS, `${m[1]}.ts`)));
    }
  }
});

test("the poll message is what the prompt keys on", () => {
  assert.ok(POLL_MESSAGE.startsWith("Meetly poll."));
  assert.ok(readFileSync(join(SKILLS, "meetly-poll", "SKILL.md"), "utf8").includes("start-thread.ts"));
});

test("Meetly introduces itself as Meetly, never by the configured name or as the owner", () => {
  const meetly = prompt.slice(prompt.indexOf("\n## Meetly\n"));
  assert.match(meetly, /\*\*Your name is Meetly\.\*\*/);
  assert.match(meetly, /whatever name the configuration or the Plow line shows/);
  assert.match(meetly, /never the owner/);
  const setup = readFileSync(join(SKILLS, "meetly-setup", "SKILL.md"), "utf8");
  assert.match(setup, /opens with one\s+line saying you are Meetly/);
});
