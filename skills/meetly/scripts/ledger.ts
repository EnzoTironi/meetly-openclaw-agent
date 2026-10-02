// Meetly's record of every scheduling request: who, which group, which times
// were offered and held, and how it ended. Holds are only ever deleted by id
// from here, never by searching the calendar.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { holdHours, reminderLeadMin } from "./config.ts";
import { isMeetUrl, isZoomRoomUrl } from "./event.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export type Status = "offered" | "booked" | "dropped" | "expired";
export type Offer = { start: string; end: string; holdId?: string; account: string };
export type HoldRef = { holdId: string; account: string };
// A time outside the owner's days or window that the other person asked for,
// waiting for the owner's yes or no.
export type PendingOwner = { start: string; end: string; askedAt: string };
export type Constraints = { days?: string[]; after?: string; before?: string; from?: string; to?: string };
// How the meeting happens. `unknown` until the request or an answer says it.
export type Format = "meet" | "in_person" | "phone" | "unknown";
// The booked event's time, and the Google account it lives on.
export type Booked = { start: string; end: string; account: string };
// The join-time reminder was handled: sent, or not sent for good.
export type Reminder = { at: string; outcome: "sent" | "cancelled" | "no-link" };

export type Request = {
  id: string;
  origin: "inbound" | "owner";
  handle: string;
  name?: string;
  sourceRowid?: number;
  chatUid?: string;
  topic: string;
  location?: string;
  durationMin: number;
  constraints?: Constraints;
  allowOverlap?: string[];
  offered: Offer[];
  status: Status;
  eventId?: string;
  holdCleanup?: HoldRef[];
  pendingOwner?: PendingOwner;
  format?: Format;
  locale?: string;
  booked?: Booked;
  meetUrl?: string;
  // The owner's own Zoom room, from their configuration, when that is the video link.
  roomUrl?: string;
  reminder?: Reminder;
  offeredAt: string;
  // When it stopped being open (dropped, expired, ...), so later bookkeeping does not move it.
  closedAt?: string;
  // What happened and was confirmed, dated, oldest first (the last LOG_MAX).
  log?: LogEntry[];
  createdAt: string;
  updatedAt: string;
};

export type LogEntry = { at: string; text: string };
const LOG_MAX = 30;
const LOG_TEXT_MAX = 300;

export type Ledger = { requests: Request[] };

export type NewRequest = Omit<Request,
  "id" | "status" | "eventId" | "holdCleanup" | "pendingOwner" | "booked" | "meetUrl" | "roomUrl" | "reminder" | "offeredAt" | "closedAt" | "log" | "createdAt" | "updatedAt">;
export type Patch = Partial<Pick<Request,
  "status" | "chatUid" | "eventId" | "offered" | "holdCleanup" | "name" | "location" | "allowOverlap" | "constraints" | "topic" | "format" | "locale">> & {
  pendingOwner?: PendingOwner | null;
  booked?: Booked | null;
  meetUrl?: string | null;
  roomUrl?: string | null;
  reminder?: Reminder | null;
};

const STATUSES: readonly Status[] = ["offered", "booked", "dropped", "expired"];
const FORMATS: readonly Format[] = ["meet", "in_person", "phone", "unknown"];
const OUTCOMES: readonly Reminder["outcome"][] = ["sent", "cancelled", "no-link"];
const PATCH_KEYS = [
  "status", "chatUid", "eventId", "offered", "holdCleanup", "name", "location", "allowOverlap", "constraints", "topic", "pendingOwner",
  "format", "locale", "booked", "meetUrl", "roomUrl", "reminder",
];
// Keys a patch can clear with null.
const NULLABLE = ["pendingOwner", "booked", "meetUrl", "roomUrl", "reminder"] as const;

const isDate = (t: unknown) => typeof t === "string" && !Number.isNaN(Date.parse(t));

function checkFormat(format: unknown): void {
  if (!FORMATS.includes(format as Format)) throw new Error(`format must be one of ${FORMATS.join(", ")}, got ${JSON.stringify(format)}`);
}

