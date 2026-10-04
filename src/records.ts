import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { advice, liveHolds, page, preferences, source, sourceKey, type Contact, type Meeting, type Page, type Preferences, type Source } from "./model.ts";

function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
// OpenClaw may register separate plugin instances for hooks and tool discovery.
// They share one gateway process; serialize them by their canonical state root.
const queueKey = Symbol.for("meetly.operationQueues");
const shared = globalThis as typeof globalThis & { [queueKey]?: Map<string, Promise<unknown>> };
const queues = shared[queueKey] ??= new Map<string, Promise<unknown>>();

function atomic(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temp, value, { mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
}

function metadata(text: string): Record<string, unknown> {
  const header = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!header?.[1]) throw new Error("The wiki page has no readable metadata; do not replace it.");
  return Object.fromEntries(header[1].split("\n").map(line => {
    const colon = line.indexOf(":");
    if (colon < 1) throw new Error("The wiki page has malformed metadata.");
    return [line.slice(0, colon), JSON.parse(line.slice(colon + 1))];
  }));
}

function frontmatter(values: Record<string, unknown>): string {
  return `---\n${Object.entries(values).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n`;
}

export const linkSteps = (value: Preferences["video"]): string[] => value === null ? []
  : value.kind === "google_meet" ? [
    "Update the selected calendar hold with --with-meet and --send-updates all.",
    "Read the event back and verify its Meet URL, time and attendees.",
    "Record the verified invitation before deleting sibling holds and travel blocks.",
  ] : value.kind === "zoom_personal" ? [
    "Use the saved personal Zoom URL as the invitation location; do not create a Meet conference.",
    "Read the event back and verify the exact Zoom URL, time and attendees.",
    "Record the verified invitation before deleting sibling holds and travel blocks.",
  ] : [
    "Update the selected hold with plow-gog calendar update --with-zoom --include-passwords --send-updates all, using the owner's connected Zoom account.",
    "Save the verified Zoom join URL; keep that URL when rescheduling and do not regenerate Zoom or create a Meet conference.",
    "Read the invitation back and verify its exact Zoom URL, time and attendees before sibling cleanup.",
  ];

const operationRow = z.object({ key: z.string(), input: z.string(), state: z.enum(["started", "confirmed", "rejected"]), receipt: z.string().nullable() });
export class UncertainEffect extends Error {
  readonly key: string;
  constructor(key: string) { super(`Operation ${key} is unconfirmed. Reconcile its provider receipt before trying again.`); this.key = key; }
}
export class RejectedEffect extends Error {}
type Effect<T> = { run: () => Promise<T>; recover?: () => Promise<T | null>; retry?: "safe" };

