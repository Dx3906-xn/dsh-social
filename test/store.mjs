// What survives a restart, and what a torn file costs.
//
// The store is the only state this plugin keeps on disk, and it exists so that
// "I saw this yesterday" is still true tomorrow. The properties worth asserting
// are the ones that make it safe to keep: dedupe by stable id, recency order,
// a bounded file, and a corrupted line that costs one row rather than the file.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite } from './helpers.mjs';
import { createStore } from '../lib/store.js';

const t = suite('store');
const dir = mkdtempSync(join(tmpdir(), 'social-store-'));

/**
 * A view with sane defaults.
 *
 * @param {string} id - native id.
 * @param {object} [over] - overrides.
 * @returns {any} the view.
 */
const view = (id, over = {}) => ({
  id: `bilibili:${id}`,
  platform: 'bilibili',
  nativeId: id,
  url: `https://www.bilibili.com/video/${id}`,
  title: `标题 ${id}`,
  author: 'UP',
  tags: [],
  seenAt: 1000,
  interest: 0,
  ...over,
});

// --- round trip --------------------------------------------------------------
{
  const file = join(dir, 'roundtrip.jsonl');
  const first = createStore({ path: file });
  t.check(first.add(view('A')), 'a new row is added');
  t.check(!first.add(view('A')), 'the same id twice is refused');
  t.check(first.add(view('B', { interest: 0.5 })), 'a second row is added');

  const second = createStore({ path: file });
  t.check(second.get('bilibili:A') !== undefined, 'the row survived a restart');
  t.check(second.get('bilibili:B').interest === 0.5, 'its fields survived');
  t.check(second.stats().total === 2, 'the count survived');
  t.check(second.stats().byPlatform.bilibili === 2, 'the platform tally survived');
}

// --- recency -----------------------------------------------------------------
{
  const file = join(dir, 'recency.jsonl');
  const store = createStore({ path: file });
  store.add(view('old', { seenAt: 1 }));
  store.add(view('mid', { seenAt: 2 }));
  store.add(view('new', { seenAt: 3 }));
  const rows = store.recent({ limit: 2 });
  t.check(rows.length === 2, 'the limit is honoured');
  t.check(rows[0].nativeId === 'new', `newest first (got ${rows[0].nativeId})`);
  t.check(rows[1].nativeId === 'mid', 'then the next');
  t.check(store.recent({ limit: 10 }).length === 3, 'asking for more returns everything');
}

{
  const file = join(dir, 'interest.jsonl');
  const store = createStore({ path: file });
  store.add(view('low', { interest: 0.1 }));
  store.add(view('high', { interest: 0.9 }));
  const rows = store.recent({ minInterest: 0.5 });
  t.check(rows.length === 1, 'the interest floor filters');
  t.check(rows[0].nativeId === 'high', 'and keeps the one above it');
}

{
  const file = join(dir, 'platform.jsonl');
  const store = createStore({ path: file });
  store.add(view('b1'));
  store.add({ ...view('d1'), id: 'douyin:d1', platform: 'douyin' });
  t.check(store.recent({ platform: 'douyin' }).length === 1, 'platform filtering works');
  t.check(store.recent().length === 2, 'no filter returns both');
}

// --- a torn file -------------------------------------------------------------
{
  // The expected crash shape is a half-written last line. Losing that line is
  // correct; refusing the file is not.
  const file = join(dir, 'torn.jsonl');
  writeFileSync(file, `${JSON.stringify(view('A'))}\n{"id":"bilibili:B","title":"半`, 'utf8');
  const store = createStore({ path: file });
  t.check(store.stats().total === 1, 'the complete line is kept');
  t.check(store.get('bilibili:A') !== undefined, 'and it is the right one');
}

{
  // A line that is valid JSON but not a view is dropped too; a nameless row would
  // otherwise render as an empty bullet forever.
  const file = join(dir, 'shape.jsonl');
  writeFileSync(file, `${JSON.stringify({ hello: 'world' })}\n${JSON.stringify(view('A'))}\n`, 'utf8');
  const store = createStore({ path: file });
  t.check(store.stats().total === 1, 'a row without an id is dropped');
}

// --- compaction --------------------------------------------------------------
{
  const file = join(dir, 'compact.jsonl');
  const store = createStore({ path: file, maxRows: 100 });
  for (let i = 0; i < 250; i += 1) store.add(view(`V${i}`));
  t.check(store.stats().total <= 200, `the store stays bounded (got ${store.stats().total})`);
  t.check(store.get('bilibili:V249') !== undefined, 'the newest row is kept');
  t.check(store.get('bilibili:V0') === undefined, 'the oldest row is dropped');
  const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
  t.check(lines.length === store.stats().total, 'the file matches memory after compaction');
}

{
  // Appending after a compaction continues the same file rather than starting a
  // second one.
  const file = join(dir, 'compact2.jsonl');
  const store = createStore({ path: file, maxRows: 100 });
  for (let i = 0; i < 150; i += 1) store.add(view(`V${i}`));
  const before = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  store.add(view('after'));
  const after = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  t.check(after === before + 1, `one append writes one line (before ${before}, after ${after})`);
}

// --- a missing directory -----------------------------------------------------
{
  const file = join(dir, 'deep', 'nested', 'views.jsonl');
  const store = createStore({ path: file });
  t.check(store.add(view('A')), 'a missing parent directory is created');
  t.check(store.existed, 'and the file exists afterwards');
}

// --- no path -----------------------------------------------------------------
{
  let message = '';
  try {
    createStore({ path: '' });
  } catch (error) {
    message = error.message;
  }
  t.check(/needs a path/.test(message), 'a store without a path refuses to exist');
}

rmSync(dir, { recursive: true, force: true });
t.done();