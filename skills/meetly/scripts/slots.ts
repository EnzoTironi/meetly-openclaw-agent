// Free times to offer: the owner's days and window, in the owner's zone,
// clear of busy time, at least MIN_NOTICE_MIN ahead, spread across days.
// The label and weekday come from here so the agent never computes a weekday.
import { parseArgs } from "node:util";
import { isMain, readInput, run } from "./cli.ts";
import { loadConfig, MIN_NOTICE_MIN, minutes, parseTime, SLOT_COUNT, STEP_MIN, type Config } from "./config.ts";
import type { Busy } from "./busy.ts";
import { addDays, DAYS, localIso, wallParts, zonedToUtc, type Day } from "./time.ts";

export type Slot = { start: string; end: string; dayOfWeek: Day; label: string };

export type SlotQuery = {
  now: number;
  config: Config;
  busy: Busy[];
  unknownAfter?: string;
  durationMin?: number;
  days?: Day[];
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  allowOverlap?: string[];
  exclude?: string[];
  count?: number;
  ownerOverride?: boolean;
};

const pad = (n: number) => String(n).padStart(2, "0");

function label(ms: number, tz: string): string {
  const p = wallParts(ms, tz);
  return `${p.weekday} ${p.d}/${p.m} ${pad(p.hh)}:${pad(p.mm)}`;
}

export function findSlots(q: SlotQuery): { slots: Slot[]; unknownAfter?: string } {
  const { config, now } = q;
  const tz = config.timezone;
  const duration = q.durationMin ?? config.durationMin;
  const count = q.count ?? SLOT_COUNT;

  let days: Day[] = config.days;
  if (q.days) days = q.ownerOverride ? q.days : config.days.filter((d) => q.days!.includes(d));
  let startMin = minutes(config.windowStart);
  let endMin = minutes(config.windowEnd);
  if (q.ownerOverride) {
    if (q.after) startMin = minutes(q.after);
    if (q.before) endMin = minutes(q.before);
  } else {
    if (q.after) startMin = Math.max(startMin, minutes(q.after));
    if (q.before) endMin = Math.min(endMin, minutes(q.before));
  }
  startMin = Math.ceil(startMin / STEP_MIN) * STEP_MIN;

  const earliest = now + MIN_NOTICE_MIN * 60_000;
  const excluded = new Set((q.exclude ?? []).map((e) => Date.parse(e)));
  const allowed = new Set(q.allowOverlap ?? []);
  const busy = q.busy
    .filter((b) => b.id === undefined || !allowed.has(b.id))
    .map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  const unknownAfter = q.unknownAfter !== undefined ? Date.parse(q.unknownAfter) : undefined;

  const today = wallParts(now, tz);
  const perDay: { start: number; end: number; day: Day }[][] = [];
  scan: for (let i = 0; i <= config.horizonDays; i++) {
    const { y, m, d } = addDays(today.y, today.m, today.d, i);
    const date = `${y}-${pad(m)}-${pad(d)}`;
    if ((q.from && date < q.from) || (q.to && date > q.to)) continue;
    const day = wallParts(zonedToUtc(y, m, d, 12, 0, tz), tz).weekday;
    if (!days.includes(day)) continue;
    const found: { start: number; end: number; day: Day }[] = [];
    for (let t = startMin; t + duration <= endMin; t += STEP_MIN) {
      const start = zonedToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      const end = start + duration * 60_000;
      if (unknownAfter !== undefined && end > unknownAfter) {
        perDay.push(found);
        break scan;
      }
      if (start < earliest || excluded.has(start)) continue;
      if (busy.some((b) => b.start < end && b.end > start)) continue;
      found.push({ start, end, day });
    }
    perDay.push(found);
  }

  // One per day first, soonest days first; then fill in time order.
  const picked = perDay.filter((f) => f.length > 0).map((f) => f[0]!).slice(0, count);
  if (picked.length < count) {
    const rest = perDay.flat().filter((c) => !picked.includes(c));
    picked.push(...rest.slice(0, count - picked.length));
  }
  picked.sort((a, b) => a.start - b.start);

  const slots = picked.map((c) => ({
    start: localIso(c.start, tz),
    end: localIso(c.end, tz),
    dayOfWeek: c.day,
    label: label(c.start, tz),
  }));
  return q.unknownAfter !== undefined ? { slots, unknownAfter: q.unknownAfter } : { slots };
}

function positiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`${flag} must be a positive whole number, got ${raw}`);
  return Number(raw);
}

function date(raw: string, flag: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new Error(`${flag} must be YYYY-MM-DD, got ${raw}`);
  return raw;
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: {
        in: { type: "string" },
        duration: { type: "string" },
        days: { type: "string" },
        after: { type: "string" },
        before: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        "allow-overlap": { type: "string", multiple: true },
        exclude: { type: "string", multiple: true },
        count: { type: "string" },
        owner: { type: "boolean" },
        now: { type: "string" },
      },
    });
    const config = loadConfig();
    const input = JSON.parse(readInput(values.in !== undefined ? [values.in] : [])[0]!) as {
      busy?: Busy[];
      unknownAfter?: string;
      degraded?: string[];
    };
    if (!Array.isArray(input.busy)) throw new Error("the busy input has no busy list (pass busy.ts output)");
    const now = values.now !== undefined ? Date.parse(values.now) : Date.now();
    if (Number.isNaN(now)) throw new Error(`--now is not a time: ${values.now}`);
    const q: SlotQuery = { now, config, busy: input.busy, ownerOverride: values.owner === true };
    if (input.unknownAfter !== undefined) q.unknownAfter = input.unknownAfter;
    if (values.duration !== undefined) q.durationMin = positiveInt(values.duration, "--duration");
    if (values.count !== undefined) q.count = positiveInt(values.count, "--count");
    if (values.days !== undefined) {
      q.days = values.days.split(/[\s,]+/).filter(Boolean).map((d) => {
        const day = d.slice(0, 3).toLowerCase();
        if (!(DAYS as readonly string[]).includes(day)) throw new Error(`not a day of the week: ${d}`);
        return day as Day;
      });
    }
    if (values.after !== undefined) q.after = parseTime(values.after);
    if (values.before !== undefined) q.before = parseTime(values.before);
    if (values.from !== undefined) q.from = date(values.from, "--from");
    if (values.to !== undefined) q.to = date(values.to, "--to");
    if (values["allow-overlap"]) q.allowOverlap = values["allow-overlap"];
    if (values.exclude) {
      for (const e of values.exclude) if (Number.isNaN(Date.parse(e))) throw new Error(`--exclude is not a time: ${e}`);
      q.exclude = values.exclude;
    }
    return { ...findSlots(q), degraded: input.degraded ?? [] };
  });
}
