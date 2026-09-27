import { readFileSync } from "node:fs";

// Where this install's inference goes. Plow is every install's provider: a
// one-click install has nothing to set and never leaves it. The owner of one
// install can move it to their own OpenAI account (`plow-llm openai` signs in
// and leaves the marker below) or name one with AGENT_PROVIDER and
// AGENT_MODEL. Plow's model stays behind as the fallback, so a spent quota or
// an expired sign-in degrades to Plow instead of to silence.
//
// The base renders the config, and the base's `plow` provider lists
// only its own models and is rewritten every boot. Luna is declared on a
// provider of Meetly's own, the same Plow endpoint and credential reference,
// kept in the part of the config the base leaves to the owner.
export const LUNA_PROVIDER = "plow-luna";
export const PLOW_MODEL = `${LUNA_PROVIDER}/openai/gpt-6-luna`;
export const LLM_MARKER = "/var/lib/plow/llm-provider";

export type LlmProvider = "plow" | "openai" | "openrouter";
export type LlmRoute = { provider: LlmProvider; primary: string; fallbacks: string[] };
export const PLOW_ROUTE: LlmRoute = { provider: "plow", primary: PLOW_MODEL, fallbacks: [] };

// OpenRouter has no model this image could guess, so it needs AGENT_MODEL.
const DEFAULT_MODEL: Partial<Record<LlmProvider, string>> = { openai: "gpt-6-luna" };

export function readLlmMarker(path = LLM_MARKER): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** AGENT_PROVIDER wins over the marker; anything unusable falls back to Plow and says why. */
export function llmRoute(env: NodeJS.ProcessEnv = process.env, marker = readLlmMarker()): { route: LlmRoute; problem?: string } {
  const chosen = (env.AGENT_PROVIDER?.trim() || marker || "plow").toLowerCase();
  if (chosen === "plow") return { route: PLOW_ROUTE };
  if (chosen !== "openai" && chosen !== "openrouter") {
    return { route: PLOW_ROUTE, problem: `unknown provider ${JSON.stringify(chosen)}, staying on Plow` };
  }
  const model = (env.AGENT_MODEL?.trim() || DEFAULT_MODEL[chosen])?.replace(new RegExp(`^${chosen}/`), "");
  if (!model) return { route: PLOW_ROUTE, problem: `${chosen} needs AGENT_MODEL, staying on Plow` };
  return { route: { provider: chosen, primary: `${chosen}/${model}`, fallbacks: [PLOW_MODEL] } };
}

export function lunaProvider(apiBase: string) {
  return {
    baseUrl: `${apiBase}/v1`, apiKey: "${PLOW_AGENT_TOKEN}", api: "openai-completions", authHeader: true,
    request: { allowPrivateNetwork: true },
    models: [
      { id: "openai/gpt-6-luna", name: "GPT-6 Luna", input: ["text", "image"], contextWindow: 1050000, cost: { input: 0.10, output: 0.50 } },
    ],
  };
}

type ConfigObject = Record<string, any>;

/**
 * Writes this image's share of the config: the Luna provider and the model
 * choice under agents.defaults, which the base seeds once and then leaves to
 * the owner. Like the other agents' images, the model is the image's on every
 * boot. Only the keys this writes are removed when the route no longer needs them.
 */
export function applyRoute(config: ConfigObject, route: LlmRoute, apiBase: string): ConfigObject {
  config.models ??= {};
  config.models.providers ??= {};
  config.models.providers[LUNA_PROVIDER] = lunaProvider(apiBase);
  config.agents ??= {};
  const defaults = config.agents.defaults ??= {};
  defaults.model = { primary: route.primary, fallbacks: route.fallbacks };
  // Off Plow, titles and recaps use the chosen model too: OpenAI's own
  // small-model default is a model the owner did not pick.
  if (route.provider === "plow") delete defaults.utilityModel;
  else defaults.utilityModel = route.primary;
  // Signed in with the owner's own account, an openai/* model may otherwise
  // run on the native Codex harness, which skips the base plugin's hooks and
  // tool policy. The empty allow list keeps the entry from reading as a legacy
  // model restriction, so Plow's fallback stays selectable.
  const models: ConfigObject = defaults.models ?? {};
  if (route.provider === "openai") {
    models["openai/*"] = { agentRuntime: { id: "openclaw" } };
    defaults.models = models;
    defaults.modelPolicy = { allow: [] };
  } else {
    delete models["openai/*"];
    if (Object.keys(models).length) defaults.models = models;
    else delete defaults.models;
    if (Array.isArray(defaults.modelPolicy?.allow) && defaults.modelPolicy.allow.length === 0) delete defaults.modelPolicy;
  }
  return config;
}