export class Records {
  readonly db: DatabaseSync;
  readonly pipeline: string;
  readonly root: string;
  constructor(root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = realpathSync(root);
    this.pipeline = join(this.root, "projects/founder-agent/pipeline");
    mkdirSync(this.pipeline, { recursive: true });
    const path = join(this.root, ".meetly-operations.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY, input TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT);
      CREATE TABLE IF NOT EXISTS projections(path TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(key TEXT PRIMARY KEY, body TEXT NOT NULL, handled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cursors(key TEXT PRIMARY KEY, position INTEGER NOT NULL);`);
    this.recoverPages();
  }
  close(): void { this.db.close(); }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = (queues.get(this.root) ?? Promise.resolve()).then(work);
    const settled = result.catch(() => undefined);
    queues.set(this.root, settled);
    try { return await result; }
    finally { if (queues.get(this.root) === settled) queues.delete(this.root); }
  }

  path(contact: Contact): string {
    const slug = contact.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "contact";
    const suffix = createHash("sha256").update(contact.handle).digest("hex").slice(0, 10);
    return join(this.pipeline, `${slug}-${suffix}.md`);
  }
  pages(): Page[] {
    return readdirSync(this.pipeline).filter(name => name.endsWith(".md")).map(name => this.readPage(join(this.pipeline, name)));
  }
  readPage(path: string): Page {
    const body = readFileSync(path, "utf8");
    return page.parse({ ...metadata(body), log: body.split("\n## Log\n\n")[1] ?? "" });
  }
  find(id: string): Meeting {
    const found = this.pages().flatMap(value => value.meetings).find(value => value.id === id);
    if (!found) throw new Error(`No recorded meeting ${id}.`);
    return found;
  }
  contact(handle: string): Page | undefined { return this.pages().find(value => value.contact.handle === handle); }
  save(value: Meeting, observation: string): void {
    const existing = this.contact(value.contact.handle);
    const path = existing ? this.path(existing.contact) : this.path(value.contact);
    const meetings = [...(existing?.meetings.filter(item => item.id !== value.id) ?? []), value];
    const next = page.parse({ version: 1, contact: existing?.contact ?? value.contact, meetings,
      log: `${existing?.log ?? ""}${value.updatedAt} ${observation.replace(/\s+/g, " ")}\n\n` });
    const body = frontmatter({ version: next.version, contact: next.contact, status: value.status,
      holds: meetings.flatMap(liveHolds), proposed: value.proposed, next_step: advice(value), meetings: next.meetings })
      + `# ${next.contact.name}\n\n## Log\n\n${next.log}`;
    this.db.prepare("INSERT OR REPLACE INTO projections(path,body) VALUES (?,?)").run(path, body);
    atomic(path, body);
    this.db.prepare("DELETE FROM projections WHERE path=?").run(path);
  }
  recoverPages(): void {
    const pending = z.array(z.object({ path: z.string(), body: z.string() })).parse(this.db.prepare("SELECT path,body FROM projections").all());
    for (const value of pending) {
      if (dirname(value.path) !== this.pipeline) throw new Error("A recovery projection points outside the contact wiki.");
      page.parse({ ...metadata(value.body), log: value.body.split("\n## Log\n\n")[1] ?? "" });
      atomic(value.path, value.body);
      this.db.prepare("DELETE FROM projections WHERE path=?").run(value.path);
    }
  }
  owner(): Preferences | null {
    try { return preferences.parse(metadata(readFileSync(join(this.root, "entities/owner/scheduling.md"), "utf8")).preferences); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  remember(value: Preferences, confirmed: Source): void {
    const body = frontmatter({ preferences: value, video_link_steps: linkSteps(value.video), confirmed_message: confirmed.messageId })
      + `# Scheduling preferences\n\n${confirmed.at} The owner confirmed these scheduling preferences.\n`;
    atomic(join(this.root, "entities/owner/scheduling.md"), body);
  }
  receive(value: Source): boolean {
    const parsed = source.parse(value);
    return this.db.prepare("INSERT OR IGNORE INTO inbox(key,body) VALUES (?,?)")
      .run(sourceKey(parsed), JSON.stringify(parsed)).changes > 0;
  }
  pendingSources(): Source[] {
    return z.array(z.object({ body: z.string() })).parse(this.db.prepare("SELECT body FROM inbox WHERE handled=0 ORDER BY rowid").all())
      .map(value => source.parse(JSON.parse(value.body)));
  }
  handled(value: Source): void {
    this.db.prepare("UPDATE inbox SET handled=1 WHERE key=?").run(sourceKey(value));
  }
  isHandled(value: Source): boolean {
    const row = this.db.prepare("SELECT handled FROM inbox WHERE key=?").get(sourceKey(value));
    return row !== undefined && z.object({ handled: z.number() }).parse(row).handled === 1;
  }
  ownerSource(thread: string): Source | null {
    const row = this.db.prepare("SELECT body FROM inbox WHERE json_extract(body,'$.thread')=? AND json_extract(body,'$.owner')=1 ORDER BY rowid DESC LIMIT 1").get(thread);
    return row ? source.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body)) : null;
  }
  cursor(): number | null {
    return z.number().int().nonnegative().nullable().parse(this.db.prepare("SELECT (SELECT position FROM cursors WHERE key='messages') AS position").get()?.position);
  }
  advanceCursor(position: number): void {
    this.db.prepare("INSERT INTO cursors(key,position) VALUES ('messages',?) ON CONFLICT(key) DO UPDATE SET position=max(position,excluded.position)").run(position);
  }
  async capture(value: Source): Promise<void> {
    if (value.channel !== "messages" || value.owner) throw new Error("Discovery requires an incoming Mac receipt.");
    await this.effect(`discovery:${sourceKey(value)}`, value, source, { run: async () => value, retry: "safe" });
    this.receive(value);
  }
  isDiscovered(value: Source): boolean {
    const receipt = this.operation(`discovery:${sourceKey(value)}`);
    return value.channel === "messages" && !value.owner && receipt?.state === "confirmed" && receipt.receipt === JSON.stringify(source.parse(value));
  }
  uncertain(): string[] { return this.unfinished().map(value => value.key); }
  operation(key: string): z.infer<typeof operationRow> | null {
    const row = this.db.prepare("SELECT * FROM operations WHERE key=?").get(key);
    return row ? operationRow.parse(row) : null;
  }
  unfinished(): { key: string; input: unknown }[] {
    return z.array(operationRow).parse(this.db.prepare("SELECT * FROM operations WHERE state='started' ORDER BY rowid").all())
      .map(value => ({ key: value.key, input: JSON.parse(value.input) }));
  }
  reject(key: string): void { this.db.prepare("UPDATE operations SET state='rejected' WHERE key=? AND state='started'").run(key); }
  activeWith(prefix: string): string[] {
    return z.array(z.object({ key: z.string() })).parse(this.db.prepare("SELECT key FROM operations WHERE state!='rejected' AND substr(key,1,?)=? ORDER BY rowid").all(prefix.length, prefix)).map(value => value.key);
  }
  pendingTasks(): unknown[] { return this.unfinished().filter(value => value.key.startsWith("task:")).map(value => value.input); }
  async effect<T>(key: string, input: unknown, schema: z.ZodType<T>, effect: Effect<T>): Promise<T> {
    const serialized = JSON.stringify(input);
    const saved = this.operation(key);
    if (saved) {
      if (saved.input !== serialized) throw new Error("An operation key cannot be reused for a different action.");
      const resumed = await this.resumeEffect(saved, schema, effect);
      if (resumed) return resumed.receipt;
    } else this.db.prepare("INSERT INTO operations(key,input,state) VALUES (?,?,'started')").run(key, serialized);
    try { return this.confirm(key, schema.parse(await effect.run())); }
    catch (error) {
      if (error instanceof RejectedEffect) this.db.prepare("UPDATE operations SET state='rejected' WHERE key=?").run(key);
      throw error;
    }
  }
  private async resumeEffect<T>(saved: z.infer<typeof operationRow>, schema: z.ZodType<T>, effect: Effect<T>): Promise<{ receipt: T } | null> {
    if (saved.state === "confirmed") {
      if (saved.receipt === null) throw new Error("A confirmed operation has no provider receipt.");
      return { receipt: schema.parse(JSON.parse(saved.receipt)) };
    }
    if (saved.state === "rejected") throw new RejectedEffect(`Operation ${saved.key} was rejected.`);
    const recovered = await effect.recover?.();
    if (recovered != null) return { receipt: this.confirm(saved.key, schema.parse(recovered)) };
    if (effect.retry === "safe") return null;
    throw new UncertainEffect(saved.key);
  }
  private confirm<T>(key: string, receipt: T): T {
    this.db.prepare("UPDATE operations SET state='confirmed',receipt=? WHERE key=?").run(JSON.stringify(receipt), key);
    return receipt;
  }
}
