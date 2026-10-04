import { z } from "zod";
import { calendar, delivery, email, event, eventRef, handle, id, source, type Actor, type Calendar, type Contact, type Delivery, type Event, type EventRef, type Range, type Source } from "./model.ts";
import { wallTime } from "./availability.ts";
import { RejectedEffect } from "./records.ts";

export const writeEvent = z.object({ calendar, start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }), title: z.string(), location: z.string(),
  attendees: z.array(email), conference: z.enum(["none", "meet", "zoom"]), marker: z.string().min(1) });
export type WriteEvent = z.infer<typeof writeEvent>;
export interface Ports {
  list(calendars: Calendar[], range: Range): Promise<Event[]>;
  read(ref: EventRef): Promise<Event | null>;
  create(input: WriteEvent): Promise<Event>;
  update(ref: EventRef, input: WriteEvent): Promise<Event>;
  remove(ref: EventRef): Promise<EventRef>;
  recoverCreate(input: WriteEvent): Promise<Event | null>;
  send(thread: string, text: string): Promise<Delivery>;
  openThread(actor: Actor, key: string, member: string, text: string): Promise<Delivery>;
  recoverThread(member: string, text: string, since: string): Promise<Delivery | null>;
  recoverSend(thread: string, text: string, since: string): Promise<Delivery | null>;
  ownerThread(): Promise<string>;
  groupContact(thread: string): Promise<Contact>;
  message(thread: string, messageId: string): Promise<Source>;
  replies(thread: string, since: string): Promise<Source[]>;
  research(contact: string, calendar?: Calendar): Promise<unknown>;
  archive(after: number | null): Promise<{ rowid: number; source: Source | null }[]>;
  discover(): Promise<unknown>;
}

const rawStamp = z.union([z.string(), z.object({ dateTime: z.string().optional(), date: z.string().optional() })]);
const rawEvent = z.object({
  id, status: z.enum(["confirmed", "tentative", "cancelled"]).default("confirmed"),
  start: rawStamp.optional(), end: rawStamp.optional(), startLocal: z.string().optional(), endLocal: z.string().optional(),
  summary: z.string().default(""), location: z.string().default(""), hangoutLink: z.string().optional(),
  description: z.string().default(""),
  conferenceData: z.object({ entryPoints: z.array(z.object({ entryPointType: z.string(), uri: z.string() })).optional() }).optional(),
  attendees: z.array(z.object({ email, self: z.boolean().optional(), responseStatus: z.string().optional() })).default([]),
  extendedProperties: z.object({ private: z.record(z.string(), z.string()).optional() }).optional(),
  transparency: z.string().optional(), declined: z.boolean().optional(),
  creator: z.object({ email: z.string().optional() }).optional(), createdByOwner: z.boolean().default(false),
});
const rawListing = z.union([z.array(rawEvent), z.object({
  items: z.array(rawEvent).optional(), events: z.array(rawEvent).optional(),
  nextPageToken: z.string().optional(), has_more: z.boolean().optional(),
  degraded: z.array(z.unknown()).default([]), truncated: z.unknown().optional(),
}).refine(value => value.items !== undefined || value.events !== undefined, "Calendar read did not verify an event collection.")]);

