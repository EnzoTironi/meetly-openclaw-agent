// The owner's scheduling config: types, answer parsing and validation.
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { DAYS, type Day } from "./time.ts";

export { DAYS, type Day };

export type Calendar = { account: string; id: string };

export type Config = {
  ownerName: string;
  timezone: string;
  days: Day[];
  windowStart: string;
  windowEnd: string;
  durationMin: number;
  horizonDays: number;
  calendars: Calendar[];
  defaultAccount: string;
  setupDoneAt?: string;
  paused?: boolean;
};

// The question order of the setup conversation.
export const FIELDS = ["ownerName", "timezone", "days", "window", "durationMin", "horizonDays", "calendars"] as const;
export type Field = (typeof FIELDS)[number];

export const QUESTIONS: Record<Field, string> = {
  ownerName: "When I talk to other people for you, I write about you by name, like \"Ana is free at 3pm\". What name should I use?",
  timezone: "What time zone are you in?",
  days: "Which days of the week can I book meetings for you?",
  window: "Between what times on those days?",
  durationMin: "How long should a meeting be by default, in minutes?",
  horizonDays: "How many days ahead can I offer times?",
  calendars: "Which of your calendars should count as busy?",
};

export const MIN_NOTICE_MIN = 120;
export const STEP_MIN = 30;
export const SLOT_COUNT = 3;

export function holdHours(): number {
  const n = Number(process.env.MEETLY_HOLD_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

export function isField(name: string): name is Field {
  return (FIELDS as readonly string[]).includes(name);
}

const pad = (n: number) => String(n).padStart(2, "0");

// "9", "9h", "9:30", "9h30", "09:00" → "HH:MM".
export function parseTime(raw: string): string {
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?$/i.exec(raw.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m?.[2] ? Number(m[2]) : 0;
  if (!m || hh > 23 || mm > 59) throw new Error(`not a time: "${raw}" (use HH:MM, like 09:00)`);
  return `${pad(hh)}:${pad(mm)}`;
}

export function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

function integer(raw: string, what: string, min: number, max: number): number {
  const n = Number(raw.trim());
  if (!/^\d+$/.test(raw.trim()) || n < min || n > max) {
    throw new Error(`${what} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return n;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

// The calendars to read, by the ids `plow-gog calendar events --calendars`
// accepts. Holds are created on the default account's primary calendar, so it
// always counts as busy; a Google account's primary calendar id is the
// account's own address, and the `primary` alias, which the hold commands take,
// is not a name the events listing recognizes. Duplicates are dropped.
export function readableCalendars(calendars: Calendar[], defaultAccount: string): Calendar[] {
  if (!Array.isArray(calendars) || typeof defaultAccount !== "string" || !defaultAccount) return calendars;
  const out: Calendar[] = [];
  for (const c of [...calendars, { account: defaultAccount, id: defaultAccount }]) {
    const id = c.id === "primary" ? c.account : c.id;
    if (!out.some((o) => o.account === c.account && o.id === id)) out.push({ account: c.account, id });
  }
  return out;
}

export function parseField(field: string, value: string): Partial<Config> {
  switch (field) {
    case "ownerName": {
      const name = value.trim();
      if (name.length < 1 || name.length > 60) throw new Error("the name must be 1 to 60 characters");
      return { ownerName: name };
    }
    case "timezone": {
      const tz = value.trim();
      try {
        if (!tz) throw new Error();
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new Error(`unknown time zone: ${value} (use an IANA name like America/Sao_Paulo)`);
      }
      return { timezone: tz };
    }
    case "days": {
      const picked = new Set<Day>();
      for (const word of value.split(/[\s,]+/).filter(Boolean)) {
        const day = word.slice(0, 3).toLowerCase();
        if (!(DAYS as readonly string[]).includes(day)) throw new Error(`not a day of the week: "${word}"`);
        picked.add(day as Day);
      }
      if (picked.size === 0) throw new Error("pick at least one day");
      return { days: DAYS.filter((d) => picked.has(d)) };
    }
    case "window": {
      // Times never contain these letters, so splitting on them is safe.
      const parts = value.trim().split(/\s*(?:[-–—]|to|até|a)\s*/i).filter(Boolean);
      if (parts.length !== 2) throw new Error(`give a start and an end, like 09:00-18:00 (got "${value}")`);
      const windowStart = parseTime(parts[0]!);
      const windowEnd = parseTime(parts[1]!);
      if (minutes(windowStart) >= minutes(windowEnd)) throw new Error(`the window must start before it ends (${windowStart}-${windowEnd})`);
      return { windowStart, windowEnd };
    }
    case "durationMin":
      return { durationMin: integer(value, "the duration in minutes", 15, 240) };
    case "horizonDays":
      return { horizonDays: integer(value, "the number of days", 1, 30) };
    case "calendars": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error('calendars must be JSON: {"defaultAccount": "...", "calendars": [{"account": "...", "id": "..."}]}');
      }
      const { defaultAccount, calendars } = (parsed ?? {}) as { defaultAccount?: unknown; calendars?: unknown };
      if (!nonEmpty(defaultAccount)) throw new Error("calendars needs a defaultAccount");
      if (!Array.isArray(calendars)) throw new Error("calendars needs a calendars list");
      const list: Calendar[] = calendars.map((c: { account?: unknown; id?: unknown } | null) => {
        if (!nonEmpty(c?.account) || !nonEmpty(c?.id)) throw new Error(`each calendar needs an account and an id: ${JSON.stringify(c)}`);
        return { account: c.account, id: c.id };
      });
      return { defaultAccount, calendars: readableCalendars(list, defaultAccount) };
    }
    default:
      throw new Error(`unknown field: ${field} (one of ${FIELDS.join(", ")})`);
  }
}

function has(draft: Partial<Config>, field: Field): boolean {
  if (field === "window") return draft.windowStart !== undefined && draft.windowEnd !== undefined;
  if (field === "calendars") return draft.calendars !== undefined && draft.defaultAccount !== undefined;
  return draft[field] !== undefined;
}

export function nextField(draft: Partial<Config>): Field | undefined {
  return FIELDS.find((f) => !has(draft, f));
}

export function validateConfig(partial: Partial<Config>): Config {
  const missing = FIELDS.filter((f) => !has(partial, f));
  if (missing.length) throw new Error(`setup is missing: ${missing.join(", ")}`);
  const p = partial as Config;
  const windowMin = minutes(p.windowEnd) - minutes(p.windowStart);
  if (windowMin <= 0) throw new Error("the window must start before it ends");
  if (p.durationMin > windowMin) {
    throw new Error(`a ${p.durationMin}-minute meeting is longer than the ${p.windowStart}-${p.windowEnd} window`);
  }
  const config: Config = {
    ownerName: p.ownerName,
    timezone: p.timezone,
    days: p.days,
    windowStart: p.windowStart,
    windowEnd: p.windowEnd,
    durationMin: p.durationMin,
    horizonDays: p.horizonDays,
    calendars: readableCalendars(p.calendars, p.defaultAccount),
    defaultAccount: p.defaultAccount,
  };
  if (p.setupDoneAt !== undefined) config.setupDoneAt = p.setupDoneAt;
  if (p.paused !== undefined) config.paused = p.paused;
  return config;
}

export function loadConfig(): Config {
  const config = readJson<Config | null>(file("config.json"), null);
  if (!config?.setupDoneAt) throw new Error("Meetly is not set up yet");
  // A config saved before readableCalendars may still list `primary`.
  return { ...config, calendars: readableCalendars(config.calendars, config.defaultAccount) };
}