function checkLocale(locale: unknown): void {
  if (typeof locale !== "string" || !locale.trim() || locale.length > 35) {
    throw new Error(`locale must be a language tag like pt-BR, got ${JSON.stringify(locale)}`);
  }
}

function checkBooked(b: Booked): void {
  if (!b || !isDate(b.start) || !isDate(b.end) || Date.parse(b.end) <= Date.parse(b.start)
    || typeof b.account !== "string" || !b.account) {
    throw new Error(`booked needs a valid start, a later end and an account: ${JSON.stringify(b)}`);
  }
}

function checkReminder(r: Reminder): void {
  if (!r || !isDate(r.at) || !OUTCOMES.includes(r.outcome)) {
    throw new Error(`reminder needs a valid at and an outcome of ${OUTCOMES.join(", ")}: ${JSON.stringify(r)}`);
  }
}

const isEmail = (h: string) => h.includes("@");

// An email is lowercased; a phone keeps a leading + and its digits.
export function normalizeHandle(h: string): string {
  const t = h.trim();
  if (isEmail(t)) return t.toLowerCase();
  return (t.startsWith("+") ? "+" : "") + t.replace(/\D/g, "");
}

// iMessage gives +15551234567 while Contacts gives (555) 123-4567: two phones
// match when the shorter one (7+ digits) is a suffix of the longer.
export function sameHandle(a: string, b: string): boolean {
  const na = normalizeHandle(a);
  const nb = normalizeHandle(b);
  if (na === nb) return na !== "" && na !== "+";
  if (isEmail(na) || isEmail(nb)) return false;
  const da = na.replace("+", "");
  const db = nb.replace("+", "");
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  return short.length >= 7 && long.endsWith(short);
}

export function findOpenByHandle(ledger: Ledger, handle: string): Request | undefined {
  return ledger.requests.find((r) => r.status === "offered" && sameHandle(r.handle, handle));
}

export function findByChat(ledger: Ledger, chatUid: string, handle?: string): Request | undefined {
  // Resolve an open request for the sender even when it has not been linked
  // yet. This lets a replacement offer supersede a closed request in the chat.
  if (handle !== undefined) {
    const openForHandle = findOpenByHandle(ledger, handle);
    if (openForHandle && (openForHandle.chatUid === undefined || openForHandle.chatUid === chatUid)) {
      return openForHandle;
    }
  }
  // A chat remains a Meetly group after its request closes.
  return ledger.requests.findLast((r) => r.chatUid === chatUid && r.status === "offered")
    ?? ledger.requests.findLast((r) => r.chatUid === chatUid);
}

function checkOffers(offered: unknown): Offer[] {
  if (!Array.isArray(offered) || offered.length === 0) throw new Error("offered must be a non-empty list");
  for (const o of offered as Offer[]) {
    if (!o || Number.isNaN(Date.parse(o.start)) || Number.isNaN(Date.parse(o.end))) {
      throw new Error(`each offer needs a valid start and end: ${JSON.stringify(o)}`);
    }
    if (typeof o.account !== "string" || !o.account) throw new Error(`each offer needs an account: ${JSON.stringify(o)}`);
  }
  return offered as Offer[];
}

