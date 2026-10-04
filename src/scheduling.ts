import { createHash } from "node:crypto";
import { z } from "zod";
import { conflicts, insideHours, label, movableBlock, plan, restrictRange, windows } from "./availability.ts";
import { advice, assertInvitation, assertOwner, assertParticipant, command, DecisionRequired, delivery, details, endOf, event, eventRef, invitation, liveHolds, meeting, permissions, proposal, publicContext, refKey, source,
  type Actor, type Calendar, type Command, type Confirmed, type Details, type Event, type EventRef, type Held, type Meeting, type Offered, type Permissions, type Preferences, type Range, type Slot, type Source } from "./model.ts";
import { invitationWrite, verifyBooked } from "./invitation.ts";
import { Records, RejectedEffect } from "./records.ts";
import { writeEvent, type Ports, type WriteEvent } from "./providers.ts";

const task = z.object({ command, authority: z.object({ kind: z.enum(["owner", "guest", "discovery"]), source, mainDm: z.boolean() }) });
const threeCandidates = z.tuple([z.object({ start: z.string(), durationMin: z.number() }), z.object({ start: z.string(), durationMin: z.number() }), z.object({ start: z.string(), durationMin: z.number() })]);
const availabilityPlan = z.object({ slots: threeCandidates, moves: z.array(z.object({ event, start: z.string(), end: z.string() })) });
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
const identity = (value: Source, contact: string): string => hash([value.channel, value.thread, value.messageId, contact]);
const iso = (now: number): string => new Date(now).toISOString();
export type Compose = (context: unknown) => Promise<string>;
type HoldRequest = { range: Range; revision: number; excluded: string[]; permissions?: Permissions; ownerRange?: Range };
const closedStatuses = new Set(["passed", "do_not_contact"]);
function isOffered(value: Meeting): value is Offered { return value.status === "sent" || value.status === "waiting_on_them"; }
function assertChoice(value: Meeting, option: number): void {
  if (isOffered(value)) return;
  if (value.status !== "confirmed") throw new Error("Publish the held proposal before selecting or replacing its options.");
  const selected = value.proposed?.slots[option - 1];
  if (!selected || refKey(selected.meeting) !== refKey(value.invitation.event.ref)) throw new Error("Another option is already booked. Ask the owner privately before changing it.");
}

