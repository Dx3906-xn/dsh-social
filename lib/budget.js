/**
 * The two pieces that stop a window from becoming a crawl.
 *
 * Both are pure functions so they can be tested without a clock, a network or a
 * plugin host. A budget that only exists inside the plugin is a budget nobody
 * can prove is working.
 *
 * @module dsh-social/budget
 */

/**
 * A per-local-day counter.
 *
 * `spend` returns how many of the requested rows it actually allowed, which is
 * what lets a caller say "the budget ran out mid-run" instead of silently
 * recording nine of ten items.
 *
 * @param {number} limit - maximum per day; 0 means nothing is allowed.
 * @returns {{spend: (n: number) => number, remaining: () => number, reset: () => void}} the budget.
 */
export function createDailyBudget(limit) {
  const cap = Math.max(0, Number(limit) || 0);
  let day = '';
  let used = 0;
  const today = () => new Date().toDateString();
  const roll = () => {
    const now = today();
    if (now !== day) {
      day = now;
      used = 0;
    }
  };
  return {
    spend(n) {
      roll();
      const want = Math.max(0, Number(n) || 0);
      const allowed = Math.min(want, Math.max(0, cap - used));
      used += allowed;
      return allowed;
    },
    remaining() {
      roll();
      return Math.max(0, cap - used);
    },
    reset() {
      day = today();
      used = 0;
    },
  };
}

/**
 * Parse `HH:mm` into minutes since midnight.
 *
 * Deliberately strict: `8.30`, `24:00` and `08:60` are all refused. A schedule
 * that quietly interprets a malformed time as midnight would look like it works
 * and then look around at the wrong hour for months.
 *
 * @param {string} value - a clock time.
 * @returns {number|null} minutes since midnight, or null when malformed.
 */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}