export function addRequest(ledger: Ledger, input: NewRequest, now: number, id: string): Ledger {
  if (input.origin !== "inbound" && input.origin !== "owner") throw new Error(`origin must be inbound or owner, got ${input.origin}`);
  if (typeof input.handle !== "string" || !input.handle.trim()) throw new Error("handle is required");
  if (typeof input.topic !== "string" || !input.topic.trim()) throw new Error("topic is required");
  if (!Number.isInteger(input.durationMin) || input.durationMin <= 0) throw new Error("durationMin must be a positive whole number");
  checkOffers(input.offered);
  const format = input.format === undefined ? "unknown" : input.format;
  checkFormat(format);
  if (input.locale !== undefined) checkLocale(input.locale);
  const open = findOpenByHandle(ledger, input.handle);
  if (open) throw new Error(`open request ${open.id} already exists for this person; update it instead`);
  const at = new Date(now).toISOString();
  // A new offer is never booked: a booking, its link and its reminder are
  // only ever set through update, where they are validated.
  const { booked: _b, meetUrl: _m, roomUrl: _z, reminder: _r, closedAt: _c, log: _l, ...fields } = input as NewRequest & Partial<Pick<Request, "booked" | "meetUrl" | "roomUrl" | "reminder" | "closedAt" | "log">>;
  const request: Request = { ...fields, format, id, status: "offered", offeredAt: at, createdAt: at, updatedAt: at };
  return { requests: [...ledger.requests, request] };
}

// Save the latest offer for a person without creating a second open request.
// This makes a retry after holds were created safe: the existing request id
// (and its chat link, when one exists) remains stable.
export function saveRequest(ledger: Ledger, input: NewRequest, now: number, id: string): Ledger {
  const existing = findOpenByHandle(ledger, input.handle);
  if (!existing) return addRequest(ledger, input, now, id);

  // Reuse addRequest's validation and timestamp behavior, then apply its new
  // offer to the existing record. An absent chatUid must not erase the link.
  const validated = addRequest(EMPTY, input, now, id).requests[0]!;
  const newHolds = new Set(validated.offered.flatMap((offer) => offer.holdId ? [`${offer.account}\0${offer.holdId}`] : []));
  const replacedHolds = existing.offered.flatMap((offer) => offer.holdId && !newHolds.has(`${offer.account}\0${offer.holdId}`)
    ? [{ holdId: offer.holdId, account: offer.account }]
    : []);
  const holdCleanup = [...(existing.holdCleanup ?? []), ...replacedHolds]
    .filter((hold, index, holds) => holds.findIndex((item) => item.holdId === hold.holdId && item.account === hold.account) === index);
  const replacement: Request = {
    ...existing,
    ...validated,
    id: existing.id,
    chatUid: input.chatUid ?? existing.chatUid,
    // A new offer that does not name a format keeps the one already answered.
    format: validated.format === "unknown" ? existing.format ?? "unknown" : validated.format,
    locale: input.locale ?? existing.locale,
    holdCleanup,
    createdAt: existing.createdAt,
    updatedAt: new Date(now).toISOString(),
  };
  return { requests: ledger.requests.map((r) => r.id === existing.id ? replacement : r) };
}

