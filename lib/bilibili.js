/**
 * The Bilibili window.
 *
 * One decision runs through this file: **do not sign, do not log in, do not
 * pretend.** Bilibili's public JSON endpoints answer ordinary read traffic
 * without a cookie, and the ones that do not (`ranking` needs a `wbi` signature,
 * `search` answers `-412 request was banned` to a datacenter IP) are left alone
 * rather than reverse-engineered. The cost is a smaller window — popular videos
 * only — and the benefit is a plugin that keeps working next month without a
 * signature server, a login cookie, or an arms race.
 *
 * The endpoints used here and what each needs:
 *
 *   - `x/web-interface/popular`            no auth, 20 items, the home feed
 *   - `x/web-interface/view?bvid=…`        no auth, one video's full metadata
 *
 * Both were verified against a clean IP on 2026-10-20. `ranking/v2` returned
 * `-352` and `search/type` returned `-412`, which is why neither is implemented:
 * a window that throws every morning is worse than a smaller one that does not.
 *
 * @module dsh-social/bilibili
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Headers Bilibili checks on anonymous JSON reads. */
const BASE_HEADERS = Object.freeze({
  'User-Agent': USER_AGENT,
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json',
});

/** Stable platform tag; every id this module mints starts with it. */
export const PLATFORM = 'bilibili';

/** Default wait between two requests, in milliseconds. */
export const DEFAULT_GAP_MS = 1500;

/** What an unanswered request is allowed to take. */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * Bilibili's own error codes, translated into something a report can carry.
 *
 * The distinction matters because the responses look identical to a caller that
 * only checks for a non-empty list: `-352` and `-412` both arrive as HTTP 200
 * with `code != 0`, and a plugin that swallowed them would report "nothing new
 * today" every day.
 */
const CODE_MESSAGES = Object.freeze({
  0: 'OK',
  '-101': 'not logged in (this endpoint was expected to work anonymously)',
  '-352': 'wbi signature required; this endpoint is not implemented on purpose',
  '-400': 'bad request',
  '-404': 'not found',
  '-412': 'request was rate-limited or banned by the platform',
  '-509': 'rate limited by the platform',
});

/**
 * Ask one endpoint for JSON, with a timeout and a settled error shape.
 *
 * `cookie` is optional and is the **only** thing that changes what a request is
 * allowed to see. It is never sent to a host other than Bilibili, never logged,
 * and never written into a stored row: a view records what was seen, not who was
 * signed in when it was seen.
 *
 * @param {string} url - absolute URL.
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, cookie?: string}} [options] - test seams and the optional session.
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: string, code?: number}>} the outcome.
 */
async function getJson(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const cookie = typeof options.cookie === 'string' ? options.cookie.trim() : '';
  const headers = cookie === '' ? BASE_HEADERS : { ...BASE_HEADERS, Cookie: cookie };
  let response;
  // A controller and an explicit `clearTimeout` rather than `AbortSignal.timeout`:
  // the latter leaves a timer alive until GC, and a CLI that does one request and
  // exits was observed aborting during teardown on Windows. Clearing the timer in
  // `finally` is the difference between a clean exit and a libuv assertion.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    response = await fetchImpl(url, {
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    return { ok: false, error: `network: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}`, code: response.status };
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const code = Number(body?.code);
  if (code !== 0) {
    const known = CODE_MESSAGES[String(code)];
    return {
      ok: false,
      error: known === undefined ? `upstream code ${code}: ${String(body?.message ?? '')}` : known,
      code,
    };
  }
  return { ok: true, data: body.data };
}

/**
 * Trim one line of text and cap its length.
 *
 * Titles carry newlines and zero-width joiners; a view is not a transcript, so
 * this is the only normalisation a view gets.
 *
 * @param {unknown} value - raw field.
 * @param {number} max - maximum characters kept.
 * @returns {string} the trimmed string, or ''.
 */
