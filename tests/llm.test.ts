import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyRoute, llmRoute, LUNA_PROVIDER, PLOW_MODEL, PLOW_ROUTE, readLlmMarker } from "../boot/llm.ts";

const API = "http://api:8000";

test("a one-click install, with no marker and no environment, runs on Plow's Luna", () => {
  assert.deepEqual(llmRoute({}, undefined), { route: PLOW_ROUTE });
  assert.deepEqual(PLOW_ROUTE, { provider: "plow", primary: "plow-luna/openai/gpt-6-luna", fallbacks: [] });
});

test("the owner's OpenAI sign-in moves inference to their account with Plow's Luna as the fallback", () => {
  assert.deepEqual(llmRoute({}, "openai").route, { provider: "openai", primary: "openai/gpt-6-luna", fallbacks: [PLOW_MODEL] });
});

test("AGENT_PROVIDER outranks the marker, and a provider this image cannot use stays on Plow", () => {
  assert.deepEqual(llmRoute({ AGENT_PROVIDER: "plow" }, "openai").route, PLOW_ROUTE);
  assert.equal(llmRoute({ AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-6-luna" }, undefined).route.primary,
    "openrouter/openai/gpt-6-luna");
  assert.match(llmRoute({ AGENT_PROVIDER: "openrouter" }, undefined).problem!, /needs AGENT_MODEL/);
  assert.match(llmRoute({}, "anthropic").problem!, /unknown provider/);
});

test("the marker is read trimmed, and a missing marker is no marker", async t => {
  const dir = await mkdtemp(join(tmpdir(), "meetly-llm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(readLlmMarker(join(dir, "absent")), undefined);
  await writeFile(join(dir, "llm-provider"), "openai\n");
  assert.equal(readLlmMarker(join(dir, "llm-provider")), "openai");
});

// What the base seeds: its own provider and models, which Meetly leaves alone.
function baseSeed() {
  return {
    models: { providers: { plow: { baseUrl: `${API}/v1`, models: [{ id: "z-ai/glm-5.2" }] } } },
    agents: { entries: { main: { identity: { name: "Meetly" } } }, defaults: {
      workspace: "/var/lib/plow/workspace", model: { primary: "plow/z-ai/glm-5.2", fallbacks: ["plow/anthropic/claude-sonnet-5"] },
    } },
  };
}

test("Plow's route replaces the base's GLM default with Luna on Meetly's own provider", () => {
  const config = applyRoute(baseSeed(), PLOW_ROUTE, API);
  assert.deepEqual(config.agents.defaults.model, { primary: "plow-luna/openai/gpt-6-luna", fallbacks: [] });
  assert.equal(config.models.providers[LUNA_PROVIDER].baseUrl, `${API}/v1`);
  assert.equal(config.models.providers[LUNA_PROVIDER].apiKey, "${PLOW_AGENT_TOKEN}", "a reference, never the credential");
  assert.deepEqual(config.models.providers[LUNA_PROVIDER].models.map((m: { id: string }) => m.id), ["openai/gpt-6-luna"]);
  assert.deepEqual(config.models.providers.plow, baseSeed().models.providers.plow, "the base's provider is the base's");
  assert.equal(config.agents.defaults.workspace, "/var/lib/plow/workspace");
  for (const key of ["models", "modelPolicy", "utilityModel"]) assert.equal(key in config.agents.defaults, false, key);
});

test("an OpenAI route runs on OpenClaw's own runtime, and moving back removes only what it added", () => {
  const config = applyRoute(baseSeed(), llmRoute({}, "openai").route, API);
  assert.deepEqual(config.agents.defaults.model, { primary: "openai/gpt-6-luna", fallbacks: ["plow-luna/openai/gpt-6-luna"] });
  assert.deepEqual(config.agents.defaults.models, { "openai/*": { agentRuntime: { id: "openclaw" } } });
  assert.deepEqual(config.agents.defaults.modelPolicy, { allow: [] });
  assert.equal(config.agents.defaults.utilityModel, "openai/gpt-6-luna");
  config.agents.defaults.models["plow-luna/openai/gpt-6-luna"] = { alias: "luna" };
  applyRoute(config, PLOW_ROUTE, API);
  assert.deepEqual(config.agents.defaults.models, { "plow-luna/openai/gpt-6-luna": { alias: "luna" } });
  for (const key of ["modelPolicy", "utilityModel"]) assert.equal(key in config.agents.defaults, false, key);
});
