// Is Meetly set up? READY with the config and the calendar range to read,
// or SETUP_NEEDED with the next question.
import { isMain, run } from "./cli.ts";
import { nextField, QUESTIONS, type Config, type Field } from "./config.ts";
import { ownerDisplayName } from "./owner-chat.ts";
import { record } from "./record-setup.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { localIso } from "./time.ts";

export type Status =
  | { status: "READY"; config: Config; range: { from: string; to: string } }
  | { status: "SETUP_NEEDED"; next: Field | null; question: string | null; draft: Partial<Config> };

export function status(now: number = Date.now()): Status {
  const config = readJson<Config | null>(file("config.json"), null);
  if (config?.setupDoneAt) {
    const to = now + (config.horizonDays + 1) * 86_400_000;
    return { status: "READY", config, range: { from: localIso(now, config.timezone), to: localIso(to, config.timezone) } };
  }
  const draft = readJson<Partial<Config>>(file("config.draft.json"), {});
  const next = nextField(draft) ?? null;
  return { status: "SETUP_NEEDED", next, question: next ? QUESTIONS[next] : null, draft };
}

// Plow already knows the owner's name: the one on their profile. It answers
// the first question, so setup starts at the time zone; the owner is asked only
// when Plow has no name, or cannot be reached. They can change it afterwards.
export async function statusFillingName(lookup: () => Promise<string | undefined> = ownerDisplayName, now: number = Date.now()): Promise<Status> {
  const current = status(now);
  if (current.status !== "SETUP_NEEDED" || current.next !== "ownerName") return current;
  let name: string | undefined;
  try {
    name = (await lookup())?.trim().slice(0, 60);
  } catch {
    return current;
  }
  if (!name) return current;
  record("ownerName", name);
  return status(now);
}

if (isMain(import.meta.url)) run(() => statusFillingName());
