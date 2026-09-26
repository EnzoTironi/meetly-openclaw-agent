import { join } from "node:path";

// Meetly's state directory, read at call time so tests can point it elsewhere.
export function home(): string {
  return process.env.MEETLY_HOME || "/var/lib/plow/meetly";
}

export function file(name: string): string {
  return join(home(), name);
}
