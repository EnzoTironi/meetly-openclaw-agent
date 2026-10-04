import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/extension.ts";

test("native discovery is inert and Code Mode can orchestrate only the guarded scheduling workflow", async () => {
  type Api = Parameters<typeof extension.register>[0];
  const hooks = new Map<string, Parameters<Api["on"]>[1]>();
  const api: Api = {
    config: {}, logger: { info() {}, warn() {} },
    registerTool() {}, registerService() {},
    on(name, handler) { hooks.set(name, handler); },
    runtime: { subagent: { complete: async () => assert.fail("discovery must not start a model") } },
  };
  extension.register(api);
  const guard = hooks.get("before_tool_call"); assert.ok(guard);
  for (const call of [
    { toolName: "exec", toolKind: "code_mode_exec", toolInputKind: "javascript", params: { code: 'const result = await meetly({action:"status"}); text(result)' } },
    { toolName: "exec", toolKind: "code_mode_exec", toolInputKind: "javascript", params: { code: 'await meetly({action:"status"})', command: 'await meetly({action:"status"})' } },
    { toolName: "wait", params: { runId: "current-code-mode-run" } },
    { toolName: "meetly", params: { action: "status" } },
    { toolName: "read", params: { path: "/opt/plow/skills/meetly/SKILL.md" } },
  ]) assert.equal(await guard(call, {}), undefined);
  for (const call of [
    { toolName: "exec", params: { command: "plow-gog calendar create" } },
    { toolName: "exec", params: { code: "extra fields cannot turn shell exec into Code Mode" } },
    { toolName: "exec", params: { code: "ignored", command: "shell must still be denied" } },
    { toolName: "plow_run_command", params: { argv: ["plow-gog", "calendar", "delete"] } },
    { toolName: "plow_start_thread", params: { members: ["guest@example.test"] } },
    { toolName: "write", params: { path: "/var/lib/plow/workspace/pipeline.md" } },
    { toolName: "read", params: { path: "/opt/plow/skills/../../private" } },
    { toolName: "read", params: { path: "/etc/passwd" } },
  ]) assert.equal((await guard(call, {}) as { block: boolean }).block, true);
  const reply = hooks.get("reply_payload_sending"); assert.ok(reply);
  assert.deepEqual(await reply({ kind: "final", payload: { text: "Private owner details" } },
    { channelId: "plow", accountId: "chat", conversationId: "group" }), { cancel: true },
  "Unavailable configuration must not expose a private report publicly");
});

