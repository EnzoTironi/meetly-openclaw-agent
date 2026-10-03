import { z } from "zod";

const text = z.string().trim().min(1).max(10_000);
export const id = z.string().min(1).max(512);
export const instant = z.iso.datetime({ offset: true });
export const email = z.email().transform(value => value.toLowerCase());
export const handle = z.string().trim().transform(value => value.includes("@")
  ? value.toLowerCase() : value.replace(/[\s().-]/g, ""))
  .refine(value => /^\+[1-9][0-9]{7,14}$/.test(value) || z.email().safeParse(value).success,
    "Use an E.164 phone number or an iMessage email address");
const duration = z.number().int().min(5).max(480);
const zone = text.refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Use an IANA timezone");
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export const zoomUrl = z.url().refine(value => /^https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/(?:j|my)\/[A-Za-z0-9_.-]+(?:\?pwd=[A-Za-z0-9._-]+)?$/.test(value), "Use a Zoom meeting URL");

export const video = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("google_meet") }),
  z.object({ kind: z.literal("zoom_personal"), url: zoomUrl }),
  z.object({ kind: z.literal("zoom_new") }),
]);
// Google Calendar's "primary" selector names the authenticated account's
// calendar. Store one identity so aliases cannot make our own holds look busy.
export const calendar = z.object({ account: email, id }).transform(value => ({ ...value, id: value.id === "primary" ? value.account : value.id }));
export const preferences = z.object({
  ownerName: text, timezone: zone, calendar,
  busyCalendars: z.array(calendar).min(1),
  video: video.nullable(),
  durations: z.object({ video: duration, in_person: duration, phone: duration })
    .default({ video: 30, in_person: 60, phone: 30 }),
  travelMin: z.number().int().min(0).max(180).default(30),
  hours: z.object({ days: z.array(day).min(1), from: clock, to: clock })
    .refine(value => value.from < value.to, "Working hours must end after they start")
    .default({ days: ["mon", "tue", "wed", "thu", "fri"], from: "09:00", to: "18:00" }),
  noticeMin: z.number().int().min(0).max(10_080).default(120),
  monitorMin: z.number().int().min(1).max(60).default(5),
  paused: z.boolean().default(false),
  movableTitles: z.array(text).default([]),
});
export type Preferences = z.infer<typeof preferences>;
export type Video = z.infer<typeof video>;
export type Calendar = z.infer<typeof calendar>;

export const source = z.object({
  channel: z.enum(["plow", "messages", "email"]), thread: id, messageId: id,
  at: instant, handle, owner: z.boolean(), text,
});
export type Source = z.infer<typeof source>;
export type Actor = { kind: "owner"; source: Source; mainDm: boolean; hostContext: object }
  | { kind: "guest"; source: Source } | { kind: "maintenance" };
export const contact = z.object({ name: text, handle });
export type Contact = z.infer<typeof contact>;

const detailsBase = { topic: text, attendees: z.array(email).min(1).max(20), durationMin: duration, timezone: zone };
export const details = z.discriminatedUnion("kind", [
  z.object({ ...detailsBase, kind: z.literal("video"), video }),
  z.object({ ...detailsBase, kind: z.literal("in_person"), location: text, travelMin: z.number().int().min(0).max(180) }),
  z.object({ ...detailsBase, kind: z.literal("phone"), phone: handle }),
]);
export type Details = z.infer<typeof details>;
const requestBase = { topic: text, attendees: z.array(email).min(1).max(20), durationMin: duration.nullable().default(null) };
export const requestDetails = z.discriminatedUnion("kind", [
  z.object({ ...requestBase, kind: z.literal("video") }),
  z.object({ ...requestBase, kind: z.literal("in_person"), location: text }),
  z.object({ ...requestBase, kind: z.literal("phone"), phone: handle }),
]);
export const range = z.object({ from: instant, to: instant })
  .refine(value => Date.parse(value.to) > Date.parse(value.from), "The search range must end after it starts")
  .refine(value => Date.parse(value.to) - Date.parse(value.from) <= 60 * 86_400_000, "Search at most 60 days at a time");
export type Range = z.infer<typeof range>;
export const eventRef = z.object({ calendar, id });
export type EventRef = z.infer<typeof eventRef>;
export const slot = z.object({ start: instant, durationMin: duration, meeting: eventRef, travel: z.array(eventRef).max(2) });
export type Slot = z.infer<typeof slot>;
export const proposal = z.object({ revision: z.number().int().positive(), slots: z.tuple([slot, slot, slot]), expiresAt: instant });
export type Proposal = z.infer<typeof proposal>;
export const delivery = z.object({ thread: id, messageId: id, at: instant, text });
export type Delivery = z.infer<typeof delivery>;
export const sentProposal = delivery.extend({ revision: z.number().int().positive(), slots: z.tuple([slot, slot, slot]) });
export type SentProposal = z.infer<typeof sentProposal>;

export const event = z.object({
  ref: eventRef, status: z.enum(["confirmed", "tentative", "cancelled"]), start: instant, end: instant,
  title: z.string(), location: z.string(), attendees: z.array(email),
  conference: z.union([z.literal(""), z.url()]),
  transparent: z.boolean(), declined: z.boolean(), marker: z.string(), createdByOwner: z.boolean().default(false),
}).refine(value => Date.parse(value.end) > Date.parse(value.start), "A calendar event must end after it starts");
export type Event = z.infer<typeof event>;
export const invitation = z.object({ event, travel: z.array(eventRef).max(2), zoomId: id.nullable() });
export type Invitation = z.infer<typeof invitation>;

