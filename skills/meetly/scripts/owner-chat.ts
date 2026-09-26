// The owner's DM uid, asked of Plow on every use (never cached: a stored uid
// would outlive the chat it names). Same rule as the Plow channel plugin: the
// one active chat with exactly two participants, this agent on its own line
// and a member whose role is owner.
import { isMain, run } from "./cli.ts";

type Participant = { type?: string; relationship?: string; role?: string; line?: { uid?: string } };
export type Identity = {
  line?: { uid?: string };
  chats?: { uid: string; status?: string; participants?: Participant[] }[];
};

export function findOwnerChat(identity: Identity): string | null {
  const line = identity.line?.uid;
  const owners = (identity.chats ?? []).filter((c) => {
    const ps = c.participants ?? [];
    return c.status === "active" && ps.length === 2 &&
      ps.some((p) => p.type === "agent" && p.relationship === "self" && p.line?.uid === line) &&
      ps.some((p) => p.type === "member" && p.role === "owner");
  });
  if (owners.length > 1) throw new Error(`expected one owner's chat; found ${owners.length}`);
  return owners[0]?.uid ?? null;
}

export async function ownerChat(opts: { fetch?: typeof fetch; base?: string; token?: string } = {}): Promise<{ chatUid: string }> {
  const doFetch = opts.fetch ?? fetch;
  const base = (opts.base ?? process.env.PLOW_API_BASE ?? "").replace(/\/+$/, "");
  const token = opts.token ?? process.env.PLOW_AGENT_TOKEN ?? "";
  if (!base) throw new Error("PLOW_API_BASE is not set");
  if (!token) throw new Error("PLOW_AGENT_TOKEN is not set");
  const res = await doFetch(`${base}/v1/agents/me`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`/v1/agents/me returned HTTP ${res.status}`);
  const uid = findOwnerChat((await res.json()) as Identity);
  if (!uid) throw new Error("the owner has not texted this line yet");
  return { chatUid: uid };
}

if (isMain(import.meta.url)) run(() => ownerChat());