test("the native reply boundary sends the owner's group report privately once and cancels public progress", async t => {
  const root = mkdtempSync(join(tmpdir(), "meetly-private-reply-"));
  const readFile = fs.readFileSync;
  const skillRead = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => args[0] === "/opt/plow/skills/meetly/SKILL.md" ? "Fixture scheduling tool" : readFile(...args));
  syncBuiltinESMExports();
  const previous = { root: process.env.MEETLY_PLOW_MODULE_ROOT, home: process.env.MEETLY_HOME, token: process.env.PLOW_AGENT_TOKEN, base: process.env.PLOW_API_BASE };
  process.env.MEETLY_PLOW_MODULE_ROOT = root; process.env.MEETLY_HOME = root; process.env.PLOW_AGENT_TOKEN = "test-private";
  process.env.PLOW_API_BASE = "https://fixture.invalid";
  t.after(() => {
    skillRead.mock.restore(); syncBuiltinESMExports();
    for (const [key, value] of [["MEETLY_PLOW_MODULE_ROOT", previous.root], ["MEETLY_HOME", previous.home], ["PLOW_AGENT_TOKEN", previous.token], ["PLOW_API_BASE", previous.base]]) {
      if (!key) continue;
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true });
  });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "index.js"), `
    export const acknowledgePluginHandoff = () => true;
    export async function sendText(config, thread, text) {
      return (await fetch(config.channels.plow.apiBase + '/send', { method: 'POST', body: JSON.stringify({ thread, text }) })).json();
    }`);
  writeFileSync(join(root, "threads.js"), 'export const startThread = () => { throw new Error("No new group expected"); };');
  const member = { type: "member", uid: "member-owner", role: "owner", provider_key: "owner@example.test" };
  const agent = { type: "agent", relationship: "self", line: { uid: "line-self" } };
  const privateChat = { uid: "owner", status: "active", participants: [member, agent] };
  const group = { uid: "group", status: "active", participants: [member, agent, { type: "member", uid: "member-guest", role: "guest", provider_key: "guest@example.test" }] };
  const input = { uid: "owner-group-request", direction: "inbound", body: "Pode marcar uma conversa com Daniel?", created_at: "2026-10-04T10:00:00Z", sender: member };
  const privateInput = { ...input, uid: "owner-private-request", body: "Pode conferir as minhas preferências?" };
  const sent: { thread: string; text: string }[] = [];
  t.mock.method(globalThis, "fetch", async (...[url, init]: Parameters<typeof fetch>) => {
    const path = new URL(String(url)).pathname.replace(/^\/v1/, "");
    let data: unknown;
    if (path === "/send") {
      assert.equal(typeof init?.body, "string");
      const body: unknown = JSON.parse(String(init?.body));
      assert.ok(typeof body === "object" && body !== null && "thread" in body && "text" in body);
      assert.equal(typeof body.thread, "string"); assert.equal(typeof body.text, "string");
      if (typeof body.thread !== "string" || typeof body.text !== "string") throw new Error("Unexpected private send");
      sent.push({ thread: body.thread, text: body.text }); data = { messageId: `private-final-${sent.length}` };
    } else if (path === "/agents/me") data = { line: { uid: "line-self" }, chats: [privateChat, group] };
    else if (path === "/chats/group") data = group;
    else if (path === "/chats/owner") data = privateChat;
    else if (path === "/chats/group/messages") data = { data: [input], has_more: false };
    else if (path === "/chats/owner/messages") data = { data: [privateInput, ...sent.map((message, index) => ({ uid: `private-final-${index + 1}`, direction: "outbound", body: message.text, created_at: "2026-10-04T10:00:01Z", sender: agent }))], has_more: false };
    else assert.fail(`Unexpected request ${path}`);
    return Response.json(data);
  });
  type Api = Parameters<typeof extension.register>[0];
  const hooks = new Map<string, Parameters<Api["on"]>[1]>();
  let stop: (() => Promise<void>) | undefined;
  let factory: Parameters<Api["registerTool"]>[0] | undefined;
  const completions: Parameters<Api["runtime"]["subagent"]["complete"]>[0][] = [];
  const api: Api = {
    config: { agents: { defaults: { workspace: root } }, channels: { plow: { apiBase: "https://fixture.invalid", lineUid: "line-self", threadTrust: "untrusted" } } },
    logger: { info() {}, warn() {} }, registerTool(tool) { factory = tool; }, registerService(service) { stop = service.stop; },
    on(name, handler) { hooks.set(name, handler); },
    runtime: { subagent: { complete: async request => {
      completions.push(request);
      return { text: completions.length === 1 ? '{"language":"Portuguese"}' : "Enzo, qual local devemos usar?" };
    } } },
  };
  extension.register(api);
  const receive = hooks.get("before_dispatch"), reply = hooks.get("reply_payload_sending"); assert.ok(receive && reply && stop);
  const context = { channelId: "plow", accountId: "chat", conversationId: "group" };
  await receive({ messageId: input.uid }, context);
  const text = "Preparei três opções e enviei ao Daniel.";
  assert.deepEqual(await reply({ kind: "commentary", payload: { text: "Estou conferindo." } }, context), { cancel: true });
  assert.deepEqual(await reply({ kind: "final", payload: null }, context), { cancel: true });
  assert.deepEqual(await reply({ kind: "final", payload: { text } }, context), { cancel: true });
  assert.deepEqual(await reply({ kind: "final", payload: { text } }, context), { cancel: true });
  assert.equal(await reply({ kind: "final", payload: { text } }, { ...context, conversationId: "owner" }), undefined);
  assert.equal(await reply({ kind: "final", payload: { text } }, { ...context, accountId: "email" }), undefined);
  assert.ok(factory);
  const tool = factory({ sessionKey: "agent:main:plow:group:group", messageChannel: "plow", agentAccountId: "chat", nativeChannelId: "group", requesterSenderId: "plow-owner", senderIsOwner: true });
  await tool.execute("read-status", { action: "status" });
  assert.equal(completions.length, 0, "The reply boundary forwards model text without generating a canned answer");
  assert.deepEqual(sent, [{ thread: "owner", text }]);
  await receive({ messageId: privateInput.uid }, { ...context, conversationId: "owner" });
  await tool.execute("ask-call", { action: "ask", contact: { name: "Daniel", handle: "guest@example.test" }, question: "Where will the English Project Review take place?" });
  assert.equal(completions.length, 2);
  assert.deepEqual(JSON.parse(completions[0]!.message), { languageSample: privateInput.body }, "Language inference receives only the recipient's cue, without conflicting meeting facts");
  assert.match(completions[1]!.message, /^Write entirely in Portuguese\./);
  assert.match(completions[1]!.extraSystemPrompt, /entirely in Portuguese/);
  assert.match(completions[1]!.message, /English Project Review/);
  assert.deepEqual(sent.at(-1), { thread: "owner", text: "Enzo, qual local devemos usar?" });
  await stop();
});
