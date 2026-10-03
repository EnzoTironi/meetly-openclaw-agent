import assert from "node:assert/strict";
import { test } from "node:test";
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
});