function clip(value, max) {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Epoch seconds to epoch milliseconds, tolerating both.
 *
 * @param {unknown} value - a platform timestamp.
 * @returns {number|undefined} milliseconds, or undefined when absent/invalid.
 */
function millis(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * Normalise one item from the popular feed into a view.
 *
 * Every field is optional in the wire format; a row missing its id or title is
 * dropped by the caller rather than stored half-empty, because a nameless view
 * cannot be talked about and cannot be deduped.
 *
 * @param {any} item - one `data.list[]` entry.
 * @param {number} now - epoch milliseconds to stamp `seenAt` with.
 * @returns {import('./types.js').SocialView|null} the view, or null when unusable.
 */
export function toView(item, now) {
  if (item === null || typeof item !== 'object') return null;
  const bvid = typeof item.bvid === 'string' ? item.bvid.trim() : '';
  const title = clip(item.title, 200);
  if (bvid === '' || title === '') return null;
  const duration = Number(item.duration);
  const stat = item.stat ?? {};
  return {
    id: `${PLATFORM}:${bvid}`,
    platform: PLATFORM,
    nativeId: bvid,
    url: `https://www.bilibili.com/video/${bvid}`,
    title,
    author: clip(item.owner?.name ?? item.author ?? '', 80),
    ...(clip(item.desc, 400) === '' ? {} : { description: clip(item.desc, 400) }),
    ...(typeof item.pic === 'string' && item.pic !== '' ? { cover: item.pic } : {}),
    tags: [
      ...(clip(item.tname, 40) === '' ? [] : [clip(item.tname, 40)]),
      ...(Array.isArray(item.tags) ? item.tags.map((tag) => clip(tag, 40)).filter((tag) => tag !== '').slice(0, 8) : []),
    ],
    ...(Number.isFinite(duration) && duration > 0 ? { duration: Math.round(duration) } : {}),
    ...(Number(stat.view) > 0 ? { views: Math.round(Number(stat.view)) } : {}),
    ...(Number(stat.like) > 0 ? { likes: Math.round(Number(stat.like)) } : {}),
    ...(millis(item.pubdate) === undefined ? {} : { publishedAt: millis(item.pubdate) }),
    seenAt: now,
    interest: 0,
  };
}

/**
 * Score one view against the interests she has been given.
 *
 * This is deliberately arithmetic and not a model call: it runs on every row of
 * every run, and paying a model to say "you might like cats" is the kind of
 * thing a companion should do by remembering that she likes cats.
 *
 * The scale is 0..1 and the components are additive and capped, so a view that
 * matches nothing is exactly 0 rather than a small mystery number.
 *
 * @param {import('./types.js').SocialView} view - the row to score.
 * @param {readonly string[]} interests - lowercase keywords she cares about.
 * @param {{hotViews?: number}} [options] - the play-count that counts as "popular".
 * @returns {number} 0..1.
 */
export function scoreInterest(view, interests, options = {}) {
  const haystack = `${view.title} ${view.description ?? ''} ${view.tags.join(' ')} ${view.author}`.toLowerCase();
  let score = 0;
  let hits = 0;
  for (const interest of interests) {
    const needle = String(interest).trim().toLowerCase();
    if (needle === '') continue;
    if (haystack.includes(needle)) {
      hits += 1;
      if (hits >= 3) break;
    }
  }
  // Three matches is as much as a title can meaningfully say.
  score += Math.min(hits, 3) * 0.25;
  // Popularity is weak evidence of interest, and it is the component most
  // likely to reward the same viral video every day. Capped at 0.15 on purpose.
  const hot = Number(options.hotViews ?? 1_000_000);
  if (hot > 0 && Number(view.views) > 0) {
    score += Math.min(Number(view.views) / hot, 1) * 0.15;
  }
  return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/**
 * Wait between requests.
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
 * Browse the home feed once.
 *
 * `fill` controls the second request per row: the popular feed returns a short
 * `desc` and sometimes an empty category, so one `view` call per row fills in the
 * description and the real category. It is off by default because twenty extra
 * requests an hour is exactly the traffic pattern that gets an IP rate-limited,
 * and the feed alone is already enough to talk about.
 *
 * @param {object} [options] - run options.
 * @param {number} [options.limit] - maximum rows to return (1..50).
 * @param {number} [options.gapMs] - wait between two requests.
 * @param {boolean} [options.fill] - enrich each row with its detail endpoint.
 * @param {readonly string[]} [options.interests] - keywords for scoring.
 * @param {typeof fetch} [options.fetchImpl] - test seam.
 * @param {number} [options.now] - epoch milliseconds, for deterministic tests.
 * @returns {Promise<{views: import('./types.js').SocialView[], errors: string[]}>} the window.
 */
export async function browsePopular(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
  const gapMs = Number.isFinite(Number(options.gapMs)) ? Math.max(0, Number(options.gapMs)) : DEFAULT_GAP_MS;
  const interests = Array.isArray(options.interests) ? options.interests : [];
  const now = Number(options.now) > 0 ? Number(options.now) : Date.now();
  const errors = [];

  const listing = await getJson(
    `https://api.bilibili.com/x/web-interface/popular?ps=${limit}&pn=1`,
    { fetchImpl: options.fetchImpl }
  );
  if (listing.ok !== true) {
    return { views: [], errors: [`popular: ${listing.error}`] };
  }
  const list = Array.isArray(listing.data?.list) ? listing.data.list : [];
  const views = [];
  for (const item of list) {
    const view = toView(item, now);
    if (view !== null) views.push(view);
    if (views.length >= limit) break;
  }

  if (options.fill === true && views.length > 0) {
    for (const view of views) {
      await sleep(gapMs);
      const detail = await getJson(
        `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(view.nativeId)}`,
        { fetchImpl: options.fetchImpl }
      );
      if (detail.ok !== true) {
        errors.push(`view ${view.nativeId}: ${detail.error}`);
        continue;
      }
      const data = detail.data ?? {};
      if (clip(data.desc, 400) !== '') view.description = clip(data.desc, 400);
      if (clip(data.tname, 40) !== '' && view.tags.length === 0) view.tags.push(clip(data.tname, 40));
      if (Number(data.duration) > 0) view.duration = Math.round(Number(data.duration));
      if (Number(data.stat?.view) > 0) view.views = Math.round(Number(data.stat.view));
      if (Number(data.stat?.like) > 0) view.likes = Math.round(Number(data.stat.like));
    }
  }

  for (const view of views) view.interest = scoreInterest(view, interests);
  return { views, errors };
}

/**
 * Strip the highlight markup a search result carries.
 *
 * Bilibili wraps the matched keyword in `<em class="keyword">…</em>`. A title with
 * markup in it is not a title: it would reach the agent as HTML it has no reason
 * to parse, and reach a report as noise.
 *
 * @param {unknown} value - a raw title.
 * @returns {string} the plain text.
 */
function plainTitle(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, '');
}

/**
 * Parse a search result's `duration` ("12:34", "1:02:03") into seconds.
 *
 * @param {unknown} value - the raw field, which may already be a number.
 * @returns {number|undefined} seconds, or undefined.
 */
function parseDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value !== 'string') return undefined;
  const parts = value.split(':').map((part) => Number(part));
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return undefined;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? Math.round(seconds) : undefined;
}