export function updateRequest(ledger: Ledger, id: string, patch: Patch, now: number): Ledger {
  for (const key of Object.keys(patch)) {
    if (!PATCH_KEYS.includes(key)) throw new Error(`unknown key: ${key} (allowed: ${PATCH_KEYS.join(", ")})`);
  }
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error(`bad status: ${patch.status}`);
  if (patch.offered !== undefined) checkOffers(patch.offered);
  const pending = patch.pendingOwner;
  if (pending) {
    if ([pending.start, pending.end, pending.askedAt].some((t) => typeof t !== "string" || Number.isNaN(Date.parse(t)))) {
      throw new Error(`pendingOwner needs valid start, end and askedAt: ${JSON.stringify(pending)}`);
    }
  }
  if (patch.format !== undefined) checkFormat(patch.format);
  if (patch.locale !== undefined) checkLocale(patch.locale);
  if (patch.booked) checkBooked(patch.booked);
  if (patch.reminder) checkReminder(patch.reminder);
  if (patch.meetUrl !== undefined && patch.meetUrl !== null && !isMeetUrl(patch.meetUrl)) {
    throw new Error(`meetUrl must be a Google Meet link (https://meet.google.com/xxx-xxxx-xxx), got ${JSON.stringify(patch.meetUrl)}`);
  }
  if (patch.roomUrl !== undefined && patch.roomUrl !== null && !isZoomRoomUrl(patch.roomUrl)) {
    throw new Error(`roomUrl must be the owner's Zoom room link (https://zoom.us/j/...), got ${JSON.stringify(patch.roomUrl)}`);
  }
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const at = new Date(now).toISOString();
  const updated: Request = { ...ledger.requests[index]!, updatedAt: at };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null && (NULLABLE as readonly string[]).includes(key)) delete updated[key as (typeof NULLABLE)[number]];
    else if (value !== undefined) (updated as Record<string, unknown>)[key] = value;
  }
  // A link belongs to a Meet: moving to another format drops it, and a link
  // is never set on a meeting that is not one.
  if (updated.meetUrl !== undefined && updated.format !== "meet") {
    if (patch.meetUrl) throw new Error(`meetUrl is only for a meeting with format meet (this one is ${updated.format ?? "unknown"})`);
    delete updated.meetUrl;
  }
  // When it stops being open, remember when; reopening clears it.
  if (patch.status !== undefined && patch.status !== ledger.requests[index]!.status) {
    if (patch.status === "offered" || patch.status === "booked") delete updated.closedAt;
    else updated.closedAt = at;
  }
  if (updated.roomUrl !== undefined && updated.format !== "meet") {
    if (patch.roomUrl) throw new Error(`roomUrl is only for a video meeting with format meet (this one is ${updated.format ?? "unknown"})`);
    delete updated.roomUrl;
  }
  if (patch.offered !== undefined) updated.offeredAt = at;
  const requests = [...ledger.requests];
  requests[index] = updated;
  return { requests };
}

// One dated line of what happened. It is written only after the calendar or
// the chat confirmed it, and the log is bounded: the oldest lines go first.
export function appendLog(ledger: Ledger, id: string, text: string, now: number): Ledger {
  const line = typeof text === "string" ? text.trim() : "";
  if (!line || line.length > LOG_TEXT_MAX) throw new Error(`the log text must be 1 to ${LOG_TEXT_MAX} characters`);
  const index = ledger.requests.findIndex((r) => r.id === id);
  if (index < 0) throw new Error(`no request ${id}`);
  const at = new Date(now).toISOString();
  const requests = [...ledger.requests];
  const r = requests[index]!;
  requests[index] = { ...r, log: [...(r.log ?? []), { at, text: line }].slice(-LOG_MAX), updatedAt: at };
  return { requests };
}

export function expiredRequests(ledger: Ledger, hours: number, now: number): Request[] {
  return ledger.requests.filter((r) => r.status === "offered" && now - Date.parse(r.offeredAt) >= hours * 3600_000);
}

// Open requests waiting for the owner to confirm an out-of-hours time.
export function pendingOwnerList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => r.status === "offered" && r.pendingOwner !== undefined);
}

// Booked Meets whose link is due in the group: from `leadMin` before the
// start until `graceMin` after it, once.
export function dueReminders(ledger: Ledger, now: number, leadMin: number, graceMin = 5): Request[] {
  return ledger.requests.filter((r) => {
    if (r.status !== "booked" || r.format !== "meet" || !(r.meetUrl || r.roomUrl) || !r.booked || r.reminder) return false;
    const start = Date.parse(r.booked.start);
    return now >= start - leadMin * 60_000 && now < start + graceMin * 60_000;
  });
}

export function cleanupList(ledger: Ledger): Request[] {
  return ledger.requests.filter((r) => (r.holdCleanup?.length ?? 0) > 0);
}

// The spec's stages, derived from the ledger and never stored. "new" is a
// request with no entry yet, and a person on the do-not-contact list has
// their own list (blocklist.ts).
export type Stage = "waiting_on_us" | "held" | "sent" | "waiting_on_them" | "confirmed" | "passed";

// One request as the owner sees it in the pipeline: no chat uid, and a booking
// only by its start and end.
export type PipelineItem = {
  id: string;
  name?: string;
  topic: string;
  status: Status;
  stage: Stage;
  nextStep: string;
  hoursWaiting?: number;
  booked?: { start: string; end: string };
  closedAt?: string;
};

