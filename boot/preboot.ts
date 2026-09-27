// Meetly's entrypoint: set the model, then run the base's boot unchanged.
//
// The base renders openclaw.json and starts the gateway in one step, so the
// model has to be in the file before it runs. On a fresh volume there is no
// file yet, and the base would seed one on its own models; this seeds it from
// the base's own renderer instead, so even the first gateway runs on Luna. Any
// failure here leaves the file as it was: the agent still boots, on whatever
// model the file already names.
import { readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { applyRoute, llmRoute } from "./llm.ts";

const CONFIG = "/var/lib/plow/openclaw.json";
// Loaded by path at run time: these are the base image's compiled modules.
const load = (path: string) => import(path);

try {
  const base = process.env.PLOW_API_BASE?.replace(/\/$/, "");
  if (base) {
    const { route, problem } = llmRoute();
    if (problem) console.error(`meetly-boot: llm: ${problem}`);
    const JSON5 = createRequire("/opt/plow/package.json")("json5");
    let config: Record<string, unknown>;
    try {
      config = JSON5.parse(await readFile(CONFIG, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const { renderConfig } = await load("/opt/plow/boot/config.js");
      const { identityFromApi } = await load("/opt/plow/boot/identity.js");
      config = renderConfig(await identityFromApi(base, process.env.PLOW_AGENT_TOKEN || "proxied"), base);
    }
    applyRoute(config, route, base);
    await writeFile(`${CONFIG}.tmp`, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await rename(`${CONFIG}.tmp`, CONFIG);
    console.log(`meetly-boot: llm ${route.provider} ${route.primary}${route.fallbacks.length ? ` (fallback ${route.fallbacks.join(", ")})` : ""}`);
  }
} catch (error) {
  console.error(`meetly-boot: llm config left as it was: ${error instanceof Error ? error.message : String(error)}`);
}

await load("/opt/plow/boot/main.js");
