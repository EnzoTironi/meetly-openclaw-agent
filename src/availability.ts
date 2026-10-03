import { day, endOf, refKey, type Event, type EventRef, type Preferences, type Range, type Slot } from "./model.ts";

type Wall = { year: number; month: number; date: number; hour: number; minute: number; weekday: ReturnType<typeof day.parse> };
const formatters = new Map<string, Intl.DateTimeFormat>();
export function wall(time: number, zone: string): Wall {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(time).map(value => [value.type, value.value]));
  return { year: Number(parts.year), month: Number(parts.month), date: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: day.parse(parts.weekday?.slice(0, 3).toLowerCase()) };
}

export function wallTime(year: number, month: number, date: number, minute: number, zone: string): number | null {
  const guess = Date.UTC(year, month - 1, date, Math.floor(minute / 60), minute % 60);
  const offset = (at: number): number => {
    const value = wall(at, zone);
    return Date.UTC(value.year, value.month - 1, value.date, value.hour, value.minute) - Math.floor(at / 60_000) * 60_000;
  };
  const result = guess - offset(guess - offset(guess));
  const actual = wall(result, zone);
  return actual.year === year && actual.month === month && actual.date === date
    && actual.hour * 60 + actual.minute === minute ? result : null;
}
const minutes = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const shift = (value: string, amount: number): string => new Date(Date.parse(value) + amount * 60_000).toISOString();
export type Candidate = Pick<Slot, "start" | "durationMin">;
type Timing = { kind: "phone" | "video"; durationMin: number } | { kind: "in_person"; durationMin: number; travelMin: number };
export function windows(value: Candidate, details: Timing): { role: "meeting" | "before" | "after"; start: string; end: string }[] {
  const end = endOf(value);
  const meeting = { role: "meeting" as const, start: value.start, end };
  if (details.kind !== "in_person" || details.travelMin === 0) return [meeting];
  return [meeting, { role: "before", start: shift(value.start, -details.travelMin), end: value.start },
    { role: "after", start: end, end: shift(end, details.travelMin) }];
}

export function conflicts(value: Candidate, details: Timing, events: Event[], ignored: EventRef[] = []): Event[] {
  const skip = new Set(ignored.map(refKey));
  const spans = windows(value, details);
  return events.filter(event => event.status !== "cancelled" && !event.transparent && !event.declined && !skip.has(refKey(event.ref))
    && spans.some(span => Date.parse(event.start) < Date.parse(span.end) && Date.parse(event.end) > Date.parse(span.start)));
}

export function insideHours(value: Candidate, details: Timing, prefs: Preferences, now: number): boolean {
  const spans = windows(value, details);
  const beginning = Math.min(...spans.map(span => Date.parse(span.start)));
  const end = Math.max(...spans.map(span => Date.parse(span.end)));
  if (beginning < now + prefs.noticeMin * 60_000) return false;
  const a = wall(beginning, prefs.timezone), b = wall(end, prefs.timezone);
  return prefs.hours.days.includes(a.weekday) && a.year === b.year && a.month === b.month && a.date === b.date
    && a.hour * 60 + a.minute >= minutes(prefs.hours.from) && b.hour * 60 + b.minute <= minutes(prefs.hours.to);
}

type Search = {
  prefs: Preferences; details: Timing; range: Range; events: Event[]; now: number;
  ignored?: EventRef[]; excluded?: string[];
};
type Move = { event: Event; start: string; end: string };
const insufficient = "There are fewer than three verified free options. Ask the owner privately to widen the range or move a block.";

function dayCandidates(date: Date, search: Search): Candidate[] {
  const { prefs, details, range, now, events } = search;
  const excluded = new Set(search.excluded?.map(Date.parse));
  const result: Candidate[] = [];
  for (let minute = minutes(prefs.hours.from); minute < minutes(prefs.hours.to); minute += 15) {
    const at = wallTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), minute, prefs.timezone);
    if (at === null || excluded.has(at)) continue;
    const value = { start: new Date(at).toISOString(), durationMin: details.durationMin };
    const spans = windows(value, details);
    if (spans.some(span => Date.parse(span.start) < Date.parse(range.from) || Date.parse(span.end) > Date.parse(range.to))) continue;
    if (insideHours(value, details, prefs, now) && !conflicts(value, details, events, search.ignored).length) result.push(value);
  }
  return result;
}
function options(search: Search, count: number): Candidate[] {
  const first = wall(Date.parse(search.range.from), search.prefs.timezone);
  const byDay: Candidate[][] = [];
  for (let offset = 0; offset <= 60; offset++) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.date + offset));
    if (date.getTime() > Date.parse(search.range.to) + 86_400_000) break;
    byDay.push(dayCandidates(date, search));
  }
  const picked: Candidate[] = [];
  const ordered = [...byDay.flatMap(list => list.slice(0, 1)), ...byDay.flat()];
  for (const value of ordered) {
    if (picked.length === count) break;
    const overlaps = picked.some(prior => windows(prior, search.details).some(a => windows(value, search.details)
      .some(b => Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start))));
    if (!overlaps) picked.push(value);
  }
  return picked.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
function three(values: Candidate[]): [Candidate, Candidate, Candidate] {
  const [a, b, c] = values;
  if (!a || !b || !c) throw new Error(insufficient);
  return [a, b, c];
}
export function movableBlock(value: Event, prefs: Preferences, now: number): boolean {
  const titles = new Set(prefs.movableTitles.map(value => value.trim().toLowerCase()));
  return value.createdByOwner && titles.has(value.title.trim().toLowerCase()) && (!value.marker || value.marker.includes("/priority/"))
    && !value.attendees.length && !value.conference && JSON.stringify(value.ref.calendar) === JSON.stringify(prefs.calendar)
    && Date.parse(value.start) >= now + prefs.noticeMin * 60_000 && Date.parse(value.end) - Date.parse(value.start) <= 480 * 60_000 && value.status === "confirmed";
}

export function plan(search: Search): { slots: [Candidate, Candidate, Candidate]; moves: Move[] } {
  const free = options(search, 3);
  if (free.length === 3) return { slots: three(free), moves: [] };
  const movable = search.events.filter(value => movableBlock(value, search.prefs, search.now));
  const slots = three(options({ ...search, ignored: [...(search.ignored ?? []), ...movable.map(value => value.ref)] }, 3));
  const displaced = movable.filter(value => slots.some(slot => conflicts(slot, search.details, [value]).length));
  const reserved: Event[] = slots.flatMap((option, index) => windows(option, search.details).map(span => ({
    ref: { calendar: search.prefs.calendar, id: `planned-${index}-${span.role}` }, status: "confirmed", start: span.start, end: span.end,
    title: "", location: "", attendees: [], conference: "", transparent: false, declined: false, marker: "planned", createdByOwner: false,
  })));
  const moves: Move[] = [];
  for (const value of displaced) {
    const [option] = options({ ...search, details: { kind: "phone", durationMin: (Date.parse(value.end) - Date.parse(value.start)) / 60_000 },
      events: [...search.events, ...reserved], ignored: [...(search.ignored ?? []), value.ref], excluded: [] }, 1);
    if (!option) throw new Error(insufficient);
    moves.push({ event: value, start: option.start, end: endOf(option) });
    reserved.push({ ...value, start: option.start, end: endOf(option) });
  }
  return { slots, moves };
}

export function label(start: string, timezone: string): string {
  return new Intl.DateTimeFormat("en", { timeZone: timezone, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(Date.parse(start));
}