export class Scheduling {
  private tail: Promise<unknown> = Promise.resolve();
  readonly records: Records;
  readonly ports: Ports;
  readonly now: () => number;
  readonly compose: Compose;
  constructor(records: Records, ports: Ports, compose: Compose, now: () => number = Date.now) { this.records = records; this.ports = ports; this.compose = compose; this.now = now; }
  run(input: unknown, actor: Actor): Promise<unknown> {
    const parsed = command.parse(input);
    const work = this.tail.then(() => this.execute(parsed, actor));
    this.tail = work.catch(() => undefined);
    return work;
  }
  preferences(): Preferences {
    const value = this.records.owner();
    if (!value) throw new Error("Save the owner's scheduling preferences privately before preparing times.");
    return value;
  }
  async execute(input: Command, actor: Actor): Promise<unknown> {
    if (input.action === "status") return this.status(actor);
    if (input.action === "research") return this.research(input.query, actor);
    if (input.action === "remember") { assertOwner(actor, true); this.records.remember(input.preferences, actor.source); return { remembered: true, preferences: input.preferences }; }
    if (input.action === "reconcile") { assertOwner(actor, true); return this.reconcile(); }
    if (actor.kind === "maintenance") throw new Error("Maintenance cannot initiate a new scheduling command.");
    await this.authorize(input, actor);
    if (input.action === "prepare" || input.action === "ask") await this.evidence(input, actor);
    const admission = task.parse({ command: input, authority: { kind: actor.kind, source: actor.source, mainDm: actor.kind === "owner" && actor.mainDm } });
    const key = `task:${hash(admission)}`;
    try {
      const result = await this.records.effect(key, admission, meeting.nullable(), { run: () => this.change(input, actor), retry: "safe" });
      if (!result) return null;
      const current = this.records.find(result.id);
      return this.view(current, actor);
    } catch (error) {
      if (error instanceof DecisionRequired) return { needsOwner: error.message };
      throw error;
    }
  }
  view(value: Meeting, actor: Actor): Record<string, unknown> {
    if (actor.kind === "owner" && !actor.mainDm) return { ...publicContext(value), approval: "approval" in value ? value.approval : undefined,
      cleanupPending: value.cleanup.length, next_step: advice(value) };
    return { ...value, next_step: advice(value) };
  }
  async status(actor: Actor): Promise<unknown> {
    assertOwner(actor);
    if (!actor.mainDm) {
      const contact = await this.ports.groupContact(actor.source.thread);
      return { contact, timezone: this.records.owner()?.timezone, videoProvider: this.records.owner()?.video?.kind ?? null,
        pipeline: this.records.contact(contact.handle)?.meetings.filter(value =>
        (value.proposed?.thread ?? value.source.thread) === actor.source.thread).map(publicContext) ?? [] };
    }
    const pipeline = this.records.pages().map(page => ({ contact: page.contact,
      meetings: page.meetings.filter(value => value.status !== "passed" || liveHolds(value).length).map(value => this.view(value, actor)) }))
      .filter(page => page.meetings.length);
    return { preferences: this.records.owner(), pipeline, unfinished: this.records.uncertain(),
      discovery: this.records.owner() ? null : await this.ports.discover() };
  }
  async research(query: string, actor: Actor): Promise<unknown> {
    assertOwner(actor);
    const contact = actor.mainDm ? null : await this.ports.groupContact(actor.source.thread);
    const address = contact?.handle ?? query, prefs = this.records.owner();
    const wiki = this.records.pages().filter(value => value.contact.handle === address || value.contact.name.toLowerCase().includes(address.toLowerCase()));
    return { contact, preferences: { timezone: prefs?.timezone, videoProvider: prefs?.video?.kind ?? null, defaultFormat: prefs?.defaultFormat, durations: prefs?.durations },
      wiki: contact ? wiki.flatMap(page => page.meetings.map(publicContext)) : wiki, context: await this.ports.research(address, prefs?.calendar) };
  }
  async authorize(input: Command, actor: Actor): Promise<void> {
    if ("permissions" in input && input.permissions) assertOwner(actor);
    if (actor.kind === "discovery") {
      if (!this.records.isDiscovered(actor.source) || !(input.action === "ask" || input.action === "prepare")) throw new RejectedEffect("Mac discovery can only prepare this sender's privately gated request from a verified receipt.");
      return this.authorizeRequest(input, actor);
    }
    if (actor.kind === "owner" && !actor.mainDm) await this.authorizeGroup(input, actor);
    if (actor.kind === "guest" && actor.source.channel !== "plow") throw new RejectedEffect("Mac messages are research context, not authenticated Meetly requests.");
    if (input.action === "prepare" || input.action === "ask") this.authorizeRequest(input, actor);
    else if ("revision" in input) this.authorizeRevision(input, actor);
    else this.authorizePrivate(input, actor);
  }
  authorizeRequest(input: Extract<Command, { action: "prepare" | "ask" }>, actor: Actor): void {
    if (actor.kind === "guest" || actor.kind === "discovery") {
      if (input.source || input.contact.handle !== actor.source.handle) throw new Error("A sender can only initiate their own authenticated request.");
    } else assertOwner(actor);
    if (this.records.contact(input.contact.handle)?.meetings.some(value => value.status === "do_not_contact")) throw new Error("Do not contact: the owner blocked this contact.");
  }
  async authorizeGroup(input: Command, actor: Extract<Actor, { kind: "owner" }>): Promise<void> {
    const contact = await this.ports.groupContact(actor.source.thread);
    if ("contact" in input && (input.source || input.contact.handle !== contact.handle)) throw new Error("Schedule only with this group's verified contact; other requests belong in the private owner conversation.");
    if ("meetingId" in input && this.records.find(input.meetingId).contact.handle !== contact.handle) throw new Error("This meeting belongs to another contact. Continue privately.");
  }
  authorizePrivate(input: Command, actor: Actor): void {
    assertOwner(actor, !["move", "cancel", "reply"].includes(input.action));
    if ("meetingId" in input) assertParticipant(actor, this.records.find(input.meetingId));
    if (input.action === "repair") this.pendingBooking(input.meetingId);
    if (input.action === "reply") {
      const value = this.records.find(input.meetingId);
      if (!value.proposed || !(isOffered(value) || value.status === "confirmed")) throw new Error("Reply requires this contact's verified, authorized meeting conversation.");
    }
  }
  authorizeRevision(input: Extract<Command, { revision: number }>, actor: Actor): void {
    const value = this.records.find(input.meetingId);
    switch (input.action) {
      case "approve": assertOwner(actor, true); break;
      case "publish": assertParticipant(actor, value); break;
      case "choose": case "repropose": assertParticipant(actor, value); break;
    }
    if (input.action === "repropose" && value.status === "held" && value.proposal.revision === input.revision + 1 && value.proposed?.revision === input.revision) return;
    const revision = "proposal" in value ? value.proposal.revision : value.proposed?.revision;
    if (revision !== input.revision || closedStatuses.has(value.status)) throw new Error("This proposal is no longer current. Read the current meeting before acting.");
    if (input.action === "choose") assertChoice(value, input.option);
    if (input.action === "repropose" && !isOffered(value)) throw new Error("Publish the held proposal before selecting or replacing its options.");
  }
  async change(input: Command, actor: Actor): Promise<Meeting | null> {
    switch (input.action) {
      case "prepare": return this.prepare(input, actor);
      case "ask": return this.ask(input, actor);
      case "approve": {
        assertOwner(actor, true);
        const prior = this.records.find(input.meetingId);
        if (prior.proposed?.revision === input.revision && ["sent", "waiting_on_them", "confirmed"].includes(prior.status)) return prior;
        const value = this.held(input.meetingId, input.revision, this.records.operation(`${input.meetingId}/r${input.revision}/publish`) !== null);
        const next = meeting.parse({ ...value, approval: "authorized", updatedAt: actor.kind === "owner" ? actor.source.at : iso(this.now()) });
        this.records.save(next, `The owner approved proposal ${input.revision} in inbox message ${actor.kind === "owner" ? actor.source.messageId : ""}.`);
        return this.publish(input.meetingId, input.revision, actor);
      }
      case "publish": return this.publish(input.meetingId, input.revision, actor);
      case "choose": return this.choose(input.meetingId, input.revision, input.option, actor);
      case "repropose": return this.repropose(input.meetingId, input.revision, input.range, actor, input.permissions);
      case "move": return this.move(input.meetingId, input.start, actor, input.permissions);
      case "cancel": return this.cancel(input.meetingId, actor);
      case "reply": {
        assertOwner(actor);
        const value = this.records.find(input.meetingId);
        if (!value.proposed || !["sent", "waiting_on_them", "confirmed"].includes(value.status)) throw new Error("Reply requires this contact's verified, authorized meeting conversation.");
        await this.sendReply(value.proposed.thread, actor.source, input.text);
        return value;
      }
      case "repair": return this.repair(input, actor);
      case "block": case "unblock": return this.contactPolicy(input, actor);
      default: throw new Error("This command is handled before the scheduling workflow.");
    }
  }
  async contactPolicy(input: Extract<Command, { action: "block" | "unblock" }>, actor: Actor): Promise<Meeting | null> {
    assertOwner(actor, true);
    const page = this.records.contact(input.handle);
    const observation = `The owner ${input.action === "block" ? "blocked" : "unblocked"} this contact in inbox message ${actor.source.messageId}.`;
    if (!page) {
      if (input.action === "unblock") return null;
      const value = meeting.parse({ id: identity(actor.source, input.handle), contact: { name: input.handle, handle: input.handle }, source: actor.source,
        status: "do_not_contact", createdAt: actor.source.at, updatedAt: actor.source.at, origin: "owner", cleanup: [], proposed: null });
      this.records.save(value, observation); return value;
    }
    for (const value of page.meetings) {
      if (input.action === "block") await this.cancel(value.id, actor, false);
      const current = this.records.find(value.id);
      this.records.save(meeting.parse({ ...current, status: input.action === "block" ? "do_not_contact" : "passed", updatedAt: actor.source.at }), observation);
    }
    return page.meetings[0] ? this.records.find(page.meetings[0].id) : null;
  }
  async evidence(input: { contact: { handle: string }; source?: { thread: string; messageId: string } }, actor: Actor): Promise<Source> {
    let verified: Source;
    if ((actor.kind === "guest" || actor.kind === "discovery") && !input.source) verified = actor.source;
    else { assertOwner(actor, Boolean(input.source)); verified = input.source ? await this.ports.message(input.source.thread, input.source.messageId) : actor.source; }
    if (!verified.owner && verified.handle !== input.contact.handle) throw new RejectedEffect("The source contact does not match this scheduling request.");
    const active = this.records.contact(input.contact.handle)?.meetings.find(value => ["new", "waiting_on_us", "held", "sent", "waiting_on_them"].includes(value.status));
    if (active && !verified.owner && verified.thread !== (active.proposed?.thread ?? active.source.thread)) throw new RejectedEffect("This contact's active request belongs to another conversation; it cannot be redirected by a new source.");
    if (active && actor.kind === "owner" && !actor.mainDm) assertParticipant(actor, active);
    return verified;
  }
  async intake(input: { contact: { name: string; handle: string }; source?: { thread: string; messageId: string } }, actor: Actor): Promise<Meeting> {
    const evidence = await this.evidence(input, actor);
    if (this.records.contact(input.contact.handle)?.meetings.some(value => value.status === "do_not_contact")) throw new Error("Do not contact: the owner blocked this contact.");
    const id = identity(evidence, input.contact.handle);
    const prior = this.records.contact(input.contact.handle)?.meetings.find(value => value.id === id);
    if (prior) return prior;
    const active = this.records.contact(input.contact.handle)?.meetings.find(value => ["new", "waiting_on_us", "held", "sent", "waiting_on_them"].includes(value.status));
    if (active?.status === "new" || active?.status === "waiting_on_us") return active;
    if (active) throw new Error(`An active meeting already exists for this contact: ${active.id}. Continue that meeting.`);
    const value = meeting.parse({ id, contact: input.contact, source: evidence, createdAt: evidence.at, updatedAt: evidence.at,
      origin: evidence.owner ? "owner" : "external", status: "new", cleanup: [], proposed: null });
    this.records.save(value, `The inbox verified scheduling request ${evidence.messageId}.`);
    return value;
  }
  materialize(input: Extract<Command, { action: "prepare" }>["details"], prefs: Preferences): Details {
    const common = { ...input, durationMin: input.durationMin ?? prefs.durations[input.meal ?? input.kind], timezone: prefs.timezone };
    if (input.kind === "video") {
      if (!prefs.video) throw new DecisionRequired("Which video provider should Meetly use, and should Zoom use a personal room or a new link per meeting?");
      return details.parse({ ...common, video: prefs.video });
    }
    return details.parse({ ...common, ...(input.kind === "in_person" ? { travelMin: prefs.travelMin } : {}) });
  }
  async prepare(input: Extract<Command, { action: "prepare" }>, actor: Actor): Promise<Meeting> {
    let value = await this.intake(input, actor);
    if (!["new", "waiting_on_us"].includes(value.status)) return value;
    const saved = this.records.owner();
    if (!saved) return this.question(value, "Please confirm your calendar, timezone, default durations, travel buffer and video preference privately before I propose times.");
    const prefs = saved;
    let info: Details;
    try { info = this.materialize(input.details, prefs); }
    catch (error) { if (error instanceof DecisionRequired) return this.question(value, error.message); throw error; }
    try { return await this.hold(value, info, { range: input.range, revision: 1, excluded: [], permissions: input.permissions, ownerRange: actor.kind === "owner" ? input.range : undefined }); }
    catch (error) {
      if (error instanceof RejectedEffect) {
        const current = this.records.find(value.id);
        this.records.save(meeting.parse({ ...current, status: "passed", reserved: [], cleanup: liveHolds(current), updatedAt: iso(this.now()) }), "The provider rejected further holds. Release the verified partial holds.");
        await this.cleanup(value.id); throw error;
      }
      if (error instanceof DecisionRequired) return this.question(value, error.message);
      throw error;
    }
  }
  async ask(input: Extract<Command, { action: "ask" }>, actor: Actor): Promise<Meeting> { return this.question(await this.intake(input, actor), input.question); }
  async question(value: Meeting, question: string): Promise<Meeting> {
    const receipt = await this.privateNotice(value, `details:${hash(question)}`, { purpose: "Ask the owner for the missing meeting details", question });
    const next = meeting.parse(value.status === "new" || value.status === "waiting_on_us"
      ? { ...value, status: "waiting_on_us", question, updatedAt: receipt.at }
      : { ...value, updatedAt: receipt.at });
    this.records.save(next, `The private owner question was confirmed in inbox message ${receipt.messageId}.`);
    return next;
  }
  async availability(value: Meeting, info: Details, request: HoldRequest): Promise<z.infer<typeof availabilityPlan>> {
    const { range, revision, excluded, permissions: allowed = permissions.parse({}) } = request;
    const prefs = this.preferences();
    const input = { info, range, excluded, allowed }, legacy = `${value.id}/r${revision}/availability`;
    const key = this.records.operation(legacy) ? legacy : `${legacy}/${hash(input)}`;
    const calculate = async () => plan({ prefs, details: info, range, events: await this.ports.list(prefs.busyCalendars, range), now: this.now(), ignored: [...liveHolds(value), ...allowed.conflicts], excluded, outsideHours: allowed.outsideHours });
    // Calendar reads have no side effects. Admit only a feasible plan, so a
    // private request to widen constraints cannot strand a pending write.
    const calculated = this.records.operation(key) ? null : await calculate();
    return this.records.effect(key, input, availabilityPlan, { run: async () => calculated ?? calculate(), retry: "safe" });
  }
  async hold(value: Meeting, info: Details, request: HoldRequest): Promise<Held> {
    const { range, revision, permissions: allowed = permissions.parse({}) } = request;
    const prefix = `${value.id}/r${revision}`, prefs = this.preferences();
    const planned = await this.availability(value, info, request);
    for (const move of planned.moves) await this.movePriority(value, move, prefix);
    const options = planned.slots;
    const markers = new Set(options.flatMap((option, index) => windows(option, info).map(span => `${prefix}/s${index + 1}/${span.role}`)));
    const held: Slot[] = [];
    for (const [index, option] of options.entries()) {
      const current = this.records.find(value.id), busy = await this.ports.list(prefs.busyCalendars, range);
      const created = busy.filter(value => markers.has(value.marker) && this.records.operation(value.marker)).map(value => value.ref);
      if (!insideHours(option, info, prefs, this.now(), allowed.outsideHours) || conflicts(option, info, busy, [...liveHolds(current), ...created, ...allowed.conflicts]).length) {
        throw new RejectedEffect("The planned time changed before its holds were complete. Release partial holds and research new options privately.");
      }
      const [ref, ...travel] = await this.reserve({ meetingId: value.id, topic: info.topic, calendar: prefs.calendar, prefix: `${prefix}/s${index + 1}` }, windows(option, info));
      if (!ref) throw new Error("The calendar did not verify this slot's hold.");
      held.push({ ...option, meeting: ref, travel });
    }
    const nextProposal = proposal.parse({ revision, slots: held, expiresAt: iso(this.now() + 48 * 3_600_000) });
    const createdKeys = new Set(held.flatMap(value => [value.meeting, ...value.travel]).map(refKey));
    const current = this.records.find(value.id);
    const next = meeting.parse({ ...current, status: "held", details: info, range, ownerRange: request.ownerRange, permissions: allowed, nextRevision: revision + 1, proposal: nextProposal,
      approval: current.origin === "external" ? "required" : "authorized", reserved: current.reserved.filter(ref => !createdKeys.has(refKey(ref))), updatedAt: iso(this.now()) });
    if (next.status !== "held") throw new Error("The verified proposal did not produce a held meeting.");
    this.records.save(next, `The calendar verified all three options for proposal ${revision}.`);
    if (next.approval === "required") await this.privateNotice(next, `approval:${revision}`, this.ownerProposal(next));
    return next;
  }
  async movePriority(value: Meeting, move: z.infer<typeof availabilityPlan>["moves"][number], prefix: string): Promise<void> {
    const prefs = this.preferences(), marker = `${prefix}/priority/${hash(move.event.ref)}`;
    const input: WriteEvent = { calendar: move.event.ref.calendar, start: move.start, end: move.end, title: move.event.title, location: move.event.location, attendees: [], conference: "none", marker };
    const verify = (observed: Event): Event => {
      if (observed.status !== "confirmed" || !observed.createdByOwner || observed.marker !== marker || Date.parse(observed.start) !== Date.parse(move.start) || Date.parse(observed.end) !== Date.parse(move.end) || observed.title !== move.event.title || observed.attendees.length) throw new Error("The calendar has not verified the permitted block's move.");
      return observed;
    };
    await this.records.effect(marker, input, event, { run: async () => {
      const observed = await this.ports.read(move.event.ref);
      if (!observed || !movableBlock(observed, prefs, this.now()) || observed.start !== move.event.start || observed.end !== move.event.end || observed.title !== move.event.title) throw new RejectedEffect("The owner's permitted block changed. Research a new plan privately.");
      const busy = await this.ports.list(prefs.busyCalendars, { from: move.start, to: move.end });
      const candidate = { start: move.start, durationMin: (Date.parse(move.end) - Date.parse(move.start)) / 60_000 };
      const timing = { kind: "phone" as const, durationMin: candidate.durationMin };
      if (!insideHours(candidate, timing, prefs, this.now()) || conflicts(candidate, timing, busy, [move.event.ref]).length) throw new RejectedEffect("The permitted block's new time is no longer free.");
      return verify(await this.ports.update(move.event.ref, input));
    }, recover: async () => { const observed = await this.ports.read(move.event.ref); return observed?.marker === marker ? verify(observed) : null; } });
    this.records.save(this.records.find(value.id), `The calendar verified moving owner-permitted block ${move.event.ref.id} from ${move.event.start} to ${move.start}.`);
  }
  async reserve(value: { meetingId: string; topic: string; calendar: Calendar; prefix: string }, spans: ReturnType<typeof windows>): Promise<EventRef[]> {
    const refs: EventRef[] = [];
    for (const span of spans) {
      const input: WriteEvent = { calendar: value.calendar, start: span.start, end: span.end,
        title: `${span.role === "meeting" ? "Hold" : "Travel"}: ${value.topic}`, location: "", attendees: [], conference: "none", marker: `${value.prefix}/${span.role}` };
      const observed = await this.records.effect(input.marker, input, event, { run: () => this.ports.create(input), recover: () => this.ports.recoverCreate(input) });
      refs.push(observed.ref);
      const current = this.records.find(value.meetingId);
      const reserved = [...new Map([...current.reserved, observed.ref].map(ref => [refKey(ref), ref])).values()];
      this.records.save(meeting.parse({ ...current, reserved, updatedAt: iso(this.now()) }), `The calendar verified reservation ${observed.ref.id}.`);
      const live = await this.ports.read(observed.ref);
      if (!live || live.status !== "confirmed" || live.marker !== input.marker || live.attendees.length || live.conference
        || Date.parse(live.start) !== Date.parse(span.start) || Date.parse(live.end) !== Date.parse(span.end)) throw new RejectedEffect("A recorded reservation changed. Release partial holds and research fresh options privately.");
    }
    return refs;
  }
  held(id: string, revision: number, recovering = false): Held {
    const value = this.records.find(id);
    if (value.status !== "held" || value.proposal.revision !== revision) throw new Error("This proposal is no longer awaiting publication. Read the current meeting.");
    if (!recovering && Date.parse(value.proposal.expiresAt) <= this.now()) throw new Error("The holds expired. Prepare fresh options before sending times.");
    return value;
  }
  ownerProposal(value: Held): unknown {
    return { ...this.proposalContext(value), audience: "private owner", recipient: this.preferences().ownerName,
      purpose: "Ask the owner privately to approve this exact proposal before sharing times.", revision: value.proposal.revision };
  }
  proposalContext(value: Held): Record<string, unknown> {
    return { audience: "guest", recipient: value.contact.name, owner: this.preferences().ownerName, contact: value.contact.name, details: value.details,
      purpose: "Propose these three verified held times as the owner's assistant and ask which one works.",
      options: value.proposal.slots.map(slot => label(slot.start, value.details.timezone)) };
  }
  async groupContext(value: Meeting, thread?: string): Promise<Record<string, unknown>> {
    const recent = thread ? await this.ports.replies(thread, iso(this.now() - 30 * 86_400_000)) : [];
    const guest = recent.filter(input => !input.owner && input.handle === value.contact.handle)
      .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    return { audience: "meeting group", recipient: value.contact.name, owner: this.preferences().ownerName, contact: value.contact.name,
      languageSample: guest?.text ?? (value.source.owner ? undefined : value.source.text), recipientLanguage: guest ? undefined : value.contact.language,
      conversation: guest ? undefined : value.proposed?.text ?? (value.source.thread === thread ? value.source.text : undefined) };
  }
  async draft(key: string, context: unknown): Promise<string> {
    const saved = this.records.operation(key);
    if (saved) return z.object({ text: z.string() }).parse(JSON.parse(saved.input)).text;
    return this.records.effect(`${key}/draft`, context, z.string().trim().min(1).max(10_000), {
      run: () => this.compose(context), retry: "safe",
    });
  }
  async verifyHolds(value: Held | Offered, slots: readonly Slot[] = value.proposal.slots): Promise<void> {
    const prefs = this.preferences();
    const busy = await this.ports.list(prefs.busyCalendars, value.range);
    const ignored = [...liveHolds(value), ...value.permissions.conflicts];
    for (const option of slots) {
      const spans = windows(option, value.details);
      const ordinal = value.proposal.slots.findIndex(slot => refKey(slot.meeting) === refKey(option.meeting)) + 1;
      if (option.travel.length !== spans.length - 1) throw new Error("The recorded travel blocks are incomplete.");
      for (const [index, ref] of [option.meeting, ...option.travel].entries()) {
        const observed = await this.ports.read(ref), expected = spans[index];
        if (!observed || !expected || observed.status !== "confirmed" || observed.attendees.length || observed.conference
          || observed.marker !== `${value.id}/r${value.proposal.revision}/s${ordinal}/${expected.role}`
          || Date.parse(observed.start) !== Date.parse(expected.start) || Date.parse(observed.end) !== Date.parse(expected.end)) throw new Error("A recorded hold or travel block changed. Reconcile it before sending times.");
      }
      if (!insideHours(option, value.details, prefs, this.now(), value.permissions.outsideHours) || conflicts(option, value.details, busy, ignored).length) throw new Error("An offered time is no longer available. Ask the owner privately to prepare replacements.");
    }
  }
  async publish(id: string, revision: number, actor: Actor): Promise<Meeting> {
    const value = this.records.find(id);
    const thread = await this.meetingThread(value, actor);
    if ((value.status === "sent" || value.status === "waiting_on_them" || value.status === "confirmed") && value.proposed?.revision === revision) return value;
    const held = this.held(id, revision, this.records.operation(`${id}/r${revision}/publish`) !== null);
    if (held.approval !== "authorized") throw new Error("The owner must privately approve this exact proposal before times go out.");
    const text = await this.draft(`${id}/r${revision}/publish`, { ...this.proposalContext(held), ...await this.groupContext(held, thread) });
    const receipt = await this.records.effect(`${id}/r${revision}/publish`, { member: held.contact.handle, thread: thread ?? null, text }, delivery, {
      run: async () => {
        const current = this.held(id, revision);
        if (!thread && actor.kind === "owner" && !("sessionKey" in actor.hostContext)) throw new Error("A new group needs an active private owner message. Ask the owner privately to publish this proposal.");
        await this.verifyHolds(current);
        return thread ? this.ports.send(thread, text) : this.ports.openThread(actor, `${id}/r${revision}`, held.contact.handle, text);
      },
      recover: () => thread ? this.ports.recoverSend(thread, text, held.createdAt) : this.ports.recoverThread(held.contact.handle, text, held.createdAt),
      retry: !thread && actor.kind === "owner" && "sessionKey" in actor.hostContext ? "safe" : undefined,
    });
    const current = this.held(id, revision, true);
    const next = meeting.parse({ ...current, status: "sent", proposed: { ...receipt, revision, slots: current.proposal.slots }, updatedAt: receipt.at });
    this.records.save(next, `The inbox verified proposal ${revision}, message ${receipt.messageId}. Actual text: ${receipt.text}`);
    return this.cleanup(id);
  }
  async meetingThread(value: Meeting, actor: Actor): Promise<string | undefined> {
    const thread = value.proposed?.thread ?? (value.source.channel === "plow" && value.source.thread !== await this.ports.ownerThread() ? value.source.thread : undefined);
    if (!thread) { assertOwner(actor, true); return; }
    assertParticipant(actor, value);
    if ((await this.ports.groupContact(thread)).handle !== value.contact.handle) throw new Error("The group roster no longer matches this contact. Continue privately.");
    return thread;
  }
  offered(id: string, revision: number, actor: Actor, recovering = false): Offered {
    const value = this.records.find(id);
    assertParticipant(actor, value);
    if ((value.status !== "sent" && value.status !== "waiting_on_them") || value.proposed?.revision !== revision || value.proposal.revision !== revision) throw new Error("This choice refers to an old or unsent proposal.");
    if (!recovering && Date.parse(value.proposal.expiresAt) <= this.now()) throw new Error("The proposal expired. Prepare fresh options.");
    return value;
  }
  async choose(id: string, revision: number, option: number, actor: Actor): Promise<Meeting> {
    const existing = this.records.find(id);
    assertParticipant(actor, existing);
    if (existing.status === "confirmed" && existing.proposed?.revision === revision) {
      assertChoice(existing, option);
      return this.finishBooking(existing, revision, actor);
    }
    const marker = `${id}/r${revision}/book${option}`;
    const previous = this.records.operation(marker);
    const prefix = `${id}/r${revision}/book`;
    const other = this.records.activeWith(prefix).filter(key => key !== marker && /^[123]$/.test(key.slice(prefix.length)));
    if (other.length) throw new Error("A prior booking choice is unconfirmed. Resolve its calendar receipt before choosing another slot.");
    const value = this.offered(id, revision, actor, previous !== null);
    const chosen = value.proposal.slots[option - 1];
    if (!chosen) throw new Error("Choose one of the three current options.");
    if (!previous) {
      await this.verifyHolds(value, [chosen]);
    }
    const booked = await this.book(value, chosen, marker, null);
    const next = meeting.parse({ ...value, status: "confirmed", invitation: booked,
      cleanup: [...value.cleanup, ...value.proposal.slots.filter(other => other !== chosen).flatMap(other => [other.meeting, ...other.travel])], updatedAt: iso(this.now()) });
    this.records.save(next, `The calendar verified invitation ${booked.event.ref.id} and all attendees. An invitation is not an RSVP acceptance.`);
    if (next.status !== "confirmed") throw new Error("The calendar invitation was not recorded as confirmed.");
    return this.finishBooking(next, revision, actor);
  }
  async finishBooking(value: Confirmed, revision: number, actor: Actor): Promise<Meeting> {
    const cleaned = await this.cleanup(value.id);
    const link = value.details.kind === "video" ? value.invitation.event.conference || value.invitation.event.location : "";
    const text = `The invitation for ${value.details.topic} with ${this.preferences().ownerName} is sent for ${label(value.invitation.event.start, value.details.timezone)}.${link ? ` Join: ${link}` : ""}`;
    await this.publicNotice(value, `r${revision}/booked`, text);
    await this.privateNotice(cleaned, `booked:${revision}`, `The calendar verified the invitation for ${value.details.topic} with ${value.contact.name}, ${label(value.invitation.event.start, value.details.timezone)}.`, actor.kind === "owner" ? actor.source : undefined);
    return this.records.find(value.id);
  }
  async book(value: Offered | Confirmed, chosen: Slot, marker: string, existing: Confirmed | null): Promise<z.infer<typeof invitation>> {
    const booking = { details: value.details, chosen, marker, previous: existing?.invitation ?? null };
    const input = invitationWrite(booking);
    return this.records.effect(marker, { ref: chosen.meeting, input }, invitation, {
      run: async () => verifyBooked(await this.ports.update(chosen.meeting, input), booking),
      recover: async () => {
        const observed = await this.ports.read(chosen.meeting);
        return observed?.marker === marker ? verifyBooked(observed, booking) : null;
      },
    });
  }
  async repair(input: Extract<Command, { action: "repair" }>, actor: Actor): Promise<Meeting> {
    assertOwner(actor, true);
    const { value, saved } = this.pendingBooking(input.meetingId);
    const original = z.object({ ref: eventRef, input: writeEvent }).parse(saved.input);
    const chosen = value.proposal.slots.find(slot => refKey(slot.meeting) === refKey(original.ref));
    if (!chosen) throw new Error("The pending booking does not belong to this proposal.");
    const observed = await this.ports.read(original.ref);
    if (!observed) throw new Error("The original event is absent. Prepare fresh options privately.");
    const update = this.repairWrite(original.input, observed, input.zoomUrl, actor.source);
    const booking = { details: value.details, chosen, marker: saved.key, previous: null };
    await this.records.effect(`${saved.key}/repair/${hash(actor.source.messageId)}`, { ref: original.ref, input: update }, invitation, {
      run: async () => verifyBooked(await this.ports.update(original.ref, update), booking),
      recover: async () => { const found = await this.ports.read(original.ref); return found?.marker === saved.key ? verifyBooked(found, booking) : null; },
    });
    return this.choose(value.id, value.proposal.revision, value.proposal.slots.indexOf(chosen) + 1, actor);
  }
  pendingBooking(id: string): { value: Offered; saved: { key: string; input: unknown } } {
    const value = this.records.find(id);
    if (!isOffered(value)) throw new Error("Repair requires one pending booking on a sent proposal.");
    const pending = this.records.unfinished().filter(saved => new RegExp(`^${value.id}/r${value.proposal.revision}/book[123]$`).test(saved.key));
    const saved = pending[0];
    if (pending.length !== 1 || !saved) throw new Error("There is no single unverified booking to repair.");
    return { value, saved };
  }
  repairWrite(original: WriteEvent, observed: Event, zoomUrl: string | undefined, confirmed: Source): WriteEvent {
    if (original.conference === "zoom") {
      if (zoomUrl && !confirmed.text.includes(zoomUrl)) throw new Error("The recovery Zoom URL must be supplied by the owner in this private message.");
      const link = zoomUrl ?? observed.conference;
      if (!/^https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/j\/\d+(?:\?pwd=[A-Za-z0-9._-]+)?$/.test(link)) throw new Error("Recover the existing Zoom room's join URL privately. An uncertain room creation cannot create another room automatically.");
      return { ...original, location: link, conference: "none" };
    }
    return { ...original, conference: observed.conference ? "none" : original.conference };
  }

