// People Meetly must never contact: the owner said so. The list lives in
// blocked.json and is enforced where a group opens (start-thread.ts), so no
// route around the skill reaches them.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { normalizeHandle, sameHandle } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export type Blocked = { handle: string; name?: string; at: string };

export const isBlocked = (list: Blocked[], handle: string): boolean => list.some((b) => sameHandle(b.handle, handle));

export function block(list: Blocked[], handle: string, name: string | undefined, now: number): Blocked[] {
  const h = normalizeHandle(handle ?? "");
  if (!h || h === "+") throw new Error("a handle is required: a phone in E.164 or an email");
  if (isBlocked(list, h)) return list;
  return [...list, { handle: h, ...(name ? { name } : {}), at: new Date(now).toISOString() }];
}

export const unblock = (list: Blocked[], handle: string): Blocked[] => list.filter((b) => !sameHandle(b.handle, handle));

export function loadBlocked(): Blocked[] {
  return readJson<Blocked[]>(file("blocked.json"), []);
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({ args: rest, options: { handle: { type: "string" }, name: { type: "string" } } });
    const path = file("blocked.json");
    switch (cmd) {
      case "block":
        if (values.handle === undefined) throw new Error("usage: blocklist.ts block --handle H [--name N]");
        return { blocked: updateJson<Blocked[]>(path, [], (l) => block(l, values.handle!, values.name, Date.now())) };
      case "unblock":
        if (values.handle === undefined) throw new Error("usage: blocklist.ts unblock --handle H");
        return { blocked: updateJson<Blocked[]>(path, [], (l) => unblock(l, values.handle!)) };
      case "check":
        if (values.handle === undefined) throw new Error("usage: blocklist.ts check --handle H");
        return { blocked: isBlocked(loadBlocked(), values.handle) };
      case "list":
        return { blocked: loadBlocked() };
      default:
        throw new Error("usage: blocklist.ts block | unblock | check | list");
    }
  });
}
