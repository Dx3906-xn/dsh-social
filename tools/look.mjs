// Run one look, from the shell, against the same store the plugin uses.
//
// This exists because the plugin's `look` is only reachable from a running
// harness (`/social look`). An operator who wants to seed the window, or to see
// what a run would return before trusting it, needs the same work done outside a
// session. It deliberately shares `store`, `bilibili` and the config file rather
// than reimplementing them: a tool that wrote rows the plugin could not read
// would be worse than no tool.
//
//   node tools/look.mjs [--limit 20] [--no-feed] [--keyword "…"] [--dry]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { browsePopular, relatedVideos, searchVideos } from '../lib/bilibili.js';
import { createStore } from '../lib/store.js';

/**
 * Read the `social` row out of a profile's cordis.patch.yml without a YAML parser.
 *
 * A real parser would be the right answer for a general tool; this one walks the
 * exact block the project writes, tracking indentation so that a nested list
 * belongs to the key above it. It is deliberately small: a wrong parse here shows
 * up as "no keywords", which is visible, rather than as a silent write to the
 * wrong file.
 *
 * @param {string} path - the profile patch file.
 * @returns {{interests: string[], keywords: string[], cookieRef: string, dataPath: string}} the settings.
 */
function readConfig(path) {
  const text = readFileSync(path, 'utf8');
  const start = text.indexOf('- id: social');
  if (start < 0) throw new Error(`no social block in ${path}`);
  const out = { interests: [], keywords: [], seeds: [], cookieRef: '', dataPath: '' };
  /** The key a following list belongs to, and the indent that key sits at. */
  let section = '';
  let sectionIndent = 0;

  for (const line of text.slice(start).split('\n').slice(1)) {
    if (/^- id:/.test(line)) break;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    const item = /^\s*-\s*(.+)$/.exec(line);
    if (item !== null) {
      // An item belongs to the nearest key above it at a shallower indent.
      if (section === '' || indent <= sectionIndent) continue;
      const raw = item[1].replace(/^['"]|['"]$/g, '').trim();
      if (section === 'interests') out.interests.push(raw);
      if (section === 'keywords') out.keywords.push(raw);
      if (section === 'seeds') out.seeds.push(raw);
      continue;
    }

    const kv = /^(\s*)([a-zA-Z]+):\s*(.*)$/.exec(line);
    if (kv === null) continue;
    section = kv[2];
    sectionIndent = kv[1].length;
    const raw = kv[3].replace(/^['"]|['"]$/g, '').trim();
    if (section === 'cookieRef') out.cookieRef = raw;
    if (section === 'dataPath') out.dataPath = raw;
  }
  return out;
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};

const home = value('home', process.env.DSH_HOME?.trim() || '');
if (home === '') {
  console.error('need --home <DSH_HOME> (or set DSH_HOME); this tool reads a profile, not the cwd');
  process.exit(1);
}
const profile = join(home, 'profiles', 'b', 'cordis.patch.yml');
const config = readConfig(profile);
const dataPath = config.dataPath || join(home, 'social', 'views.jsonl');
const limit = Number(value('limit', 20)) || 20;

let cookie = '';
if (config.cookieRef !== '') {
  const credentials = readFileSync(join(home, '.credentials.yaml'), 'utf8');
  const match = new RegExp(`${config.cookieRef}:\\s*'?([^'\\n]+)'?`).exec(credentials);
  cookie = match === null ? '' : match[1].trim();
}

console.log(`store:   ${dataPath}`);
console.log(`interests: ${config.interests.join(', ') || '(none)'}`);
console.log(`keywords:  ${config.keywords.join(', ') || '(none)'} ${cookie === '' ? '(no cookie: search skipped)' : '(cookie present)'}`);

const views = [];
const errors = [];

// Seeds first: the durable way to follow a topic, and it needs no session.
if (!flag('no-seeds')) {
  for (const seed of config.seeds.slice(0, 3)) {
    const found = await relatedVideos({ bvid: seed, limit, interests: config.interests });
    errors.push(...found.errors);
    views.push(...found.views);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

// One keyword per run, rotated by how many rows are already stored: asking five
// questions in a row is what the platform answers with 412. `--keyword` pins one
// for a deliberate single test.
const stored = (() => {
  try {
    return readFileSync(dataPath, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
  } catch {
    return 0;
  }
})();
const keywords = value('keyword', '') !== '' ? [value('keyword', '')] : config.keywords;
const keyword = keywords.length === 0 ? '' : keywords[stored % keywords.length];

if (!flag('no-search') && cookie !== '' && keyword !== '') {
  const gap = Math.max(0, Number(value('search-gap', 20000)) || 0);
  console.log(`\nsearching "${keyword}" after ${Math.round(gap / 1000)}s…`);
  await new Promise((resolve) => setTimeout(resolve, Math.min(gap, 30_000)));
  const found = await searchVideos({ keyword, cookie, limit, interests: config.interests });
  errors.push(...found.errors);
  views.push(...found.views);
}

if (!flag('no-feed')) {
  const browse = await browsePopular({ limit, interests: config.interests, gapMs: 1500 });
  errors.push(...browse.errors);
  views.push(...browse.views);
}

/** @type {Map<string, any>} */
const merged = new Map();
for (const view of views) {
  const existing = merged.get(view.id);
  if (existing === undefined || (existing.description === undefined && view.description !== undefined)) {
    merged.set(view.id, view);
  }
}

const rows = [...merged.values()].sort((a, b) => b.interest - a.interest);
console.log(`\nfetched ${views.length}, unique ${rows.length}, errors ${errors.length}`);
for (const error of errors) console.log(`  error: ${error}`);
for (const row of rows) {
  console.log(`  [${row.interest.toFixed(2)}] ${row.title.slice(0, 50)} — ${row.author}`);
}

if (flag('dry')) {
  console.log('\n(dry run: nothing written)');
  process.exit(0);
}

const store = createStore({ path: dataPath });
let added = 0;
let skipped = 0;
for (const row of rows) {
  if (store.has(row.id)) {
    skipped += 1;
    continue;
  }
  if (store.add(row)) added += 1;
}
console.log(`\nwritten: ${added} new, ${skipped} already known, ${store.stats().total} total`);