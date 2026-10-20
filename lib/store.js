/**
 * Where the window's results live.
 *
 * An append-only JSONL file, one view per line. Three reasons this is not a
 * database:
 *
 *   - The rows are read whole and in recency order. There is no query planner to
 *     satisfy, and a file that can be opened in a text editor is worth more than
 *     an index when the question is "why did she bring this up".
 *   - The interesting failure is a torn last line, and JSONL loses exactly one
 *     line to it. A single-document JSON file loses the whole file.
 *   - Nothing here is rewritten except by compaction, so a crash between two
 *     runs costs at most the run in flight.
 *
 * Compaction exists because an append-only file grows forever. It runs on load
 * when the file exceeds `maxRows`, drops the oldest rows, and rewrites once.
 *
 * @module dsh-social/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How many rows a store keeps before compaction, unless configured otherwise. */
export const DEFAULT_MAX_ROWS = 5000;

/**
 * Read a JSONL file into rows, tolerating a torn tail.
 *
 * @param {string} path - the file.
 * @param {(message: string, detail?: unknown) => void} [log] - diagnostic sink.
 * @returns {import('./types.js').SocialView[]} parsed rows, oldest first.
 */
function readRows(path, log = () => {}) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (typeof row?.id === 'string' && row.id !== '' && typeof row.title === 'string') rows.push(row);
    } catch {
      // A torn final line is the expected case after a kill; anything else is
      // one corrupted row, and dropping one row is better than refusing the file.
      log(`social: skipped an unreadable line in ${path}`);
    }
  }
  return rows;
}

/**
 * Create the in-memory view of the store, backed by one JSONL file.
 *
 * @param {object} options - store options.
 * @param {string} options.path - absolute path to the JSONL file.
 * @param {number} [options.maxRows] - rows kept after compaction.
 * @param {(message: string, detail?: unknown) => void} [options.log] - diagnostic sink.
 * @returns {object} the store handle.
 */
export function createStore(options) {
  const path = String(options.path ?? '');
  if (path === '') throw new Error('dsh-social: store needs a path');
  const maxRows = Math.max(100, Number(options.maxRows) || DEFAULT_MAX_ROWS);
  const log = options.log ?? (() => {});

  /** @type {Map<string, import('./types.js').SocialView>} */
  const byId = new Map();
  /** Insertion order, oldest first; the compaction and the recency list both read it. */
  const order = [];

  const loaded = readRows(path, log);
  for (const row of loaded) {
    if (byId.has(row.id)) continue;
    byId.set(row.id, row);
    order.push(row.id);
  }

  /**
   * Rewrite the file from memory, dropping the oldest rows.
   *
   * Written to a sibling and renamed so a crash mid-rewrite leaves the previous
   * file intact rather than a half-file that parses as far as it got.
   *
   * @returns {number} how many rows were dropped.
   */
  function compact() {
    const drop = Math.max(0, order.length - maxRows);
    if (drop === 0) return 0;
    for (let i = 0; i < drop; i += 1) byId.delete(order[i]);
    order.splice(0, drop);
    const body = order.map((id) => JSON.stringify(byId.get(id))).join('\n');
    const temp = `${path}.compact`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temp, body === '' ? '' : `${body}\n`, 'utf8');
      renameSync(temp, path);
    } catch (error) {
      log(`social: could not compact ${path}`, error);
    }
    return drop;
  }

  if (order.length > maxRows * 2) compact();

  return {
    /**
     * Add one view unless its id is already known.
     *
     * @param {import('./types.js').SocialView} view - the row.
     * @returns {boolean} whether it was new.
     */
    add(view) {
      if (typeof view?.id !== 'string' || view.id === '' || byId.has(view.id)) return false;
      byId.set(view.id, view);
      order.push(view.id);
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(view)}\n`, 'utf8');
      } catch (error) {
        // Keeping it in memory still lets this process talk about it; the cost of
        // the write failing is that the next process has not seen it.
        log(`social: could not append to ${path}`, error);
      }
      if (order.length > maxRows * 2) compact();
      return true;
    },

    /**
     * Whether an id is already stored.
     *
     * @param {string} id - stable view id.
     * @returns {boolean} true when known.
     */
    has(id) {
      return byId.has(id);
    },

    /**
     * The most recently seen rows, newest first.
     *
     * @param {{limit?: number, platform?: string, minInterest?: number}} [options] - filters.
     * @returns {import('./types.js').SocialView[]} rows.
     */
    recent(options = {}) {
      const limit = Math.max(1, Number(options.limit) || 10);
      const platform = typeof options.platform === 'string' ? options.platform : '';
      const minInterest = Number.isFinite(Number(options.minInterest)) ? Number(options.minInterest) : undefined;
      const out = [];
      for (let i = order.length - 1; i >= 0 && out.length < limit; i -= 1) {
        const row = byId.get(order[i]);
        if (row === undefined) continue;
        if (platform !== '' && row.platform !== platform) continue;
        if (minInterest !== undefined && Number(row.interest ?? 0) < minInterest) continue;
        out.push(row);
      }
      return out;
    },

    /**
     * One row by stable id.
     *
     * @param {string} id - stable view id.
     * @returns {import('./types.js').SocialView|undefined} the row.
     */
    get(id) {
      return byId.get(id);
    },

    /**
     * Counts for a diagnostic surface.
     *
     * @returns {{total: number, byPlatform: Record<string, number>}} the counts.
     */
    stats() {
      /** @type {Record<string, number>} */
      const byPlatform = {};
      for (const row of byId.values()) {
        byPlatform[row.platform] = (byPlatform[row.platform] ?? 0) + 1;
      }
      return { total: byId.size, byPlatform };
    },

    /** The backing file, for a report to point at. */
    get file() {
      return path;
    },

    /** Whether the file existed at load time. */
    get existed() {
      return existsSync(path);
    },

    /** Force a compaction now; returns how many rows were dropped. */
    compact,
  };
}