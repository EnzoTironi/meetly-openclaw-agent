// The poll's high-water mark in the owner's iMessage database, plus the
// record of consecutive read failures behind the one-time warning.
//
// `held` is the first row of a request the poll decided to answer. Until the
// ledger records a request from that row, the cursor stops just below it, so a
// poll that fails part-way through the offer can never mark it read.
import { isMain, run } from "./cli.ts";
import type { Ledger } from "./ledger.ts";
import { file } from "./paths.ts";
import { readJson, updateJson } from "./store.ts";

export type Cursor = { rowid: number | null; updatedAt?: string; failingSince?: string; warnedAt?: string; held?: number };

export const WARN_AFTER_MS = 30 * 60_000;

const EMPTY: Cursor = { rowid: null };

function clearFailure(c: Cursor): Cursor {
  const { failingSince: _f, warnedAt: _w, ...rest } = c;
  return rest;
}

function checkRowid(rowid: number): void {
  if (!Number.isInteger(rowid) || rowid < 0) throw new Error(`rowid must be a whole number >= 0, got ${rowid}`);
}

export function setRowid(c: Cursor, rowid: number, now: number, recorded: (rowid: number) => boolean = () => false): Cursor {
  checkRowid(rowid);
  if (c.rowid !== null && rowid < c.rowid) throw new Error(`cursor never moves back (at ${c.rowid}, asked ${rowid})`);
  let next: Cursor = { ...clearFailure(c), rowid, updatedAt: new Date(now).toISOString() };
  if (c.held !== undefined && rowid >= c.held) {
    if (recorded(c.held)) next = release(next);
    else next.rowid = Math.max(c.held - 1, c.rowid ?? 0);
  }
  return next;
}

export function hold(c: Cursor, rowid: number): Cursor {
  checkRowid(rowid);
  if (c.rowid !== null && rowid <= c.rowid) throw new Error(`row ${rowid} is already past the cursor (at ${c.rowid})`);
  return { ...c, held: c.held === undefined ? rowid : Math.min(c.held, rowid) };
}

export function release(c: Cursor): Cursor {
  const { held: _h, ...rest } = c;
  return rest;
}

function inLedger(rowid: number): boolean {
  return readJson<Ledger>(file("ledger.json"), { requests: [] }).requests.some((r) => r.sourceRowid === rowid);
}

export function markFail(c: Cursor, now: number): { cursor: Cursor; warn: boolean } {
  const failingSince = c.failingSince ?? new Date(now).toISOString();
  const cursor: Cursor = { ...c, failingSince };
  const warn = !c.warnedAt && now - Date.parse(failingSince) >= WARN_AFTER_MS;
  if (warn) cursor.warnedAt = new Date(now).toISOString();
  return { cursor, warn };
}

export function markOk(c: Cursor): Cursor {
  return clearFailure(c);
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, arg] = process.argv.slice(2);
    const path = file("cursor.json");
    const now = Date.now();
    switch (cmd) {
      case "get":
        return readJson<Cursor>(path, EMPTY);
      case "set": {
        if (arg === undefined || !/^\d+$/.test(arg)) throw new Error(`usage: cursor.ts set <rowid>, got ${arg}`);
        return updateJson<Cursor>(path, EMPTY, (c) => setRowid(c, Number(arg), now, inLedger));
      }
      case "hold": {
        if (arg === undefined || !/^\d+$/.test(arg)) throw new Error(`usage: cursor.ts hold <rowid>, got ${arg}`);
        return updateJson<Cursor>(path, EMPTY, (c) => hold(c, Number(arg)));
      }
      case "release":
        return updateJson<Cursor>(path, EMPTY, release);
      case "fail": {
        let warn = false;
        const cursor = updateJson<Cursor>(path, EMPTY, (c) => {
          const r = markFail(c, now);
          warn = r.warn;
          return r.cursor;
        });
        return { failingSince: cursor.failingSince, warn };
      }
      case "ok":
        return updateJson<Cursor>(path, EMPTY, markOk);
      default:
        throw new Error("usage: cursor.ts get | set <rowid> | hold <rowid> | release | fail | ok");
    }
  });
}
