/**
 * A read-only window onto social platforms, for a DSH companion agent.
 *
 * The shape, in one paragraph: `bilibili` knows how to ask one platform what is
 * out there without signing or logging in; `store` keeps what came back, newest
 * last, in one append-only file; `budget` bounds a day; `command` is the surface
 * a person can type; this module wires them into a service other plugins can
 * call. There is no write path anywhere: the plugin cannot post, comment, like,
 * follow or message, not because the code forgot to implement it but because an
 * agent that reads untrusted text must not hold a handle that can speak as her on
 * a platform whose punishment for automated speech is a banned account.
 *
 * @module dsh-social
 */

import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM, browsePopular, relatedVideos, searchVideos } from './bilibili.js';
import { createCooldown } from './cooldown.js';
import { createDailyBudget, parseClock } from './budget.js';
import { runSocialCommand } from './command.js';
import { createStore } from './store.js';

export const name = 'social';

/**
 * Plugin configuration.
 *
 * Defaults are the read-only ones on purpose. `schedule.enabled` is false, so
 * mounting the plugin does not start network traffic until somebody says so;
 * that is what makes this safe to add to a profile before the account question is
 * settled.
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('Mount the window. Off keeps the settings and makes no request.'),
  dataPath: z
    .string()
    .default('')
    .description('Where the JSONL of seen items lives. Empty uses $DSH_HOME/social/views.jsonl.'),
  interests: z
    .array(z.string())
    .default([])
    .description('Lowercase keywords she cares about; used to score how much a row is worth mentioning.'),
  keywords: z
    .array(z.string())
    .default([])
    .description('Search terms to browse by topic, in addition to the home feed. Requires cookieRef to be set: the search endpoint answers HTTP 412 to anonymous datacenter traffic.'),
  seeds: z
    .array(z.string())
    .default([])
    .description('Bilibili video ids whose *related* videos should be walked. This is the durable way to follow a topic: unlike search, `archive/related` is served anonymously and is not rate-limited in the same way.'),
  cookieRef: z
    .string()
    .default('')
    .description('Credential name holding a Bilibili session cookie (a `SESSDATA=…` header value). Empty means anonymous: home feed only, no keyword search. The cookie is never stored in a row or written to a log.'),
  maxRows: z
    .number()
    .default(5000)
    .description('Rows kept on disk. Older rows are dropped when the file is compacted.'),
  gapMs: z
    .number()
    .default(1500)
    .description('Wait between two requests to the platform, in milliseconds. Lower is faster and more likely to be rate-limited.'),
  searchGapMs: z
    .number()
    .default(20000)
    .description('Wait before a keyword search. Searches are rate-limited far harder than reads; twenty seconds is the floor that has been observed to work.'),
  searchCooldownMinutes: z
    .number()
    .default(10)
    .description('How long to stop searching after the platform answers HTTP 412. Continuing is what turns a short ban into a long one.'),
  fill: z
    .boolean()
    .default(false)
    .description('Ask for each item\u2019s detail page to fill in a real description. One extra request per row.'),
  dailyBudget: z
    .number()
    .default(60)
    .description('Maximum new rows recorded per local day across all runs. 0 disables browsing.'),
  schedule: z
    .object({
      enabled: z.boolean().default(false),
      times: z.array(z.string()).default(['08:30', '20:30']),
      limit: z.number().default(20),
    })
    .default({})
    .description('Look around on a daily clock. Times are "HH:mm" in the host\u2019s local timezone.'),
});

/**
 * Resolve the store path without depending on dsh-home-paths.
 *
 * @param {string} configured - the `dataPath` setting, possibly empty.
 * @returns {string} absolute path to the JSONL file.
 */
export function resolveDataPath(configured) {
  const text = String(configured ?? '').trim();
  if (text !== '') return text;
  const home = process.env.DSH_HOME?.trim();
  const root = home === undefined || home === '' ? join(homedir(), '.dsh') : home;
  return join(root, 'social', 'views.jsonl');
}

/**
 * The diagnostic sink.
 *
 * A warning rather than the logger service, for the same reason the QQ bridge
 * uses one: this has to be able to complain before the host tree is fully up.
 *
 * @param {string} message - what happened.
 * @param {unknown} [detail] - an error, when there is one.
 * @returns {void}
 */
function log(message, detail) {
  process.emitWarning(
    detail === undefined ? message : `${message}: ${detail instanceof Error ? detail.message : String(detail)}`
  );
}

