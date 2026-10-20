/**
 * The brake for a window that can be closed by the platform.
 *
 * Bilibili's search endpoint does not rate-limit politely. It answers `HTTP 412
 * request was banned` after a small number of requests in a short window, and the
 * ban is not per-request: once triggered, the next several calls fail even if they
 * are spaced out. Measured on this machine on 2026-10-20: three searches 1.5 s
 * apart succeeded on one run and all failed on the next run minutes later, which
 * is the signature of a shared counter rather than a per-keyword rule.
 *
 * The response to that is not "retry harder". It is:
 *
 *   - space searches further apart than ordinary reads (`searchGapMs`);
 *   - stop searching for a while after a 412 (`cooldownMs`), because continuing is
 *     what turns a short ban into a long one;
 *   - rotate keywords, so one run asks one question rather than five.
 *
 * A cooldown that lives only in a closure dies with the process and would let a
 * restart walk straight back into the ban, so it is persisted next to the views.
 *
 * @module dsh-social/cooldown
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How long the window stays shut after the platform says 412, by default. */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Create a persisted cooldown.
 *
 * @param {object} options - options.
 * @param {string} options.path - where to remember the deadline.
 * @param {number} [options.cooldownMs] - how long a ban lasts.
 * @param {() => number} [options.now] - clock, for tests.
 * @param {(message: string, detail?: unknown) => void} [options.log] - diagnostic sink.
 * @returns {{until: () => number, active: () => boolean, trip: (reason: string) => number, clear: () => void}} the brake.
 */
export function createCooldown(options) {
  const path = String(options.path ?? '');
  const cooldownMs = Math.max(0, Number(options.cooldownMs) || DEFAULT_COOLDOWN_MS);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  let until = 0;
  if (path !== '') {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Number(parsed?.until) > 0 && Number(parsed.until) > now()) until = Number(parsed.until);
    } catch {
      // Missing or unreadable is a cold start: being optimistic is the right
      // default, because the alternative is never searching again after a typo.
    }
  }

  const persist = () => {
    if (path === '') return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ version: 1, until })}\n`, 'utf8');
    } catch (error) {
      log(`social: could not write the cooldown file ${path}`, error);
    }
  };

  return {
    /** When the window reopens, or 0 when it is open. */
    until() {
      return until;
    },

    /** Whether the window is shut right now. */
    active() {
      return until > 0 && now() < until;
    },

    /**
     * Shut the window for `cooldownMs`.
     *
     * @param {string} reason - what tripped it, for the report.
     * @returns {number} the deadline.
     */
    trip(reason) {
      until = now() + cooldownMs;
      log(`social: search paused until ${new Date(until).toISOString()} (${reason})`);
      persist();
      return until;
    },

    /** Reopen immediately; used by a human command and by tests. */
    clear() {
      until = 0;
      persist();
    },
  };
}