import { test } from "node:test";
import assert from "node:assert/strict";
import { macTimezone, zoneFromLink } from "../skills/meetly/scripts/mac-timezone.ts";

test("the zone is what /etc/localtime links to, when it is a zone", () => {
  assert.equal(zoneFromLink("/var/db/timezone/zoneinfo/America/Sao_Paulo\n"), "America/Sao_Paulo");
  assert.equal(zoneFromLink("/usr/share/zoneinfo/Europe/Lisbon"), "Europe/Lisbon");
  assert.equal(zoneFromLink("/var/db/timezone/zoneinfo/Not/AZone"), undefined);
  assert.equal(zoneFromLink(""), undefined);
});

type Seen = { url: string; init: RequestInit | undefined };
// The bridge answers as the Latch relay does: an SSE data line with the tool's JSON text.
function bridge(result: unknown, seen: Seen[] = [], status = 200): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`, { status });
  }) as typeof fetch;
}
const ran = (out: unknown) => ({ content: [{ type: "text", text: JSON.stringify(out) }] });

test("macTimezone runs a read-only readlink on the Mac through the loopback bridge", async () => {
  const seen: Seen[] = [];
  const zone = await macTimezone({ token: "tok", fetch: bridge(ran({ exit_code: 0, output: "/var/db/timezone/zoneinfo/America/Sao_Paulo\n", status: "completed" }), seen) });
  assert.equal(zone, "America/Sao_Paulo");
  assert.equal(seen[0]!.url, "http://127.0.0.1:18790/mcp");
  assert.equal((seen[0]!.init?.headers as Record<string, string>).Authorization, "Bearer tok");
  const call = JSON.parse(String(seen[0]!.init?.body));
  assert.equal(call.method, "tools/call");
  assert.equal(call.params.name, "plow_run_command");
  assert.deepEqual(call.params.arguments.argv, ["readlink", "/etc/localtime"]);
  assert.deepEqual(call.params.arguments.read_paths, ["/etc/localtime"]);
  assert.equal("write_paths" in call.params.arguments, false);
});

test("no bridge token, an HTTP error, a refused or failed command all mean no answer", async () => {
  assert.equal(await macTimezone({ token: "", fetch: bridge(ran({ exit_code: 0, output: "/x/zoneinfo/UTC" })) }), undefined);
  assert.equal(await macTimezone({ token: "tok", fetch: bridge(ran({}), [], 401) }), undefined);
  assert.equal(await macTimezone({ token: "tok", fetch: bridge({ isError: true, content: [{ type: "text", text: "denied" }] }) }), undefined);
  assert.equal(await macTimezone({ token: "tok", fetch: bridge(ran({ exit_code: 1, output: "" })) }), undefined);
});