export const STALE_HOURS = 24;
const WEEK = 7 * 24 * 3600_000;
const hoursSince = (iso: string, now: number) => Math.max(0, Math.floor((now - Date.parse(iso)) / 3600_000));
const closedWhen = (r: Request) => r.closedAt ?? r.updatedAt;

const NEXT_STEP: Record<Stage, string> = {
  waiting_on_us: "owner decision needed",
  held: "times are held but not delivered: check the group or send the offer again",
  sent: "wait for their answer",
  waiting_on_them: "no answer in a day: suggest new times",
  confirmed: "none",
  passed: "none, unless the owner wants to meet again",
};

export function stageOf(r: Request, now: number): Stage {
  if (r.status === "booked") return "confirmed";
  if (r.status !== "offered") return "passed";
  if (r.pendingOwner) return "waiting_on_us";
  if (!r.chatUid) return "held";
  return hoursSince(r.offeredAt, now) >= STALE_HOURS ? "waiting_on_them" : "sent";
}

// Who is waiting on whom: offers the owner has to approve, offers held but not
// delivered (waiting on Meetly), offers the other person has to answer (oldest
// first), meetings still to come (soonest first; one with no recorded time
// last), and what closed in the past week.
export function pipeline(ledger: Ledger, now: number): {
  waitingOnOwner: PipelineItem[]; undelivered: PipelineItem[]; waitingOnThem: PipelineItem[]; booked: PipelineItem[]; closed: PipelineItem[];
} {
  const item = (r: Request, extra: Partial<PipelineItem> = {}): PipelineItem => {
    const stage = stageOf(r, now);
    const out: PipelineItem = { id: r.id, topic: r.topic, status: r.status, stage, nextStep: NEXT_STEP[stage], ...extra };
    if (r.name !== undefined) out.name = r.name;
    return out;
  };
  const waiting = (r: Request) => ({ hoursWaiting: hoursSince(r.pendingOwner ? r.pendingOwner.askedAt : r.offeredAt, now) });
  const open = ledger.requests.filter((r) => r.status === "offered");
  const upcoming = ledger.requests.filter((r) => r.status === "booked" && (!r.booked || Date.parse(r.booked.start) >= now));
  const startOf = (r: Request) => (r.booked ? Date.parse(r.booked.start) : Infinity);
  const byStage = (stage: (r: Request) => boolean) => open.filter(stage).map((r) => item(r, waiting(r)));
  return {
    waitingOnOwner: byStage((r) => stageOf(r, now) === "waiting_on_us"),
    undelivered: byStage((r) => stageOf(r, now) === "held").sort((a, b) => b.hoursWaiting! - a.hoursWaiting!),
    waitingOnThem: byStage((r) => ["sent", "waiting_on_them"].includes(stageOf(r, now))).sort((a, b) => b.hoursWaiting! - a.hoursWaiting!),
    booked: upcoming.sort((a, b) => startOf(a) - startOf(b)).map((r) => item(r, r.booked ? { booked: { start: r.booked.start, end: r.booked.end } } : {})),
    closed: ledger.requests.filter((r) => r.status !== "offered" && r.status !== "booked" && now - Date.parse(closedWhen(r)) <= WEEK)
      .sort((a, b) => closedWhen(b).localeCompare(closedWhen(a))).slice(0, 10).map((r) => item(r, { closedAt: closedWhen(r) })),
  };
}

// Everything the ledger holds for one person, newest first: what the meeting
// was for, how it was to happen, where, for how long.
export function historyFor(ledger: Ledger, handle: string): Pick<Request, "id" | "status" | "name" | "topic" | "format" | "location" | "durationMin" | "createdAt">[] {
  return ledger.requests.filter((r) => sameHandle(r.handle, handle))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, status, name, topic, format, location, durationMin, createdAt }) => ({ id, status, name, topic, format, location, durationMin, createdAt }));
}

