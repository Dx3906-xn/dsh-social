// The `/social` command and the pieces that bound a run.
//
// A command is the only place a person can drive the window directly, so its
// parsing deserves the same care as a network call: an unknown verb must be an
// error rather than a silent browse, and a status line must never be a synonym
// for "I did nothing".
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite } from './helpers.mjs';
import { createDailyBudget, parseClock } from '../lib/budget.js';
import { runSocialCommand } from '../lib/command.js';
import { createStore } from '../lib/store.js';

const t = suite('command');
const dir = mkdtempSync(join(tmpdir(), 'social-command-'));

/**
 * A service backed by a real store, with a scripted `look`.
 *
 * @param {object} [options] - overrides.
 * @returns {any} the service.
 */
function harness(options = {}) {
  const store = createStore({ path: join(dir, `c-${Math.random().toString(36).slice(2)}.jsonl`) });
  const runs = [];
  return {
    store,
    service: {
      async look(args = {}) {
        runs.push(args);
        const run = options.run ?? { platform: 'bilibili', at: 1, fetched: 2, added: 1, skipped: 1, errors: [] };
        const view = {
          id: 'bilibili:BV1',
          platform: 'bilibili',
          nativeId: 'BV1',
          url: 'https://www.bilibili.com/video/BV1',
          title: '标题',
          author: 'UP',
          tags: [],
          seenAt: 1,
          interest: 0.75,
        };
        if (run.added > 0) store.add(view);
        return run;
      },
      recent(args = {}) {
        return store.recent(args);
      },
      get(id) {
        return store.get(id);
      },
      status() {
        return { ...store.stats(), lastRun: options.lastRun ?? null };
      },
    },
    runs,
  };
}

// --- status ------------------------------------------------------------------
{
  const { service, store } = harness();
  const result = await runSocialCommand(service, store, { rawInput: '' });
  t.check(result.kind === 'success', 'an empty input shows the state');
  t.check(result.text.includes('窗口'), 'the window is named');
  t.check(result.text.includes('还没看过'), 'and it says nothing has been looked at yet');
}

{
  const { service, store } = harness({
    lastRun: { platform: 'bilibili', at: 1, fetched: 20, added: 3, skipped: 17, errors: ['popular: rate-limited'] },
  });
  const result = await runSocialCommand(service, store, { rawInput: 'status' });
  t.check(result.kind === 'success', 'status is success even after a failed run');
  t.check(result.text.includes('取回 20'), 'the counters are reported');
  t.check(result.text.includes('新 3'), 'new rows are named');
  t.check(result.text.includes('重复 17'), 'and duplicates');
  t.check(result.text.includes('rate-limited'), 'a run error is surfaced, not swallowed');
}

// --- look --------------------------------------------------------------------
{
  const { service, store, runs } = harness();
  const result = await runSocialCommand(service, store, { rawInput: 'look 5' });
  t.check(result.kind === 'success', 'a look with no errors is success');
  t.check(runs[0].limit === 5, `the requested limit is passed through (got ${runs[0].limit})`);
  t.check(result.text.includes('新 1'), 'the run summary is printed');
}

{
  const { service, store, runs } = harness();
  await runSocialCommand(service, store, { rawInput: 'look' });
  t.check(runs[0].limit === 20, `an absent limit defaults to 20 (got ${runs[0].limit})`);
}

{
  const { service, store } = harness({
    run: { platform: 'bilibili', at: 1, fetched: 0, added: 0, skipped: 0, errors: ['popular: network: ENOTFOUND'] },
  });
  const result = await runSocialCommand(service, store, { rawInput: 'look' });
  t.check(result.kind === 'error', 'a failed look is an error, not a success');
  t.check(result.text.includes('ENOTFOUND'), 'and carries the reason');
}

// --- recent ------------------------------------------------------------------
{
  const { service, store } = harness();
  await runSocialCommand(service, store, { rawInput: 'look' });
  const result = await runSocialCommand(service, store, { rawInput: 'recent' });
  t.check(result.kind === 'success', 'recent is success');
  t.check(result.text.includes('标题'), 'it lists what was seen');
  t.check(result.text.includes('0.75'), 'and the interest score');
  t.check(result.text.includes('https://www.bilibili.com/video/BV1'), 'and the url');
}

{
  const { service, store } = harness();
  const result = await runSocialCommand(service, store, { rawInput: 'recent 3' });
  t.check(result.kind === 'success', 'an empty store is still success');
  t.check(result.text.includes('还没看过'), 'and says so in words');
}

// --- open --------------------------------------------------------------------
{
  const { service, store } = harness();
  await runSocialCommand(service, store, { rawInput: 'look' });
  const known = await runSocialCommand(service, store, { rawInput: 'open BV1' });
  t.check(known.kind === 'success', 'a known id opens from the store');
  t.check(known.text.includes('标题'), 'with its title');

  const prefixed = await runSocialCommand(service, store, { rawInput: 'open bilibili:BV1' });
  t.check(prefixed.kind === 'success', 'the prefixed form works too');
}

{
  const { service, store } = harness();
  const result = await runSocialCommand(service, store, { rawInput: 'open' });
  t.check(result.kind === 'error', 'open without an id is an error');
  t.check(result.text.includes('用法'), 'and prints usage');
}

// --- unknown -----------------------------------------------------------------
{
  const { service, store, runs } = harness();
  const result = await runSocialCommand(service, store, { rawInput: 'dance' });
  t.check(result.kind === 'error', 'an unknown verb is an error');
  t.check(runs.length === 0, 'and does not start a browse');
}

// --- the daily budget --------------------------------------------------------
{
  const budget = createDailyBudget(3);
  t.check(budget.remaining() === 3, 'a fresh day has the full allowance');
  t.check(budget.spend(2) === 2, 'spending under the cap succeeds');
  t.check(budget.spend(2) === 1, 'the last one is clipped to the cap');
  t.check(budget.spend(1) === 0, 'spending past the cap yields nothing');
  t.check(budget.remaining() === 0, 'and the allowance is gone');
  budget.reset();
  t.check(budget.remaining() === 3, 'a reset restores it');
}

{
  const zero = createDailyBudget(0);
  t.check(zero.spend(5) === 0, 'a limit of zero refuses everything');
  t.check(zero.remaining() === 0, 'and reports nothing left');
}

// --- the clock ---------------------------------------------------------------
{
  t.check(parseClock('08:30') === 510, 'a normal time parses');
  t.check(parseClock('0:00') === 0, 'midnight is zero');
  t.check(parseClock('23:59') === 1439, 'the last minute parses');
  t.check(parseClock('24:00') === null, 'hour 24 is refused');
  t.check(parseClock('08:60') === null, 'minute 60 is refused');
  t.check(parseClock('8.30') === null, 'a dot is not a colon');
  t.check(parseClock('') === null, 'an empty string is refused');
}

rmSync(dir, { recursive: true, force: true });
t.done();