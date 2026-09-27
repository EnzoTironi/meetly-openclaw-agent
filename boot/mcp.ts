// The base renders the Mac relay's MCP entry without a request timeout, and
// OpenClaw then caps the relay's tool listing at 1500 ms. A round trip to the
// Mac takes 0.9-1.8 s, so a turn intermittently got no Mac tools at all: no
// messages, no calendar, no browser. 60 s is OpenClaw's own request default.
// A timeout the base sets itself is kept.
export const MAC_REQUEST_TIMEOUT_MS = 60_000;

export function withMacTimeout(config: Record<string, any>): Record<string, any> {
  const relay = config?.mcp?.servers?.plow;
  if (relay && relay.requestTimeoutMs === undefined) relay.requestTimeoutMs = MAC_REQUEST_TIMEOUT_MS;
  return config;
}