const EMPTY: Ledger = { requests: [] };

function jsonArg(values: { json?: string; "json-file"?: string }): any {
  const text = values.json ?? (values["json-file"] !== undefined ? readFileSync(values["json-file"], "utf8") : undefined);
  if (text === undefined) throw new Error("pass --json '<object>' or --json-file F");
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("the JSON must be an object");
  return value;
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({
      args: rest,
      options: {
        handle: { type: "string" },
        chat: { type: "string" },
        id: { type: "string" },
        json: { type: "string" },
        text: { type: "string" },
        "json-file": { type: "string" },
        hours: { type: "string" },
        "lead-min": { type: "string" },
      },
    });
    const path = file("ledger.json");
    const now = Date.now();
    switch (cmd) {
      case "find": {
        const ledger = readJson<Ledger>(path, EMPTY);
        if (values.chat !== undefined) return { request: findByChat(ledger, values.chat, values.handle) ?? null };
        if (values.handle !== undefined) return { request: findOpenByHandle(ledger, values.handle) ?? null };
        throw new Error("usage: ledger.ts find --handle H | --chat U");
      }
      case "add": {
        const input = jsonArg(values);
        const id = `r_${randomBytes(4).toString("hex")}`;
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => addRequest(l, input, now, id));
        return { request: ledger.requests.find((r) => r.id === id) };
      }
      case "save": {
        const input = jsonArg(values);
        const id = `r_${randomBytes(4).toString("hex")}`;
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => saveRequest(l, input, now, id));
        return { request: ledger.requests.find((r) => sameHandle(r.handle, input.handle) && r.status === "offered") };
      }
      case "update": {
        if (!values.id) throw new Error("usage: ledger.ts update --id X --json '<patch>'");
        const patch = jsonArg(values);
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => updateRequest(l, values.id!, patch, now));
        return { request: ledger.requests.find((r) => r.id === values.id) };
      }
      case "expired": {
        const hours = values.hours !== undefined ? Number(values.hours) : holdHours();
        if (!Number.isFinite(hours) || hours < 0) throw new Error(`--hours must be a number >= 0, got ${values.hours}`);
        return { requests: expiredRequests(readJson<Ledger>(path, EMPTY), hours, now) };
      }
      case "log": {
        if (!values.id) throw new Error("usage: ledger.ts log --id X [--text T]");
        if (values.text === undefined) {
          const request = readJson<Ledger>(path, EMPTY).requests.find((r) => r.id === values.id);
          if (!request) throw new Error(`no request ${values.id}`);
          return { log: request.log ?? [] };
        }
        const ledger = updateJson<Ledger>(path, EMPTY, (l) => appendLog(l, values.id!, values.text!, now));
        return { log: ledger.requests.find((r) => r.id === values.id)!.log };
      }
      case "pipeline":
        return pipeline(readJson<Ledger>(path, EMPTY), now);
      case "history": {
        if (values.handle === undefined) throw new Error("usage: ledger.ts history --handle H");
        return { requests: historyFor(readJson<Ledger>(path, EMPTY), values.handle) };
      }
      case "pending":
        return { requests: pendingOwnerList(readJson<Ledger>(path, EMPTY)) };
      case "cleanup":
        return { requests: cleanupList(readJson<Ledger>(path, EMPTY)).map((r) => ({ id: r.id, holdCleanup: r.holdCleanup })) };
      case "reminders": {
        const lead = values["lead-min"] !== undefined ? Number(values["lead-min"]) : reminderLeadMin();
        if (!Number.isFinite(lead) || lead <= 0) throw new Error(`--lead-min must be a number > 0, got ${values["lead-min"]}`);
        return { requests: dueReminders(readJson<Ledger>(path, EMPTY), now, lead) };
      }
      default:
        throw new Error("usage: ledger.ts find | add | save | update | expired | pending | pipeline | history | log | cleanup | reminders");
    }
  });
}