  async cleanup(id: string): Promise<Meeting> {
    let value = this.records.find(id);
    for (const ref of value.cleanup) {
      if (value.status === "confirmed" && refKey(ref) === refKey(value.invitation.event.ref)) throw new Error("Cleanup cannot delete the verified invitation.");
      try {
        await this.records.effect(`${id}/delete/${hash(ref)}`, ref, eventRef, { run: () => this.ports.remove(ref), recover: async () => await this.ports.read(ref) === null ? ref : null, retry: "safe" });
        value = this.records.find(id);
        value = meeting.parse({ ...value, cleanup: value.cleanup.filter(item => refKey(item) !== refKey(ref)), updatedAt: iso(this.now()) });
        this.records.save(value, `The calendar verified deletion of recorded hold or travel block ${ref.id}.`);
      } catch { /* Keep the exact reference until a later provider read confirms deletion. */ }
    }
    return value;
  }
  private replacementRequest(value: Offered, range: Range, actor: Actor, allowed?: Permissions): HoldRequest {
    const ownerRange = actor.kind === "owner" ? range : value.ownerRange ?? (value.origin === "owner" ? value.range : undefined);
    const narrowed = restrictRange(range, ownerRange);
    if (!narrowed) throw new DecisionRequired("The guest's requested dates or daily limits do not fit your scheduling constraints. Please decide privately whether to change those constraints.");
    return { range: narrowed, ownerRange, revision: value.nextRevision, excluded: value.proposal.slots.map(slot => slot.start), permissions: allowed };
  }
  async repropose(id: string, revision: number, range: Range, actor: Actor, allowed?: Permissions): Promise<Meeting> {
    const current = this.records.find(id);
    if (current.status === "held" && current.proposal.revision === revision + 1) { assertParticipant(actor, current); return current; }
    const legacy = `${id}/r${revision}/replacement-plan`, input = { range, allowed };
    const key = this.records.operation(legacy) ? legacy : `${legacy}/${hash(input)}`;
    const snapshot = await this.records.effect(key, input, meeting, { run: async () => this.offered(id, revision, actor), retry: "safe" });
    if (snapshot.status !== "sent" && snapshot.status !== "waiting_on_them") throw new Error("The replacement plan has no verified sent proposal.");
    assertParticipant(actor, snapshot);
    const value = snapshot;
    let request: HoldRequest;
    try { request = this.replacementRequest(value, range, actor, allowed); await this.availability(value, value.details, request); }
    catch (error) {
      if (error instanceof DecisionRequired) return this.question(current, error.message);
      throw error;
    }
    if (current.status === "sent" || current.status === "waiting_on_them") {
      const retired = meeting.parse({ ...value, status: "new", reserved: [], cleanup: liveHolds(value), updatedAt: iso(this.now()) });
      this.records.save(retired, `Inbox message ${actor.kind === "maintenance" ? "" : actor.source.messageId} requested new options for proposal ${revision}.`);
    }
    await this.cleanup(id);
    const next = await this.hold(this.records.find(id), value.details, request);
    return next.approval === "authorized" && actor.kind === "owner" ? this.publish(id, next.proposal.revision, actor) : next;
  }
  async move(id: string, start: string, actor: Actor, allowed: Permissions = permissions.parse({})): Promise<Meeting> {
    assertOwner(actor);
    const value = this.records.find(id);
    assertParticipant(actor, value);
    if (value.status !== "confirmed") throw new Error("Only a verified booked meeting can be moved.");
    if (Date.parse(value.invitation.event.start) === Date.parse(start)) return this.finishMove(value);
    const marker = `${id}/move/${hash(start)}`, prefs = this.preferences();
    const info = await this.records.effect(`${marker}/details`, { start }, details, {
      run: async () => value.details.kind === "in_person" ? { ...value.details, travelMin: prefs.travelMin } : value.details, retry: "safe",
    });
    const candidate = { start, durationMin: info.durationMin };
    const spans = windows(candidate, info), range = { from: spans.map(span => span.start).sort()[0] ?? start, to: spans.map(span => span.end).sort().at(-1) ?? endOf(candidate) };
    const busy = await this.ports.list(prefs.busyCalendars, range);
    if (!insideHours(candidate, info, prefs, this.now(), allowed.outsideHours) || conflicts(candidate, info, busy, [value.invitation.event.ref, ...liveHolds(value), ...allowed.conflicts]).length) throw new Error("The new time is not available. Ask the owner privately to resolve the conflict.");
    const travel = await this.reserve({ meetingId: id, topic: value.details.topic, calendar: value.invitation.event.ref.calendar, prefix: marker }, spans.filter(span => span.role !== "meeting"));
    const booked = await this.book({ ...value, details: info }, { ...candidate, meeting: value.invitation.event.ref, travel }, marker, value);
    const keys = new Set(travel.map(refKey));
    const current = this.records.find(id);
    const next = meeting.parse({ ...current, status: "confirmed", details: info, permissions: allowed, invitation: booked, reserved: current.reserved.filter(ref => !keys.has(refKey(ref))), cleanup: [...current.cleanup, ...value.invitation.travel], updatedAt: iso(this.now()) });
    this.records.save(next, `The calendar verified the moved invitation ${booked.event.ref.id} with its saved video link.`);
    if (next.status !== "confirmed") throw new Error("The moved invitation was not verified.");
    return this.finishMove(next);
  }
  async finishMove(value: Confirmed): Promise<Meeting> {
    const cleaned = await this.cleanup(value.id);
    await this.publicNotice(value, `move/${hash(value.invitation.event.start)}`, `The calendar verified the new time for ${value.details.topic} with ${this.preferences().ownerName}: ${label(value.invitation.event.start, value.details.timezone)}. The invitation has been updated.`);
    return cleaned;
  }
  async cancel(id: string, actor: Actor, notify = true): Promise<Meeting> {
    assertOwner(actor);
    let value = this.records.find(id);
    assertParticipant(actor, value);
    if (value.status === "do_not_contact") return this.cleanup(id);
    if (value.status === "confirmed") {
      const ref = value.invitation.event.ref;
      await this.records.effect(`${id}/cancel/${hash(ref)}`, ref, eventRef, { run: () => this.ports.remove(ref), recover: async () => await this.ports.read(ref) === null ? ref : null, retry: "safe" });
    }
    if (value.status !== "passed") {
      value = meeting.parse({ ...value, status: "passed", reserved: [], cleanup: liveHolds(value), updatedAt: iso(this.now()) });
      this.records.save(value, `The calendar or owner inbox confirmed cancellation of this meeting.`);
    }
    const cleaned = await this.cleanup(id);
    if (notify) await this.publicNotice(value, "cancel", `The meeting with ${this.preferences().ownerName} has been cancelled.`);
    return cleaned;
  }
  async publicNotice(value: Meeting, reason: string, facts: unknown, beforeSend?: () => Promise<void>): Promise<void> {
    if (!value.proposed || value.status === "do_not_contact") return;
    const thread = value.proposed.thread, key = `${value.id}/${reason}-notice`;
    if ((await this.ports.groupContact(thread)).handle !== value.contact.handle) throw new Error("The meeting conversation no longer has its verified contact; resolve it privately.");
    const text = await this.draft(key, { ...await this.groupContext(value, thread), facts,
      invitation: value.status === "confirmed" ? { start: value.invitation.event.start, end: value.invitation.event.end,
        timezone: value.details.timezone, attendees: value.invitation.event.attendees,
        link: value.details.kind === "video" ? value.invitation.event.conference || value.invitation.event.location : null } : null });
    const receipt = await this.records.effect(key, { thread, text }, delivery, {
      run: async () => { await beforeSend?.(); return this.ports.send(thread, text); }, recover: () => this.ports.recoverSend(thread, text, value.proposed!.at),
    });
    if (!this.records.operation(`${key}-log`)) {
      this.records.save(this.records.find(value.id), `The inbox verified the ${reason} notice ${receipt.messageId}. An invitation is not an RSVP acceptance.`);
      await this.records.effect(`${key}-log`, {}, z.boolean(), { run: async () => true, retry: "safe" });
    }
  }
  async privateNotice(value: Meeting, reason: string, facts: unknown, request?: Source): Promise<z.infer<typeof delivery>> {
    const thread = await this.ports.ownerThread();
    const key = `${value.id}/notice/${reason}`, text = await this.draft(key, { audience: "private owner", owner: this.records.owner()?.ownerName, contact: value.contact.name,
      languageSample: this.records.ownerSource(thread)?.text, request: { origin: (request ?? value.source).owner ? "owner" : "external", message: (request ?? value.source).text }, status: value.status, facts });
    return this.records.effect(key, { thread, text }, delivery, { run: () => request?.owner ? this.sendReply(thread, request, text) : this.ports.send(thread, text),
      recover: () => this.ports.recoverSend(thread, text, value.createdAt) });
  }
  async reply(input: Source, text: string): Promise<void> {
    if (input.channel !== "plow") return;
    await this.sendReply(input.thread, input, text);
  }
  async sendReply(thread: string, input: Source, text: string): Promise<z.infer<typeof delivery>> {
    const key = `reply:${hash([thread, input.messageId])}`, saved = this.records.operation(key);
    if (saved) text = z.object({ text: z.string() }).parse(JSON.parse(saved.input)).text;
    return this.records.effect(key, { thread, text }, delivery, {
      run: () => this.ports.send(thread, text), recover: () => this.ports.recoverSend(thread, text, input.at),
    });
  }
  async reconcile(): Promise<{ pending: number; failures: string[] }> {
    this.records.recoverPages();
    const failures: string[] = [];
    for (const saved of this.records.unfinished()) await this.check(async () => { await this.recoverHold(saved); await this.recoverNotice(saved); }, failures);
    for (const raw of this.records.pendingTasks()) await this.check(() => this.resumeTask(raw), failures);
    for (const value of this.records.pages().flatMap(page => page.meetings)) await this.check(() => this.reviewMeeting(value), failures);
    if (failures.length) await this.reportFailures(failures);
    return { pending: this.records.uncertain().length, failures };
  }
  async reportFailures(failures: string[]): Promise<void> {
    const facts = { purpose: "Explain this scheduling blocker privately and the next step. Never claim the pending actions succeeded.", failures: [...new Set(failures)] };
    const thread = await this.ports.ownerThread();
    const key = `monitor:${hash(facts)}`, text = await this.draft(key, { audience: "private owner", owner: this.records.owner()?.ownerName,
      languageSample: this.records.ownerSource(thread)?.text, facts });
    await this.records.effect(key, { thread, text }, delivery, {
      run: () => this.ports.send(thread, text), recover: () => this.ports.recoverSend(thread, text, new Date(0).toISOString()),
    });
  }
  async check(work: () => Promise<void>, failures: string[]): Promise<void> {
    try { await work(); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  async recoverHold(saved: { key: string; input: unknown }): Promise<void> {
    const input = writeEvent.safeParse(saved.input);
    if (!input.success || !/\/r\d+\/s\d+\/(?:meeting|before|after)$|\/move\/[a-f0-9]+\/(?:before|after)$/.test(saved.key)) return;
    const observed = await this.records.effect(saved.key, saved.input, event, {
      run: async () => { throw new Error("Recover the existing calendar write; do not create another event."); },
      recover: () => this.ports.recoverCreate(input.data),
    });
    const value = this.records.find(saved.key.split("/")[0]!);
    const refs = closedStatuses.has(value.status) ? { cleanup: [...value.cleanup, observed.ref] } : { reserved: [...value.reserved, observed.ref] };
    this.records.save(meeting.parse({ ...value, ...refs, updatedAt: iso(this.now()) }), `The calendar recovered interrupted hold or travel block ${observed.ref.id}.`);
  }
  async recoverNotice(saved: { key: string; input: unknown }): Promise<void> {
    if (!/(?:-notice$|\/notice\/|^reply:|^monitor:)/.test(saved.key)) return;
    const input = z.object({ thread: z.string(), text: z.string() }).safeParse(saved.input);
    if (!input.success) return;
    await this.records.effect(saved.key, saved.input, delivery, {
      run: async () => { throw new Error("Check this message's delivery receipt before another send."); },
      recover: () => this.ports.recoverSend(input.data.thread, input.data.text, new Date(0).toISOString()),
    });
  }
  async resumeTask(raw: unknown): Promise<void> {
    const saved = task.parse(raw);
    const actor = this.restoredActor(saved.authority);
    if (!actor) { this.records.reject(`task:${hash(saved)}`); return; }
    if ("meetingId" in saved.command) {
      const current = this.records.find(saved.command.meetingId);
      if (current.status === "do_not_contact" || (current.status === "passed" && saved.command.action !== "cancel")) { this.records.reject(`task:${hash(saved)}`); return; }
    }
    if ("contact" in saved.command) {
      const command = saved.command;
      const evidence = command.source ?? saved.authority.source;
      const closed = this.records.contact(command.contact.handle)?.meetings.some(value =>
        closedStatuses.has(value.status) && value.source.thread === evidence.thread && value.source.messageId === evidence.messageId);
      if (closed) { this.records.reject(`task:${hash(saved)}`); return; }
    }
    try { await this.execute(saved.command, actor); }
    catch (error) { if (error instanceof RejectedEffect) this.records.reject(`task:${hash(saved)}`); else throw error; }
  }
  restoredActor(authority: z.infer<typeof task>["authority"]): Actor | null {
    if (authority.kind === "discovery") return this.records.isDiscovered(authority.source) ? { kind: "discovery", source: authority.source } : null;
    if (authority.source.channel !== "plow") return null;
    return authority.kind === "guest" ? { kind: "guest", source: authority.source }
      : { kind: "owner", source: authority.source, mainDm: authority.mainDm, hostContext: {} };
  }
  async reviewMeeting(value: Meeting): Promise<void> {
    if ("proposal" in value && Date.parse(value.proposal.expiresAt) <= this.now()
      && !this.records.activeWith(`${value.id}/r${value.proposal.revision}/book`).length
      && this.records.operation(`${value.id}/r${value.proposal.revision}/publish`)?.state !== "started") {
      await this.expire(value);
    } else {
      switch (value.status) {
        case "held":
          await this.privateNotice(value, `${value.approval === "required" ? "approval" : "publish"}:${value.proposal.revision}`, value.approval === "required"
            ? this.ownerProposal(value) : `The options for ${value.contact.name} are held. Reply privately to send proposal ${value.proposal.revision}.`);
          break;
        case "sent": await this.verifySent(value); break;
        case "confirmed": await this.reviewInvitation(value); break;
      }
    }
    await this.cleanup(value.id);
    await this.nudge(this.records.find(value.id));
  }
  async nudge(value: Meeting): Promise<void> {
    if (this.preferences().paused) return;
    if (value.status === "confirmed") await this.joinReminder(value);
    const age = this.now() - Date.parse(value.updatedAt);
    if (age >= 4 * 3_600_000 && (value.status === "waiting_on_us" || value.status === "held")) {
      const reason = value.status === "held" ? String(value.proposal.revision) : hash(value.question);
      await this.privateNotice(value, `followup:${reason}`, value.status === "held" && value.approval === "required"
        ? this.ownerProposal(value) : `${value.contact.name} is waiting on us. ${advice(value)}`);
    }
    if ((value.status === "sent" || value.status === "waiting_on_them") && value.proposed
      && this.now() - Date.parse(value.proposed.at) >= 24 * 3_600_000
      && !(await this.ports.replies(value.proposed.thread, value.proposed.at)).length) {
      const remaining = value.proposal.slots.filter(slot => Date.parse(slot.start) >= this.now() + this.preferences().noticeMin * 60_000);
      if (!remaining.length) return;
      await this.verifyHolds(value, remaining);
      await this.publicNotice(value, `r${value.proposed.revision}/followup`, `Would any of the remaining proposed times with ${this.preferences().ownerName} work for you? If none do, I can find new options.`);
    }
  }
  async joinReminder(value: Confirmed): Promise<void> {
    const minutes = (Date.parse(value.invitation.event.start) - this.now()) / 60_000;
    if (value.details.kind !== "video" || !this.preferences().reminderMin || minutes < -5 || minutes > this.preferences().reminderMin) return;
    await this.publicNotice(value, `join/${hash(value.invitation.event.start)}`, {
      purpose: "Remind the attendees of this verified video meeting and include its join link.", minutesToStart: Math.max(0, Math.ceil(minutes)),
    }, async () => {
      const current = this.records.find(value.id), prefs = this.preferences();
      const at = (Date.parse(value.invitation.event.start) - this.now()) / 60_000;
      const observed = await this.ports.read(value.invitation.event.ref);
      if (prefs.paused || !prefs.reminderMin || at < -5 || at > prefs.reminderMin || current.status !== "confirmed"
        || JSON.stringify(observed) !== JSON.stringify(value.invitation.event)) throw new RejectedEffect("The meeting reminder is no longer current; do not send it.");
    });
  }
  async expire(value: Held | Offered): Promise<void> {
    const expired = meeting.parse({ ...value, status: "passed", reserved: [], cleanup: liveHolds(value), updatedAt: iso(this.now()) });
    await this.privateNotice(value, `expired:${value.proposal.revision}`, `The options for ${value.contact.name} expired. Prepare new times privately if the meeting is still needed.`);
    this.records.save(expired, "The calendar holds reached their recorded expiration; release them and prepare new options if needed.");
  }
  async verifySent(value: Offered): Promise<void> {
    if (!value.proposed) throw new Error("A sent proposal requires its verified inbox receipt.");
    const found = await this.ports.recoverSend(value.proposed.thread, value.proposed.text, value.proposed.at);
    if (found) this.records.save(meeting.parse({ ...value, status: "waiting_on_them", updatedAt: found.at }), "The inbox verified the sent proposal; wait for the contact's reply.");
  }
  async reviewInvitation(value: Confirmed): Promise<void> {
    const observed = await this.ports.read(value.invitation.event.ref);
    if (!observed) {
      this.records.save(meeting.parse({ ...value, status: "passed", cleanup: liveHolds(value), updatedAt: iso(this.now()) }), `The calendar verified that invitation ${value.invitation.event.ref.id} was cancelled.`);
      return;
    }
    if (Date.parse(observed.start) !== Date.parse(value.invitation.event.start) || Date.parse(observed.end) !== Date.parse(value.invitation.event.end)) {
      await this.calendarChange(value, observed); return;
    }
    const conference = value.details.kind === "video" && value.details.video.kind === "zoom_personal" ? value.details.video.url : value.invitation.event.conference || value.invitation.event.location;
    assertInvitation(observed, value.details, { start: observed.start, durationMin: value.details.durationMin }, conference);
    if (JSON.stringify(observed) !== JSON.stringify(value.invitation.event)) {
      const next: Confirmed = { ...value, invitation: { ...value.invitation, event: observed }, updatedAt: iso(this.now()) };
      this.records.save(next, `The calendar verified the current invitation facts for ${observed.ref.id}.`);
      if (value.details.kind === "video" && observed.conference !== value.invitation.event.conference) {
        await this.publicNotice(next, `link/${hash(observed.conference)}`, { purpose: "Tell the attendees the calendar verified an updated meeting link." });
      }
    }
  }
  async calendarChange(value: Confirmed, observed: Event): Promise<void> {
    const durationMin = (Date.parse(observed.end) - Date.parse(observed.start)) / 60_000;
    const marker = `${value.id}/move/${hash([observed.start, observed.end])}`;
    const info = await this.records.effect(`${marker}/details`, { start: observed.start, end: observed.end }, details, {
      run: async () => details.parse({ ...value.details, durationMin, ...(value.details.kind === "in_person" ? { travelMin: this.preferences().travelMin } : {}) }), retry: "safe",
    });
    const conference = info.kind === "video" && info.video.kind === "zoom_personal" ? info.video.url : value.invitation.event.conference || value.invitation.event.location;
    assertInvitation(observed, info, { start: observed.start, durationMin }, conference);
    let travel: EventRef[] = [];
    const spans = windows({ start: observed.start, durationMin }, info);
    const range = { from: spans.map(span => span.start).sort()[0]!, to: spans.map(span => span.end).sort().at(-1)! };
    if (info.kind === "in_person") {
      const prefs = this.preferences(), busy = await this.ports.list(prefs.busyCalendars, range);
      if (conflicts({ start: observed.start, durationMin }, info, busy, [observed.ref, ...liveHolds(value)]).length) {
        await this.privateNotice(value, `changed:${hash(observed)}`, `The calendar moved ${info.topic} with ${value.contact.name}, but its new travel time is not available. Please resolve it privately.`);
        return;
      }
      travel = await this.reserve({ meetingId: value.id, topic: info.topic, calendar: observed.ref.calendar, prefix: marker }, spans.filter(span => span.role !== "meeting"));
    }
    const current = this.records.find(value.id), keys = new Set(travel.map(refKey));
    this.records.save(meeting.parse({ ...current, details: info, invitation: { ...value.invitation, event: observed, travel }, cleanup: [...current.cleanup, ...value.invitation.travel], reserved: current.reserved.filter(ref => !keys.has(refKey(ref))), updatedAt: iso(this.now()) }), `The calendar verified a changed invitation ${observed.ref.id}; reconcile its recorded travel blocks.`);
    await this.cleanup(value.id);
    await this.privateNotice(this.records.find(value.id), `changed:${hash(observed)}`, `The calendar changed ${info.topic} with ${value.contact.name} to ${label(observed.start, info.timezone)}. Its invitation and travel blocks are now verified.`);
    await this.publicNotice(this.records.find(value.id), `move/${hash(observed.start)}`, { purpose: "Tell the attendees the calendar verified a changed meeting time and include the current invitation link." });
  }
}