const common = {
  id, contact, source, createdAt: instant, updatedAt: instant,
  origin: z.enum(["owner", "external"]), cleanup: z.array(eventRef), reserved: z.array(eventRef).default([]),
  proposed: sentProposal.nullable(),
};
const ready = { ...common, details, range, nextRevision: z.number().int().positive() };
export const meeting = z.discriminatedUnion("status", [
  z.object({ ...common, status: z.literal("new") }),
  z.object({ ...common, status: z.literal("waiting_on_us"), question: text }),
  z.object({ ...ready, status: z.literal("held"), proposal, approval: z.enum(["required", "authorized"]) }),
  z.object({ ...ready, status: z.literal("sent"), proposal }),
  z.object({ ...ready, status: z.literal("waiting_on_them"), proposal }),
  z.object({ ...ready, status: z.literal("confirmed"), invitation }),
  z.object({ ...common, status: z.literal("passed") }),
  z.object({ ...common, status: z.literal("do_not_contact") }),
]);
export type Meeting = z.infer<typeof meeting>;
export type Held = Extract<Meeting, { status: "held" }>;
export type Offered = Extract<Meeting, { status: "sent" | "waiting_on_them" }>;
export type Confirmed = Extract<Meeting, { status: "confirmed" }>;
export const page = z.object({ version: z.literal(1), contact, meetings: z.array(meeting), log: z.string() });
export type Page = z.infer<typeof page>;

const addressed = { meetingId: id };
const revision = { ...addressed, revision: z.number().int().positive() };
export const command = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({ action: z.literal("remember"), preferences }),
  z.object({ action: z.literal("research"), query: text }),
  z.object({ action: z.literal("prepare"), contact, details: requestDetails, range, source: z.object({ thread: id, messageId: id }).optional() }),
  z.object({ action: z.literal("ask"), contact, question: text, source: z.object({ thread: id, messageId: id }).optional() }),
  z.object({ action: z.literal("approve"), ...revision }),
  z.object({ action: z.literal("publish"), ...revision }),
  z.object({ action: z.literal("choose"), ...revision, option: z.number().int().min(1).max(3) }),
  z.object({ action: z.literal("repropose"), ...revision, range }),
  z.object({ action: z.literal("move"), ...addressed, start: instant }),
  z.object({ action: z.literal("cancel"), ...addressed }),
  z.object({ action: z.literal("reply"), ...addressed, text }),
  z.object({ action: z.literal("repair"), ...addressed, zoomUrl: zoomUrl.optional() }),
  z.object({ action: z.literal("block"), handle }),
  z.object({ action: z.literal("unblock"), handle }),
  z.object({ action: z.literal("reconcile") }),
]);
export type Command = z.infer<typeof command>;

export function endOf(value: Pick<Slot, "start" | "durationMin">): string {
  return new Date(Date.parse(value.start) + value.durationMin * 60_000).toISOString();
}

export function liveHolds(value: Meeting): EventRef[] {
  const slots = "proposal" in value ? value.proposal.slots.flatMap(option => [option.meeting, ...option.travel])
    : value.status === "confirmed" ? value.invitation.travel : [];
  return [...new Map([...slots, ...value.reserved, ...value.cleanup].map(ref => [refKey(ref), ref])).values()];
}

export function refKey(ref: EventRef): string { return JSON.stringify([ref.calendar.account, ref.calendar.id, ref.id]); }

export function advice(value: Meeting): string {
  if (value.cleanup.length) return "Verify and remove the remaining recorded holds or travel blocks.";
  switch (value.status) {
    case "new": return "Research the meeting details before preparing options.";
    case "waiting_on_us": return "Resolve the recorded question privately with the owner.";
    case "held": return value.approval === "required" ? "Ask the owner privately to approve this proposal." : "Send this approved proposal and verify its inbox receipt.";
    case "sent": case "waiting_on_them": return "Check the conversation for a choice or request for new options.";
    case "confirmed": return "Verify any requested change against the booked event.";
    case "passed": return "No scheduling action is due.";
    case "do_not_contact": return "Do not contact this person.";
    default: { const exhaustive: never = value; return exhaustive; }
  }
}

export function assertOwner(actor: Actor, privateOnly = false): asserts actor is Extract<Actor, { kind: "owner" }> {
  if (actor.kind !== "owner" || (privateOnly && !actor.mainDm)) throw new Error("This action requires the owner's private conversation.");
}

export function assertParticipant(actor: Actor, value: Meeting): void {
  if (actor.kind === "owner") return;
  if (actor.kind !== "guest" || actor.source.handle !== value.contact.handle || actor.source.thread !== value.proposed?.thread) {
    throw new Error("This reply does not belong to the meeting's authenticated contact and conversation.");
  }
}

export function assertInvitation(observed: Event, value: Details, chosen: Pick<Slot, "start" | "durationMin">, conference: string): void {
  if (observed.status !== "confirmed" || Date.parse(observed.start) !== Date.parse(chosen.start)
    || Date.parse(observed.end) !== Date.parse(endOf(chosen)) || observed.declined
    || !value.attendees.every(address => observed.attendees.includes(address))) {
    throw new Error("The calendar has not verified the selected time and every invitation attendee. Keep the other holds.");
  }
  if (value.kind === "video" && (value.video.kind === "google_meet"
    ? !/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(observed.conference)
    : (observed.location !== conference && observed.conference !== conference) || observed.conference.startsWith("https://meet.google.com/"))) {
    throw new Error("The invitation does not carry the owner's verified video link. Keep the other holds.");
  }
  if (value.kind === "in_person" && observed.location !== value.location) throw new Error("The calendar has not verified the meeting location.");
}