/**
 * Wait between two requests.
 *
 * @param {number} ms - how long.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Mount the plugin.
 *
 * @param {any} ctx - the plugin context.
 * @param {z.infer<typeof Config>} config - validated configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  if (config.enabled !== true) {
    log('social: disabled by configuration; no window is open');
    return;
  }

  log(`social: mounted (store ${resolveDataPath(config.dataPath)}, keywords ${(config.keywords ?? []).length}, cookie ${String(config.cookieRef ?? '') || 'none'})`);

  const dataPath = resolveDataPath(config.dataPath);
  const store = createStore({ path: dataPath, maxRows: config.maxRows, log });
  const budget = createDailyBudget(config.dailyBudget);
  const interests = Array.isArray(config.interests) ? config.interests : [];

  /** @type {import('./types.js').SocialRun|null} */
  let lastRun = null;
  /** Guards against two runs overlapping when a schedule and a command collide. */
  let running = false;
  /** Timers installed for the schedule, cleared on dispose. */
  const timers = [];
  /** How many runs have searched; used to rotate keywords one per run. */
  let runCount = 0;
  const searchGapMs = Math.max(0, Number(config.searchGapMs) || 20000);
  const cooldown = createCooldown({
    path: `${dataPath}.cooldown`,
    cooldownMs: Math.max(0, Number(config.searchCooldownMinutes) || 10) * 60 * 1000,
    log,
  });

  /**
   * Resolve the session cookie named by `cookieRef`, if one is configured.
   *
   * Read per call rather than cached: the credential can be written while the
   * process runs (the Web UI's Models page does exactly that), and a cached
   * `undefined` would make every search fail until the next restart. A missing
   * service or a missing record both mean "anonymous", which is a supported mode
   * rather than an error.
   *
   * @returns {string} a `SESSDATA=…` header value, or '' for anonymous.
   */
  function cookieOf() {
    const ref = String(config.cookieRef ?? '').trim();
    if (ref === '') return '';
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined;
    if (credentials === undefined || typeof credentials.resolve !== 'function') return '';
    try {
      const resolved = credentials.resolve(ref);
      // `resolve` is synchronous in the local store; a promise would need an
      // await, and awaiting here would make `cookieOf` async for every caller.
      const value = resolved?.value;
      return typeof value === 'string' ? value.trim() : '';
    } catch (error) {
      log(`social: could not read the credential "${ref}"`, error);
      return '';
    }
  }

  /**
   * Look around once and record what is new.
   *
   * The budget is spent per stored row, not per request: a run that returns
   * twenty already-seen items cost network but not budget, which is what keeps a
   * tight loop from spending the day's allowance on the same front page.
   *
   * @param {{limit?: number, fill?: boolean}} [options] - run options.
   * @returns {Promise<import('./types.js').SocialRun>} what the run did.
   */
  async function look(options = {}) {
    const started = Date.now();
    const run = {
      platform: PLATFORM,
      at: started,
      fetched: 0,
      added: 0,
      skipped: 0,
      errors: /** @type {string[]} */ ([]),
    };
    if (running) {
      run.errors.push('a run is already in progress');
      lastRun = run;
      return run;
    }
    if (budget.remaining() <= 0) {
      run.errors.push('daily budget for new rows is spent');
      lastRun = run;
      return run;
    }
    running = true;
    try {
      const limit = Math.max(1, Number(options.limit) || 20);
      /** @type {import('./bilibili.js').SocialView[]} */
      let views = [];

      // Seeds first: `archive/related` is served anonymously, returns about forty rows
      // of the same topic, and is not subject to the search endpoint's 412. For
      // "keep finding more of this" it is strictly better than a keyword search, and
      // it is what keeps the window useful on a day when searching is closed.
      const seeds = Array.isArray(config.seeds) ? config.seeds.filter((id) => String(id).trim() !== '') : [];
      for (const seed of seeds.slice(0, 3)) {
        await sleep(config.gapMs);
        const found = await relatedVideos({ bvid: String(seed), limit, interests });
        run.errors.push(...found.errors);
        views.push(...found.views);
      }

      // Keyword search second, and only when a session is available. It is the only
      // path that can find something the seeds do not already neighbour, so it is
      // worth a try; a 412 closes it for `searchCooldownMinutes`, and continuing is
      // what turns a short ban into a long one.
      //
      // One keyword per run, rotated: asking five questions in a row is what the
      // platform answers with 412, and a ban costs more than the four missing
      // results.
      const keywords = Array.isArray(config.keywords) ? config.keywords.filter((word) => String(word).trim() !== '') : [];
      const cookie = cookieOf();
      if (keywords.length > 0 && cookie !== '') {
        if (cooldown.active()) {
          run.errors.push(`search paused until ${new Date(cooldown.until()).toLocaleString('zh-CN')}`);
        } else {
          const keyword = String(keywords[runCount % keywords.length]);
          await sleep(searchGapMs);
          const found = await searchVideos({ keyword, cookie, limit, interests });
          run.errors.push(...found.errors);
          views.push(...found.views);
          runCount += 1;
          if (found.errors.some((error) => /HTTP 412|rate-limited|banned/.test(error))) {
            cooldown.trip(`search "${keyword}" answered 412`);
          }
        }
      }

      if (options.feed !== false) {
        const browse = await browsePopular({
          limit,
          gapMs: config.gapMs,
          fill: options.fill ?? config.fill,
          interests,
        });
        run.errors.push(...browse.errors);
        views.push(...browse.views);
      }

      // Merge, cheapest dedupe first: a bvid seen in both a search and the feed
      // is one row, and the feed's version wins only when the search one is
      // missing a description.
      /** @type {Map<string, import('./bilibili.js').SocialView>} */
      const merged = new Map();
      for (const view of views) {
        const existing = merged.get(view.id);
        if (existing === undefined) {
          merged.set(view.id, view);
          continue;
        }
        if (existing.description === undefined && view.description !== undefined) merged.set(view.id, view);
      }
      run.fetched = merged.size;

      for (const view of merged.values()) {
        if (store.has(view.id)) {
          run.skipped += 1;
          continue;
        }
        if (budget.spend(1) === 0) {
          run.errors.push('daily budget exhausted mid-run');
          break;
        }
        if (store.add(view)) {
          run.added += 1;
          if (typeof ctx.emit === 'function') ctx.emit('social/view', view);
        } else {
          run.skipped += 1;
        }
      }
    } catch (error) {
      run.errors.push(`run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      lastRun = run;
    }
    return run;
  }

  /** The read-only service other plugins call. */
  const service = {
    look,
    recent(options = {}) {
      return store.recent(options);
    },
    get(id) {
      return store.get(id);
    },
    status() {
      const keywords = Array.isArray(config.keywords) ? config.keywords.filter((word) => String(word).trim() !== '') : [];
      return {
        ...store.stats(),
        lastRun,
        keywords,
        searchReady: keywords.length > 0 && cookieOf() !== '',
      };
    },
  };

  // `provide` returns a disposable that removes the service again; handing it to
  // `ctx.effect` is what makes an unload not leave a dead service behind.
  ctx.effect(() => {
    const dispose = ctx.provide('social', service);
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      dispose();
    };
  });

  // Schedule: one timer per configured clock time, re-armed after every fire so a
  // laptop that sleeps through 08:30 still looks around after it wakes.
  if (config.schedule?.enabled === true) {
    const limit = Math.max(1, Number(config.schedule.limit) || 20);
    const arm = (/** @type {number} */ target) => {
      const now = new Date();
      const next = new Date(now);
      next.setHours(Math.floor(target / 60), target % 60, 0, 0);
      let delay = next.getTime() - now.getTime();
      if (delay < 0) delay += 24 * 60 * 60 * 1000;
      const timer = setTimeout(() => {
        void look({ limit }).catch((error) => log('social: scheduled run failed', error));
        arm(target);
      }, delay);
      if (typeof timer.unref === 'function') timer.unref();
      timers.push(timer);
    };
    for (const time of config.schedule.times ?? []) {
      const minutes = parseClock(time);
      if (minutes === null) {
        log(`social: ignoring malformed schedule time "${time}"`);
        continue;
      }
      arm(minutes);
    }
  }

  const commands = ctx.get('commands');
  if (commands !== undefined && typeof commands.register === 'function') {
    commands.register({
      name: 'social',
      description: 'Look around, or see what she has already seen: /social [status|look [n]|recent [n]|open <id>]',
      input: { hint: '[status|look [n]|recent [n]|open <id>]' },
      handler: (invocation) => runSocialCommand(service, store, invocation),
    });
  }
}

export { PLATFORM, browsePopular, lookUp, relatedVideos, scoreInterest, searchVideos, toView } from './bilibili.js';
export { createCooldown, DEFAULT_COOLDOWN_MS } from './cooldown.js';
export { createDailyBudget, parseClock } from './budget.js';
export { runSocialCommand } from './command.js';
export { createStore, DEFAULT_MAX_ROWS } from './store.js';