/**
 * Search one keyword and normalise the results.
 *
 * This is the one endpoint that needs a session cookie: without one Bilibili
 * answers `HTTP 412 request was banned` to a datacenter IP, which is why the
 * probe in `test/live-bilibili.mjs` reports it as refused rather than empty. With
 * a cookie it works, and it is the only way to browse **by topic** instead of by
 * whatever the home feed happens to be pushing today.
 *
 * @param {object} options - search options.
 * @param {string} options.keyword - what to search for.
 * @param {string} [options.cookie] - a `SESSDATA=…` value from a signed-in session.
 * @param {number} [options.limit] - rows to keep (1..50).
 * @param {readonly string[]} [options.interests] - scoring keywords.
 * @param {typeof fetch} [options.fetchImpl] - test seam.
 * @param {number} [options.now] - epoch milliseconds, for deterministic tests.
 * @returns {Promise<{views: import('./types.js').SocialView[], errors: string[]}>} the window.
 */
export async function searchVideos(options = {}) {
  const keyword = typeof options.keyword === 'string' ? options.keyword.trim() : '';
  const now = Number(options.now) > 0 ? Number(options.now) : Date.now();
  const interests = Array.isArray(options.interests) ? options.interests : [];
  if (keyword === '') return { views: [], errors: ['search: empty keyword'] };

  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=1`;
  const listing = await getJson(url, { fetchImpl: options.fetchImpl, cookie: options.cookie });
  if (listing.ok !== true) {
    return { views: [], errors: [`search "${keyword}": ${listing.error}`] };
  }

  const raw = Array.isArray(listing.data?.result) ? listing.data.result : [];
  const views = [];
  for (const item of raw) {
    const bvid = typeof item?.bvid === 'string' ? item.bvid.trim() : '';
    const title = clip(plainTitle(item?.title), 200);
    if (bvid === '' || title === '') continue;
    const duration = parseDuration(item.duration);
    const view = {
      id: `${PLATFORM}:${bvid}`,
      platform: PLATFORM,
      nativeId: bvid,
      url: `https://www.bilibili.com/video/${bvid}`,
      title,
      author: clip(item.author, 80),
      ...(clip(item.description, 400) === '' ? {} : { description: clip(item.description, 400) }),
      ...(typeof item.pic === 'string' && item.pic !== ''
        ? { cover: item.pic.startsWith('//') ? `https:${item.pic}` : item.pic }
        : {}),
      tags: clip(item.typename, 40) === '' ? [] : [clip(item.typename, 40)],
      ...(duration === undefined ? {} : { duration }),
      ...(Number(item.play) > 0 ? { views: Math.round(Number(item.play)) } : {}),
      ...(millis(item.pubdate) === undefined ? {} : { publishedAt: millis(item.pubdate) }),
      seenAt: now,
      interest: 0,
    };
    view.interest = scoreInterest(view, interests);
    views.push(view);
    if (views.length >= limit) break;
  }
  return { views, errors: [] };
}

