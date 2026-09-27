// The owner's time zone, as their Mac is set to it: `readlink /etc/localtime`
// on the Mac through the Latch relay, which boot bridges to loopback. Read-only
// and quick; the zone the Mac keeps is the one their calendar shows. Undefined
// when the Mac is not connected, the command is refused, or the answer is not
// a zone this runtime knows, and setup then asks.
import { isMain, run } from "./cli.ts";

export const BRIDGE_URL = "http://127.0.0.1:18790/mcp";

export type BridgeOptions = { fetch?: typeof fetch; url?: string; token?: string };

// The zone from what readlink printed: /var/db/timezone/zoneinfo/America/Sao_Paulo.
export function zoneFromLink(output: string): string | undefined {
  const zone = /zoneinfo\/(.+?)\s*$/.exec(output.trim())?.[1];
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

export async function macTimezone(opts: BridgeOptions = {}): Promise<string | undefined> {
  const token = opts.token ?? process.env.PLOW_MCP_BRIDGE_TOKEN;
  if (!token) return undefined;
  const res = await (opts.fetch ?? fetch)(opts.url ?? BRIDGE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "plow_run_command", arguments: {
        argv: ["readlink", "/etc/localtime"], read_paths: ["/etc/localtime"],
        goal: "Meetly setup: read this Mac's time zone so meetings are booked in your local time",
      } },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return undefined;
  const body = await res.text();
  const data = body.split("\n").find((line) => line.startsWith("data:"));
  const reply = JSON.parse(data ? data.slice(5) : body) as { result?: { isError?: boolean; content?: { type: string; text?: string }[] } };
  if (reply.result?.isError) return undefined;
  const text = reply.result?.content?.find((c) => c.type === "text")?.text;
  if (!text) return undefined;
  const out = JSON.parse(text) as { exit_code?: number; output?: string; status?: string };
  if (out.exit_code !== 0 || typeof out.output !== "string") return undefined;
  return zoneFromLink(out.output);
}

if (isMain(import.meta.url)) run(async () => ({ timezone: (await macTimezone()) ?? null }));
