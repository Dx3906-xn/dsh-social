// A live probe against the real Bilibili endpoints.
//
// Not an assertion suite: it needs the network, and a failure may mean the
// platform changed rather than the code broke. Run it by hand when the question
// is "does the window still open", and read the shapes it prints.
//
//   node test/live-bilibili.mjs [limit]
import { PLATFORM, browsePopular, lookUp, scoreInterest } from '../lib/bilibili.js';

const limit = Math.max(1, Number(process.argv[2]) || 5);

console.log(`platform: ${PLATFORM}`);
console.log(`--- popular (limit ${limit})`);
const run = await browsePopular({ limit, interests: ['猫', '画画'] });
console.log(`fetched=${run.views.length} errors=${run.errors.length}`);
for (const error of run.errors) console.log(`  error: ${error}`);
for (const view of run.views) {
  console.log(`  [${view.interest.toFixed(2)}] ${view.title}`);
  console.log(`        ${view.author} · ${view.url}`);
  if (view.description !== undefined) console.log(`        ${view.description.slice(0, 60)}`);
}

if (run.views.length > 0) {
  const first = run.views[0];
  console.log(`--- detail (${first.nativeId})`);
  const found = await lookUp(first.nativeId, { interests: ['猫'] });
  if (found.view === undefined) console.log(`  error: ${found.error}`);
  else console.log(`  ${found.view.title} — ${found.view.author} (interest ${found.view.interest})`);
}

console.log(`--- scoring sanity`);
const probe = {
  id: 'probe',
  platform: 'bilibili',
  nativeId: 'probe',
  url: '',
  title: '猫猫画画日常',
  author: 'UP',
  tags: [],
  seenAt: 0,
  interest: 0,
};
console.log(`  with [猫]      -> ${scoreInterest(probe, ['猫'])}`);
console.log(`  with [编程]    -> ${scoreInterest(probe, ['编程'])}`);
console.log(`  with []        -> ${scoreInterest(probe, [])}`);