/**
 * Fetch the videos related to one seed.
 *
 * This is the answer to a search endpoint that closes: `related` is served
 * anonymously, returns about forty rows, and its rows are the same topic as the
 * seed by construction. A handful of good seeds therefore beats a keyword search
 * for "keep finding more of this", and it costs no session and no ban risk.
 *
 * The endpoint is `/x/web-interface/archive/related`, verified on 2026-10-20 to
 * return `code: 0` with 40 items and no cookie.
 *
 * @param {object} options - options.
 * @param {string} options.bvid - the seed video.
 * @param {number} [options.limit] - rows to keep (1..40).
 * @param {readonly string[]} [options.interests] - scoring keywords.
 * @param {typeof fetch} [options.fetchImpl] - test seam.
 * @param {number} [options.now] - epoch milliseconds, for deterministic tests.
 * @returns {Promise<{views: import('./types.js').SocialView[], errors: string[]}>} the neighbours.
 */
export async function relatedVideos(options = {}) {
  const bvid = typeof options.bvid === 'string' ? options.bvid.trim() : '';
  if (bvid === '') return { views: [], errors: ['related: empty seed'] };
  const now = Number(options.now) > 0 ? Number(options.now) : Date.now();
  const interests = Array.isArray(options.interests) ? options.interests : [];
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 40);

  const found = await getJson(
    `https://api.bilibili.com/x/web-interface/archive/related?bvid=${encodeURIComponent(bvid)}`,
    { fetchImpl: options.fetchImpl }
  );
  if (found.ok !== true) return { views: [], errors: [`related ${bvid}: ${found.error}`] };

  const list = Array.isArray(found.data) ? found.data : [];
  const views = [];
  for (const item of list) {
    // `related` rows carry `owner.name`, `desc` and `stat` in the same shape the
    // feed does, so the one normaliser serves both and a field added to one
    // endpoint reaches both.
    const view = toView(item, now);
    if (view === null) continue;
    view.interest = scoreInterest(view, interests);
    views.push(view);
    if (views.length >= limit) break;
  }
  return { views, errors: [] };
}

/**
 * Fetch one video's metadata by bvid.
 *
 * Exposed because a link a person pasted is the most natural thing she could be
 * asked to look at, and it needs no feed at all.
 *
 * @param {string} bvid - the platform id, e.g. `BV1pGnn67EbB`.
 * @param {{fetchImpl?: typeof fetch, interests?: readonly string[], now?: number}} [options] - seams.
 * @returns {Promise<{view?: import('./types.js').SocialView, error?: string}>} the view or a reason.
 */
export async function lookUp(bvid, options = {}) {
  const id = typeof bvid === 'string' ? bvid.trim() : '';
  if (id === '') return { error: 'empty id' };
  const detail = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(id)}`, {
    fetchImpl: options.fetchImpl,
  });
  if (detail.ok !== true) return { error: detail.error };
  const data = detail.data ?? {};
  const view = toView(
    {
      bvid: id,
      title: data.title,
      desc: data.desc,
      pic: data.pic,
      tname: data.tname,
      owner: data.owner,
      duration: data.duration,
      pubdate: data.pubdate,
      stat: data.stat,
    },
    Number(options.now) > 0 ? Number(options.now) : Date.now()
  );
  if (view === null) return { error: 'the platform returned no title for that id' };
  view.interest = scoreInterest(view, Array.isArray(options.interests) ? options.interests : []);
  return { view };
}

export { clip, getJson, millis, sleep };