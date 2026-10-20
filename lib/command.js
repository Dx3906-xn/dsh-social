/**
 * The `/social` command.
 *
 * Kept out of `index.js` so the command surface can be tested without mounting
 * the plugin or resolving its peer dependencies. Everything here takes the
 * service as an argument and returns a command result; there is no ambient state.
 *
 * Reading is a human command and not a tool on purpose. A tool would put "look at
 * the internet" inside a turn that strangers can write to, and the window is the
 * one place where an injected sentence could choose what she reads next.
 *
 * @module dsh-social/command
 */

import { PLATFORM, lookUp } from './bilibili.js';

/**
 * Run one `/social` invocation.
 *
 * @param {import('./types.js').SocialService} service - the read-only service.
 * @param {{file: string}} store - the store, for the path in `status`.
 * @param {{rawInput?: string}} invocation - the command invocation.
 * @returns {Promise<import('@deepseek-ai/dsh-commands').CommandResult>} the result.
 */
export async function runSocialCommand(service, store, invocation) {
  const raw = String(invocation.rawInput ?? '').trim();
  const [verb = 'status', ...rest] = raw === '' ? [] : raw.split(/\s+/);

  if (verb === 'status') {
    const state = service.status();
    const tally = Object.entries(state.byPlatform)
      .map(([key, value]) => `${key} ${value}`)
      .join('，');
    const lines = [
      `窗口：${PLATFORM}`,
      `已见：${state.total} 条${tally === '' ? '' : `（${tally}）`}`,
      `文件：${store.file}`,
    ];
    if (Array.isArray(state.keywords) && state.keywords.length > 0) {
      lines.push(
        state.searchReady === true
          ? `关键词：${state.keywords.join('、')}（已登录，会搜）`
          : `关键词：${state.keywords.join('、')}（没有登录态，只在热门流里碰运气）`
      );
    }
    if (state.lastRun === null) {
      lines.push('最近一次：还没看过');
    } else {
      const run = state.lastRun;
      lines.push(`最近一次：取回 ${run.fetched}，新 ${run.added}，重复 ${run.skipped}`);
      for (const error of run.errors) lines.push(`  · ${error}`);
    }
    return { kind: 'success', text: lines.join('\n') };
  }

  if (verb === 'look') {
    const limit = Number(rest[0]);
    const run = await service.look({ limit: Number.isFinite(limit) && limit > 0 ? limit : 20 });
    const lines = [`取回 ${run.fetched}，新 ${run.added}，重复 ${run.skipped}`];
    for (const error of run.errors) lines.push(`· ${error}`);
    return { kind: run.errors.length === 0 ? 'success' : 'error', text: lines.join('\n') };
  }

  if (verb === 'recent') {
    const limit = Number(rest[0]);
    const rows = service.recent({ limit: Number.isFinite(limit) && limit > 0 ? limit : 10 });
    if (rows.length === 0) return { kind: 'success', text: '还没看过什么。' };
    return {
      kind: 'success',
      text: rows
        .map((row) => `· [${Number(row.interest ?? 0).toFixed(2)}] ${row.title} — ${row.author}\n  ${row.url}`)
        .join('\n'),
    };
  }

  if (verb === 'open') {
    const id = String(rest[0] ?? '').trim();
    if (id === '') return { kind: 'error', text: '用法：/social open <bvid>' };
    const known = service.get(id.startsWith(`${PLATFORM}:`) ? id : `${PLATFORM}:${id}`);
    if (known !== undefined) {
      return { kind: 'success', text: `${known.title} — ${known.author}\n${known.url}` };
    }
    const found = await lookUp(id, {});
    if (found.view === undefined) return { kind: 'error', text: found.error ?? '没找到那个视频。' };
    return { kind: 'success', text: `${found.view.title} — ${found.view.author}\n${found.view.url}` };
  }

  return { kind: 'error', text: '用法：/social [status|look [n]|recent [n]|open <id>]' };
}