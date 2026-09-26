// Is Meetly set up? READY with the config and the calendar range to read,
// or SETUP_NEEDED with the next question.
import { isMain, run } from "./cli.ts";
import { nextField, QUESTIONS, type Config, type Field } from "./config.ts";
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

if (isMain(import.meta.url)) run(() => status());
