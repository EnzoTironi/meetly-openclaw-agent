import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGate, installGate } from "../boot/gate.ts";
import gate, { gateContext, isOwnerDmTurn } from "../plugin/index.js";

const status = (s: unknown) => JSON.stringify(s) + "\n";

test("only the owner's own DM user turn is gated", () => {
  assert.equal(isOwnerDmTurn({ channel: "plow", accountId: "chat", sessionKey: "agent:main:main", trigger: "user" }), true);
  assert.equal(isOwnerDmTurn({ channel: "plow", sessionKey: "agent:main:main" }), true);
  for (const ctx of [
    { channel: "plow", accountId: "chat", sessionKey: "agent:main:plow:group:cht_x", trigger: "user" },
    { channel: "plow", accountId: "email", sessionKey: "agent:main:main" },
    { channel: "plow", sessionKey: "agent:main:main", trigger: "cron" },
    { channel: "webchat", sessionKey: "agent:main:main" },
    undefined,
  ]) assert.equal(isOwnerDmTurn(ctx), false, JSON.stringify(ctx));
});

test("unfinished setup tells the model to introduce Meetly and ask the current question, not an old one", () => {
  const context = gateContext(status({ status: "SETUP_NEEDED", next: "timezone", question: "What time zone are you in?", draft: { ownerName: "Ana Lima" } }))!;
  assert.match(context, /SETUP_NEEDED/);
  assert.match(context, /ignore any earlier setup question in the chat/);
  assert.match(context, /you are Meetly, their AI scheduling assistant/);
  assert.match(context, /refer to them as Ana Lima when you talk to other people/);
  // setup-status.ts already tried the Mac; a timezone still pending is for the owner.
  assert.match(context, /translated into the owner's language, and end the turn: What time zone are you in\?/);
  assert.match(context, /Do not run setup-status\.ts again this turn/);
});

test("without a name from Plow the gate does not invent one, and a finished draft asks for --done", () => {
  const asking = gateContext(status({ status: "SETUP_NEEDED", next: "ownerName", question: "What name should I use?", draft: {} }))!;
  assert.doesNotMatch(asking, /refer to them as/);
  const days = gateContext(status({ status: "SETUP_NEEDED", next: "days", question: "Which days?", draft: { ownerName: "Ana" } }))!;
  assert.match(days, /ask this question, translated into the owner's language, and end the turn: Which days\?/);
  assert.match(days, /answers the days question, record it first with record-setup\.ts/);
  const done = gateContext(status({ status: "SETUP_NEEDED", next: null, question: null, draft: { ownerName: "Ana" } }))!;
  assert.match(done, /record-setup\.ts --done/);
});

test("a finished setup is passed along, and output that is not a status adds nothing", () => {
  assert.match(gateContext(status({ status: "READY", config: {}, range: {} }))!, /READY/);
  assert.equal(gateContext("error: boom"), undefined);
  assert.equal(gateContext(status({ ok: true })), undefined);
});

test("the plugin registers one before_prompt_build hook that skips other turns", async () => {
  const hooks: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  gate.register({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => { hooks[name] = fn; }, logger: { info() {} } });
  assert.deepEqual(Object.keys(hooks), ["before_prompt_build"]);
  assert.equal(await hooks.before_prompt_build!({}, { channel: "plow", sessionKey: "agent:main:plow:group:x" }), undefined);
});

test("preboot enables the gate with conversation access and replaces the volume's copy", async (t) => {
  assert.deepEqual(applyGate({ plugins: { entries: { plow: { enabled: true } } } }).plugins.entries, {
    plow: { enabled: true }, meetly: { enabled: true, hooks: { allowConversationAccess: true } },
  });
  const dir = await mkdtemp(join(tmpdir(), "meetly-gate-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, "extensions", "meetly");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "index.js"), "tampered");
  await installGate(join(import.meta.dirname, "..", "plugin"), target);
  assert.equal(await readFile(join(target, "index.js"), "utf8"), await readFile(join(import.meta.dirname, "..", "plugin", "index.js"), "utf8"));
  assert.ok(JSON.parse(await readFile(join(target, "openclaw.plugin.json"), "utf8")).id === "meetly");
});

const LATCH = { connected: false, download: "https://plow.co/download/latch", about: "https://plow.co/latch" };

test("with no Mac at the calendars question the gate explains Plow Latch with its link instead of asking", () => {
  const context = gateContext(status({ status: "SETUP_NEEDED", next: "calendars", question: "Which of your calendars should count as busy?", draft: { ownerName: "Ana" }, mac: LATCH }))!;
  assert.match(context, /Plow Latch/);
  assert.match(context, /https:\/\/plow\.co\/download\/latch/);
  assert.match(context, /https:\/\/plow\.co\/latch/);
  assert.match(context, /iMessages and Google Calendar/);
  assert.doesNotMatch(context, /and end the turn: Which of your calendars/);
});

test("with no Mac at the time zone question the gate still asks it, and adds the Latch link", () => {
  const context = gateContext(status({ status: "SETUP_NEEDED", next: "timezone", question: "What time zone are you in?", draft: { ownerName: "Ana" }, mac: LATCH }))!;
  assert.match(context, /and end the turn: What time zone are you in\?/);
  assert.match(context, /https:\/\/plow\.co\/download\/latch/);
  const connected = gateContext(status({ status: "SETUP_NEEDED", next: "timezone", question: "What time zone are you in?", draft: {}, mac: { connected: true } }))!;
  assert.doesNotMatch(connected, /plow\.co/);
});
