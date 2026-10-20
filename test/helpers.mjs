// Shared scaffolding for the assertion suites.
//
// Not a test framework. Every suite is a plain program that prints each check as
// it happens and sets a non-zero exit code at the end, because a suite whose
// output you cannot read is a suite whose failures you learn about from a green
// checkmark somewhere else.

/**
 * Create a check counter.
 *
 * @param {string} [title] - printed once at the start.
 * @returns {{check: (ok: boolean, label: string) => void, done: () => number, failures: number}} the counter.
 */
export function suite(title) {
  if (title !== undefined) console.log(title);
  let checks = 0;
  let failures = 0;
  return {
    check(ok, label) {
      checks += 1;
      if (!ok) failures += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
    },
    /** Print the tally and set the exit code. @returns {number} how many checks failed. */
    done() {
      console.log(`\n${checks - failures}/${checks} checks passed`);
      if (failures > 0) process.exitCode = 1;
      return failures;
    },
    get failures() {
      return failures;
    },
  };
}

/**
 * A `fetch` stand-in that answers from a table keyed by URL substring.
 *
 * The keys are matched in insertion order and the first hit wins, which makes a
 * test read as "this URL answers this body" rather than "the third call".
 *
 * @param {Record<string, {status?: number, body: any}|((url: string) => {status?: number, body: any})>} table - answers.
 * @returns {{fetch: typeof fetch, calls: string[], headers: Record<string, any>[]}} the stand-in and what it was asked for.
 */
export function fakeFetch(table) {
  const calls = [];
  const headers = [];
  const entries = Object.entries(table);
  const fetchImpl = async (url, init) => {
    const text = String(url);
    calls.push(text);
    headers.push(init?.headers ?? {});
    for (const [needle, answer] of entries) {
      if (!text.includes(needle)) continue;
      const resolved = typeof answer === 'function' ? answer(text) : answer;
      const status = resolved.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return resolved.body;
        },
        async text() {
          return JSON.stringify(resolved.body);
        },
      };
    }
    return {
      ok: false,
      status: 404,
      async json() {
        return {};
      },
      async text() {
        return 'not found';
      },
    };
  };
  return { fetch: /** @type {typeof fetch} */ (fetchImpl), calls, headers };
}

/**
 * One item shaped like a `popular` feed row.
 *
 * @param {object} [over] - fields to override.
 * @returns {any} the row.
 */
export function popularItem(over = {}) {
  return {
    bvid: 'BV1pGnn67EbB',
    title: '带着100万，我们见了成人网红...',
    desc: '一段简介',
    pic: 'https://i0.hdslb.com/bfs/archive/x.jpg',
    tname: '数码',
    owner: { name: '影视飓风' },
    duration: 2682,
    pubdate: 1792400400,
    stat: { view: 1222805, like: 108094 },
    ...over,
  };
}