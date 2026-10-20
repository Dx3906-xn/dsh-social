/**
 * What a social view is, once the platform's JSON is gone.
 *
 * The plugin has exactly one job for the agent: turn "what is out there" into
 * something it can talk about, and remember which of those things it actually
 * looked at. Everything below is shaped by two constraints:
 *
 *   - A view must survive a restart. The memory of "I saw this yesterday" is the
 *     whole point; an in-memory list would make every morning the first morning.
 *   - A view must be bounded. A title, an author, a short description and a few
 *     counters. Not the transcript, not the comments, not the video. A window is
 *     a window, not a copy of the street.
 *
 * @module dsh-social/types
 */

/**
 * One thing she looked at.
 *
 * `id` is stable across runs (`bilibili:视频id`) and is the dedupe key; `nativeId`
 * is what the platform calls it. Both are here because the platform id is what a
 * human would paste, and the composed id is what a file can key on without
 * knowing which platform a row came from.
 *
 * @typedef {object} SocialView
 * @property {string} id - stable `<platform>:<nativeId>`.
 * @property {'bilibili'} platform - which window this came through.
 * @property {string} nativeId - the platform's own id (a bvid for bilibili).
 * @property {string} url - canonical page URL a person could open.
 * @property {string} title - as published, trimmed.
 * @property {string} author - the account that published it.
 * @property {string} [description] - the publisher's own summary, truncated.
 * @property {string} [cover] - cover image URL.
 * @property {string[]} tags - category and any explicit tags.
 * @property {number} [duration] - seconds, when the platform reports it.
 * @property {number} [views] - play count, when reported.
 * @property {number} [likes] - like count, when reported.
 * @property {number} [publishedAt] - epoch milliseconds, when reported.
 * @property {number} seenAt - epoch milliseconds this plugin recorded it.
 * @property {number} interest - 0..1, how much it matched her declared interests.
 */

/**
 * What one browsing run did.
 *
 * `errors` is not decoration: a run that returned nothing because the platform
 * rate-limited it looks identical to a run that returned nothing because there
 * was nothing new, and the caller needs to tell those apart.
 *
 * @typedef {object} SocialRun
 * @property {string} platform - which window ran.
 * @property {number} at - epoch milliseconds the run started.
 * @property {number} fetched - rows the platform returned.
 * @property {number} added - rows that were not already known.
 * @property {number} skipped - rows already known.
 * @property {string[]} errors - one line per failure, human readable.
 */

/**
 * The read-only service `ctx.social` exposes to other plugins.
 *
 * Deliberately no `post`, no `comment`, no `like`, no `follow`. Those are not
 * omitted for lack of time: an agent that reads untrusted text must not hold a
 * handle that can speak as her on a platform where the punishment for automated
 * speech is a banned account.
 *
 * @typedef {object} SocialService
 * @property {(options?: {limit?: number, platform?: string}) => Promise<SocialRun>} look - browse once.
 * @property {(options?: {limit?: number, platform?: string, minInterest?: number}) => SocialView[]} recent - most recently seen first.
 * @property {(id: string) => SocialView|undefined} get - one view by its stable id.
 * @property {() => {total: number, byPlatform: Record<string, number>, lastRun: SocialRun|null}} status - counts for a diagnostic surface.
 */

export {};