export function jsonOutput(output: string): unknown {
  const at = output.search(/^[{[]/m);
  if (at < 0) throw new Error("The provider did not return JSON.");
  return JSON.parse(output.slice(at));
}
function stamp(value: z.infer<typeof rawStamp> | undefined, local: string | undefined, timezone: string): string {
  const text = typeof value === "string" ? value : value?.dateTime ?? value?.date ?? local;
  if (!text) throw new Error("The calendar event has no verified time.");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const instant = wallTime(Number(text.slice(0, 4)), Number(text.slice(5, 7)), Number(text.slice(8, 10)), 0, timezone);
    if (instant === null) throw new Error("The calendar returned an invalid local date.");
    return new Date(instant).toISOString();
  }
  return new Date(z.iso.datetime({ offset: true }).parse(text)).toISOString();
}
function normalized(value: z.infer<typeof rawEvent>, cal: Calendar, timezone: string): Event {
  const zoom = /<!-- gog-zoom-meeting:\d+ -->[\s\S]*?Join Zoom Meeting:\s*(https:\/\/(?:[a-z0-9-]+\.)?zoom\.us\/j\/\d+(?:\?pwd=[A-Za-z0-9._-]+)?)/.exec(value.description)?.[1];
  const native = value.hangoutLink ?? value.conferenceData?.entryPoints?.find(item => item.entryPointType === "video")?.uri;
  if (zoom && native?.startsWith("https://meet.google.com/")) throw new Error("The event has conflicting video providers. Verify it privately.");
  return event.parse({ ref: { calendar: cal, id: value.id }, status: value.status,
    start: stamp(value.start, value.startLocal, timezone), end: stamp(value.end, value.endLocal, timezone),
    title: value.summary, location: value.location, attendees: value.attendees.map(item => item.email),
    conference: zoom ?? native ?? "",
    transparent: value.transparency === "transparent", declined: value.declined === true || value.attendees.some(item => item.self && item.responseStatus === "declined"),
    marker: value.extendedProperties?.private?.meetly_operation ?? "",
    createdByOwner: value.createdByOwner || value.creator?.email?.trim().toLowerCase() === cal.account.trim().toLowerCase() });
}
export function parseListing(value: unknown, cal: Calendar, timezone: string): Event[] {
  const parsed = rawListing.parse(value);
  const list = Array.isArray(parsed) ? parsed : parsed.events ?? parsed.items;
  if (!list || (!Array.isArray(parsed) && (parsed.degraded.length || parsed.truncated || parsed.has_more || parsed.nextPageToken))) {
    throw new Error("The calendar read is incomplete. Do not treat unread time as free.");
  }
  return list.filter(item => item.status !== "cancelled").map(item => normalized(item, cal, timezone));
}
export function parseEvent(value: unknown, cal: Calendar, timezone: string): Event | null {
  const wrapper = z.object({ event: z.unknown() }).safeParse(value);
  const parsed = rawEvent.parse(wrapper.success ? wrapper.data.event : value);
  return parsed.status === "cancelled" ? null : normalized(parsed, cal, timezone);
}

const member = z.object({ type: z.literal("member"), uid: id, role: z.string(), provider_key: handle, display_name: z.string().nullable().optional() });
const agent = z.object({ type: z.literal("agent"), relationship: z.string(), line: z.object({ uid: id, provider_key: handle.optional() }) });
const chat = z.object({ uid: id, status: z.string(), trusted: z.boolean().optional(), participants: z.array(z.discriminatedUnion("type", [member, agent])) });
function serves(value: z.infer<typeof chat>, line: string): boolean {
  return value.status === "active" && value.participants.some(item => item.type === "agent" && item.relationship === "self" && item.line.uid === line);
}
const message = z.object({ uid: id, body: z.string(), direction: z.string(), created_at: z.string(), sender: z.discriminatedUnion("type", [member, agent]) });
type MacRunner = (argv: string[], readPaths?: string[]) => Promise<string>;
const archiveRow = z.object({ rowid: z.number().int().nonnegative(), chat_guid: id, sender: z.string().nullable(), is_from_me: z.union([z.boolean(), z.literal(0), z.literal(1)]).transform(Boolean), at: z.string(), body: z.string() });
const lines = (value: string): unknown[] => value.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
// Plow's iMessage transport escapes Markdown punctuation in the inbox body.
// Compare the displayed text, but persist the exact returned body as proposed.
const displayed = (value: string): string => value.replace(/\\+([!-/:-@[-`{-~])/g, "$1");
export type NativeChannel = {
  send(thread: string, text: string): Promise<unknown>;
  start(actor: Actor, key: string, member: string, text: string): Promise<unknown>;
};

export class Providers implements Ports {
  readonly native: NativeChannel;
  readonly timezone: () => string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetcher: typeof fetch;
  readonly mac: MacRunner;
  constructor(native: NativeChannel, timezone: () => string, env: NodeJS.ProcessEnv = process.env,
    fetcher: typeof fetch = fetch, mac: MacRunner = (argv, paths) => runMac(argv, paths, env, fetcher)) {
    this.native = native; this.timezone = timezone; this.env = env; this.fetcher = fetcher; this.mac = mac;
  }

  async request(path: string): Promise<unknown> {
    const base = this.env.PLOW_API_BASE?.replace(/\/+$/, "");
    if (!base || !this.env.PLOW_AGENT_TOKEN) throw new Error("Plow identity is unavailable.");
    const response = await this.fetcher(`${base}/v1${path}`, { headers: { Authorization: `Bearer ${this.env.PLOW_AGENT_TOKEN}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Plow read failed, HTTP ${response.status}.`);
    return response.json();
  }
  async served(thread: string): Promise<z.infer<typeof chat>> {
    const identity = z.object({ line: z.object({ uid: id }) }).parse(await this.request("/agents/me"));
    const value = chat.parse(await this.request(`/chats/${encodeURIComponent(thread)}`));
    if (!serves(value, identity.line.uid)) throw new Error("This conversation is not served by the agent's phone line.");
    return value;
  }
  async ownerThread(): Promise<string> {
    const identity = z.object({ line: z.object({ uid: id }), chats: z.array(chat) }).parse(await this.request("/agents/me"));
    const matches = identity.chats.filter(value => serves(value, identity.line.uid) && value.participants.length === 2
      && value.participants.some(item => item.type === "member" && item.role === "owner"));
    if (matches.length !== 1 || !matches[0]) throw new Error("Plow did not verify one private owner conversation.");
    return matches[0].uid;
  }
  async groupContact(thread: string): Promise<Contact> {
    const roster = await this.served(thread);
    const members = roster.participants.filter(person => person.type === "member");
    const guests = members.filter(person => person.role !== "owner");
    if (roster.participants.length !== 3 || members.filter(person => person.role === "owner").length !== 1 || guests.length !== 1 || !guests[0]) {
      throw new Error("This group has no single verified meeting contact. Continue privately with the owner.");
    }
    return { name: guests[0].display_name ?? guests[0].provider_key, handle: guests[0].provider_key };
  }
  async messages(thread: string, since?: string): Promise<z.infer<typeof message>[]> {
    await this.served(thread);
    const all: z.infer<typeof message>[] = [];
    let cursor = "";
    for (let page = 0; page < 100; page++) {
      const result = z.object({ data: z.array(message), has_more: z.boolean() }).parse(await this.request(`/chats/${encodeURIComponent(thread)}/messages?limit=50${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`));
      if (result.data.some(value => all.some(prior => prior.uid === value.uid))) throw new Error("The inbox returned a repeated page. Do not infer a delivery receipt.");
      all.push(...result.data);
      if (!result.has_more || (since && result.data.some(value => Date.parse(value.created_at) < Date.parse(since)))) return all;
      const next = result.data.at(-1)?.uid;
      if (!next || next === cursor) throw new Error("The inbox read is incomplete.");
      cursor = next;
    }
    throw new Error("The inbox read exceeds the page limit. Reconcile it privately.");
  }
  async message(thread: string, messageId: string): Promise<Source> {
    const roster = await this.served(thread);
    const found = (await this.messages(thread)).find(value => value.uid === messageId);
    if (!found || found.sender.type !== "member" || found.direction !== "inbound") throw new RejectedEffect("The inbox did not verify this incoming scheduling message.");
    const senderUid = found.sender.uid;
    const person = roster.participants.find(value => value.type === "member" && value.uid === senderUid);
    if (!person || person.type !== "member") throw new RejectedEffect("The sender does not belong to the verified conversation roster.");
    return source.parse({ channel: "plow", thread, messageId, at: new Date(found.created_at).toISOString(), handle: person.provider_key, owner: person.role === "owner", text: found.body });
  }
  async list(calendars: Calendar[], range: Range): Promise<Event[]> {
    const lists = await Promise.all(calendars.map(async cal => parseListing(jsonOutput(await this.mac([
      "plow-gog", "calendar", "events", cal.id, "--account", cal.account, "--from", range.from, "--to", range.to, "--all-pages", "--max", "2500", "--json",
    ])), cal, this.timezone())));
    return lists.flat();
  }
  async read(ref: EventRef): Promise<Event | null> {
    try {
      const raw = jsonOutput(await this.mac(["plow-gog", "calendar", "raw", ref.calendar.id, ref.id, "--account", ref.calendar.account, "--json"]));
      const wrapper = z.object({ event: z.unknown() }).safeParse(raw);
      if (rawEvent.parse(wrapper.success ? wrapper.data.event : raw).id !== ref.id) throw new Error("The calendar returned a different event.");
      const observed = parseEvent(raw, ref.calendar, this.timezone());
      if (observed && observed.ref.id !== ref.id) throw new Error("The calendar returned a different event.");
      return observed;
    } catch (error) {
      if (error instanceof Error && /(?:HTTP|Error) (?:404|410)\b/.test(error.message)) return null;
      throw error;
    }
  }
  argv(input: WriteEvent): string[] {
    return ["--summary", input.title, "--from", input.start, "--to", input.end, "--location", input.location,
      "--attendees", input.attendees.join(","), "--private-prop", `meetly_operation=${input.marker}`,
      "--send-updates", input.attendees.length ? "all" : "none", "--account", input.calendar.account, "--json",
      ...(input.conference === "meet" ? ["--with-meet"] : input.conference === "zoom" ? ["--with-zoom", "--include-passwords"] : [])];
  }
  async create(input: WriteEvent): Promise<Event> {
    const observed = parseEvent(jsonOutput(await this.mac(["plow-gog", "calendar", "create", input.calendar.id, ...this.argv(input)])), input.calendar, this.timezone());
    if (!observed) throw new Error("The calendar did not confirm the new event.");
    const verified = await this.read(observed.ref);
    if (!verified || verified.marker !== input.marker || Date.parse(verified.start) !== Date.parse(input.start) || Date.parse(verified.end) !== Date.parse(input.end)) throw new Error("The calendar did not verify the new hold.");
    return verified;
  }
  async update(ref: EventRef, input: WriteEvent): Promise<Event> {
    await this.mac(["plow-gog", "calendar", "update", ref.calendar.id, ref.id, ...this.argv(input)]);
    const verified = await this.read(ref);
    if (!verified) throw new Error("The calendar did not verify the updated event.");
    return verified;
  }
  async recoverCreate(input: WriteEvent): Promise<Event | null> {
    const matches = (await this.list([input.calendar], { from: input.start, to: input.end })).filter(value => value.marker === input.marker);
    if (matches.length > 1) throw new Error("Multiple calendar events match one operation. Ask the owner privately to reconcile them.");
    const found = matches[0];
    return found ?? null;
  }
  async remove(ref: EventRef): Promise<EventRef> {
    if (await this.read(ref)) {
      await this.mac(["plow-gog", "calendar", "delete", ref.calendar.id, ref.id, "--account", ref.calendar.account, "--send-updates", "all", "--force", "--json"]);
      if (await this.read(ref)) throw new Error("The calendar has not verified the deletion.");
    }
    return eventRef.parse(ref);
  }
  async send(thread: string, text: string): Promise<Delivery> {
    await this.served(thread);
    const { messageId } = z.object({ messageId: id }).parse(await this.native.send(thread, text));
    const identity = z.object({ line: z.object({ uid: id }) }).parse(await this.request("/agents/me"));
    const found = (await this.messages(thread)).find(value => value.uid === messageId);
    if (!found || found.direction !== "outbound" || displayed(found.body) !== displayed(text) || found.sender.type !== "agent" || found.sender.relationship !== "self" || found.sender.line.uid !== identity.line.uid) throw new Error("The inbox has not confirmed the channel's sent message.");
    return delivery.parse({ thread, messageId, at: new Date(found.created_at).toISOString(), text: found.body });
  }
  async openThread(actor: Actor, key: string, member: string, text: string): Promise<Delivery> {
    const result = z.object({ chat_uid: id, message_sent: z.literal(true) }).parse(await this.native.start(actor, key, member, text));
    const receipt = await this.recoverSend(result.chat_uid, text, actor.kind === "owner" ? actor.source.at : new Date().toISOString());
    if (!receipt) throw new Error("The inbox has not verified the first group message.");
    return receipt;
  }
  async recoverSend(thread: string, text: string, since: string): Promise<Delivery | null> {
    const identity = z.object({ line: z.object({ uid: id }) }).parse(await this.request("/agents/me"));
    const matches = (await this.messages(thread, since)).filter(value => value.direction === "outbound" && value.sender.type === "agent" && value.sender.relationship === "self"
      && value.sender.line.uid === identity.line.uid && displayed(value.body) === displayed(text) && Date.parse(value.created_at) >= Date.parse(since));
    if (matches.length > 1) throw new Error("The inbox has multiple matching messages. Resolve their receipts privately.");
    const match = matches[0];
    return match ? delivery.parse({ thread, messageId: match.uid, at: new Date(match.created_at).toISOString(), text: match.body }) : null;
  }
  async recoverThread(member: string, text: string, since: string): Promise<Delivery | null> {
    const identity = z.object({ line: z.object({ uid: id }), chats: z.array(chat) }).parse(await this.request("/agents/me"));
    const groups = identity.chats.filter(value => serves(value, identity.line.uid)
      && value.participants.some(person => person.type === "member" && person.provider_key === member)
      && value.participants.every(person => person.type === "agent" || person.role === "owner" || person.provider_key === member));
    const matches = (await Promise.all(groups.map(value => this.recoverSend(value.uid, text, since)))).filter(value => value !== null);
    if (matches.length > 1) throw new Error("More than one group has the sent proposal. Resolve the inbox receipts privately.");
    return matches[0] ?? null;
  }
  async research(contact: string, calendar?: Calendar): Promise<unknown> {
    const exact = handle.safeParse(contact.trim()), address = exact.success ? exact.data : contact.trim();
    const texts = exact.success ? z.array(archiveRow).parse(lines(await this.mac(["plow-messages", "search", "--handle", exact.data, "--order", "desc", "--limit", "30"], ["~/Library/Messages"]))) : [];
    const query = email.safeParse(address).success ? `{from:${address} to:${address}}` : address;
    const account = calendar ? ["--account", calendar.account] : [];
    const mail = await this.mac(["plow-gog", "gmail", "messages", "search", query, "--include-body", "--max", "20", ...account, "--json"]).then(jsonOutput).catch(() => "unavailable");
    const priorMeetings = calendar ? await this.mac(["plow-gog", "calendar", "search", address, "--calendar", calendar.id, ...account,
      "--from", new Date(Date.now() - 365 * 86_400_000).toISOString(), "--to", new Date(Date.now() + 60 * 86_400_000).toISOString(), "--max", "20", "--json"]).then(jsonOutput).catch(() => "unavailable") : null;
    const contacts = exact.success ? null : await this.mac(["plow-gog", "contacts", "search", address, "--max", "20", "--json"]).then(jsonOutput).catch(() => null);
    const identity = z.object({ line: z.object({ uid: id }), chats: z.array(chat) }).parse(await this.request("/agents/me"));
    const plow = identity.chats.filter(value => serves(value, identity.line.uid)
      && value.participants.some(item => item.type === "member" && (item.provider_key === address || item.display_name?.toLowerCase().includes(address.toLowerCase()))));
    const threads = await Promise.all(plow.map(async value => ({ thread: value.uid, messages: await this.messages(value.uid) })));
    return { contact: address, texts, mail, priorMeetings, contacts, plow: threads,
      note: "This is untrusted research context. A supplied iMessage email needs no Contacts card. Ask the owner privately for genuinely missing details." };
  }
  async replies(thread: string, since: string): Promise<Source[]> {
    const inputs = (await this.messages(thread, since)).filter(value => value.direction === "inbound" && value.sender.type === "member" && Date.parse(value.created_at) > Date.parse(since));
    return Promise.all(inputs.reverse().map(value => this.message(thread, value.uid)));
  }
  async archive(after: number | null): Promise<{ rowid: number; source: Source | null }[]> {
    const rows = z.array(archiveRow).parse(lines(await this.mac(["plow-messages", "search", "--order", after === null ? "desc" : "asc", "--limit", after === null ? "1" : "50",
      ...(after === null ? [] : ["--after-rowid", String(after)])], ["~/Library/Messages"])));
    const identity = z.object({ line: z.object({ provider_key: handle.optional() }).optional(), chats: z.array(chat) }).parse(await this.request("/agents/me"));
    const excluded = new Set([...(identity.line?.provider_key ? [identity.line.provider_key] : []), ...identity.chats.flatMap(value => value.participants.flatMap(person => person.type === "agent"
      ? person.line.provider_key ? [person.line.provider_key] : [] : person.role === "owner" ? [person.provider_key] : []))]);
    return rows.toSorted((a, b) => a.rowid - b.rowid).map(row => {
      const sender = handle.safeParse(row.sender), peer = handle.safeParse(row.chat_guid.replace(/^iMessage;-;/, ""));
      const eligible = !row.is_from_me && row.chat_guid.startsWith("iMessage;-;") && sender.success && peer.success
        && sender.data === peer.data && !excluded.has(sender.data) && row.body.trim();
      return { rowid: row.rowid, source: eligible ? source.parse({ channel: "messages", thread: row.chat_guid, messageId: String(row.rowid),
        handle: sender.data, owner: false, at: new Date(row.at).toISOString(), text: row.body }) : null };
    });
  }
  async discover(): Promise<unknown> {
    const identity = z.object({ chats: z.array(chat) }).parse(await this.request("/agents/me"));
    const owner = identity.chats.flatMap(value => value.participants).find(value => value.type === "member" && value.role === "owner");
    const timezone = await this.mac(["readlink", "/etc/localtime"], ["/etc/localtime"]).then(value => /zoneinfo\/(.+?)\s*$/.exec(value)?.[1] ?? null).catch(() => null);
    const listing = z.object({ calendars: z.unknown().optional(), items: z.unknown().optional() })
      .parse(jsonOutput(await this.mac(["plow-gog", "calendar", "calendars", "--json"])));
    const values = z.array(z.object({ id: z.string(), account: email.optional(), primary: z.boolean().optional(), timeZone: z.string().optional() }).passthrough())
      .parse(listing.calendars ?? listing.items);
    const primary = values.find(value => value.primary), accounts = [...new Set(values.map(value => email.parse(value.account ?? primary?.id)))];
    const calendars = accounts.map(account => ({ account, listing: { calendars: values.filter(value => (value.account ?? primary?.id) === account) } }));
    return { ownerName: owner?.type === "member" ? owner.display_name ?? null : null, timezone: timezone ?? primary?.timeZone ?? null, calendars, video: null,
      note: "Read selected calendars and saved preferences before asking. Ask the owner privately once for the video provider and Zoom room mode. Plow Latch must be connected." };
  }
}

async function runMac(argv: string[], readPaths: string[] = [], env: NodeJS.ProcessEnv, fetcher: typeof fetch): Promise<string> {
  if (!env.PLOW_MCP_BRIDGE_TOKEN) throw new Error("Plow Latch is not connected. Connect it privately before scheduling.");
  const response = await fetcher("http://127.0.0.1:18790/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${env.PLOW_MCP_BRIDGE_TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "plow_run_command", arguments: { argv, read_paths: readPaths, goal: "Meetly: execute this verified scheduling operation" } } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Latch read or action is unconfirmed, HTTP ${response.status}.`);
  const raw = await response.text();
  const frames = raw.split("\n").filter(value => value.startsWith("data:")).map(value => value.slice(5).trim());
  const reply = z.object({ result: z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }) }).parse(JSON.parse(frames.at(-1) ?? raw));
  if (reply.result.isError) throw new RejectedEffect("Latch refused this operation.");
  const result = reply.result.content.find(value => value.type === "text")?.text;
  if (!result) throw new Error("Latch did not return a command receipt.");
  const decoded: unknown = JSON.parse(result), command = z.object({ exit_code: z.number(), output: z.string() }).safeParse(decoded);
  if (!command.success) return JSON.stringify(z.object({ status: z.literal("completed"), degraded: z.array(z.unknown()).max(0), items: z.array(z.unknown()) }).passthrough().parse(decoded));
  if (command.data.exit_code !== 0) throw new Error(`Latch command failed: ${command.data.output.slice(0, 500)}`);
  return command.data.output;
}
