// What the window returns, and what it refuses to return.
//
// The interesting properties are all about degradation: a rate-limited platform,
// an unreachable one, a row with no title. Each of those must produce a report
// the caller can tell apart from "nothing new today", because that is the
// failure mode that makes a plugin look like it is working for months.
import { suite } from './helpers.mjs';
import { fakeFetch, popularItem } from './helpers.mjs';
import { browsePopular, lookUp, scoreInterest, searchVideos, toView } from '../lib/bilibili.js';

const t = suite('bilibili');

// --- normalisation -----------------------------------------------------------
{
  const view = toView(popularItem(), 1_792_400_500_000);
  t.check(view !== null, 'a well-formed row produces a view');
  t.check(view.id === 'bilibili:BV1pGnn67EbB', `the id is platform-prefixed (got ${view.id})`);
  t.check(view.url === 'https://www.bilibili.com/video/BV1pGnn67EbB', 'the url is the canonical page');
  t.check(view.author === '影视飓风', 'the author is carried');
  t.check(view.duration === 2682, 'the duration is carried in seconds');
  t.check(view.views === 1222805, 'the play count is carried');
  t.check(view.likes === 108094, 'the like count is carried');
  t.check(view.publishedAt === 1_792_400_400_000, 'seconds became milliseconds');
  t.check(view.seenAt === 1_792_400_500_000, 'seenAt is the caller clock');
  t.check(view.tags.includes('数码'), 'the category is a tag');
  t.check(view.interest === 0, 'interest starts at zero until scored');
}

{
  // A row missing its id cannot be deduped; a row missing its title cannot be
  // talked about. Both are dropped rather than stored half-empty.
  t.check(toView(popularItem({ bvid: '' }), 0) === null, 'a row without an id is dropped');
  t.check(toView(popularItem({ title: '' }), 0) === null, 'a row without a title is dropped');
  t.check(toView(null, 0) === null, 'a non-object is dropped');
}

{
  const long = '一'.repeat(500);
  const view = toView(popularItem({ title: long }), 0);
  t.check(view.title.length === 200, `a long title is clipped to 200 (got ${view.title.length})`);
  t.check(view.title.endsWith('…'), 'and says so with an ellipsis');
}

{
  // Newlines inside a title would break a one-line report; the view flattens them.
  const view = toView(popularItem({ title: '第一行\n第二行\t第三行' }), 0);
  t.check(view.title === '第一行 第二行 第三行', `whitespace collapses (got ${JSON.stringify(view.title)})`);
}

// --- interest scoring --------------------------------------------------------
{
  const view = toView(popularItem({ title: '猫猫日常', tname: '动物' }), 0);
  const floor = scoreInterest(view, []);
  t.check(floor <= 0.15, `with no interests only popularity counts, and it is capped (got ${floor})`);
  t.check(scoreInterest(view, ['猫']) > floor, 'a matching keyword scores above that floor');
  t.check(scoreInterest(view, ['编程']) === floor, 'an unrelated keyword adds nothing');

  const three = scoreInterest(view, ['猫', '日常', '动物']);
  const one = scoreInterest(view, ['猫']);
  t.check(three > one, 'three matches beat one');
  t.check(three <= 1, 'the score never exceeds 1');

  // Popularity is a weak signal and it is capped, so the same viral video cannot
  // dominate every morning just by being viral.
  const viral = toView(popularItem({ stat: { view: 99_000_000, like: 1 } }), 0);
  const withHot = scoreInterest(viral, [], { hotViews: 1_000_000 });
  t.check(withHot <= 0.15, `popularity alone stays under 0.15 (got ${withHot})`);
}

// --- the feed ----------------------------------------------------------------
{
  const { fetch } = fakeFetch({
    'x/web-interface/popular': { body: { code: 0, data: { list: [popularItem(), popularItem({ bvid: 'BV2', title: '第二个' })] } } },
  });
  const run = await browsePopular({ fetchImpl: fetch, now: 1000, limit: 10 });
  t.check(run.errors.length === 0, 'a clean feed reports no errors');
  t.check(run.views.length === 2, `both rows came back (got ${run.views.length})`);
  t.check(run.views[1].id === 'bilibili:BV2', 'order is preserved');
}

{
  // -412 arrives as HTTP 200. A plugin that only checked the list would call this
  // "nothing new today"; the point of the error array is to say what happened.
  const { fetch } = fakeFetch({
    'x/web-interface/popular': { body: { code: -412, message: 'request was banned' } },
  });
  const run = await browsePopular({ fetchImpl: fetch, now: 1000 });
  t.check(run.views.length === 0, 'a rate-limited feed returns nothing');
  t.check(run.errors.length === 1, 'and says so once');
  t.check(/rate-limited|banned/.test(run.errors[0]), `the reason names the cause (got ${run.errors[0]})`);
}

{
  const { fetch } = fakeFetch({
    'x/web-interface/popular': { body: { code: -352, message: '-352' } },
  });
  const run = await browsePopular({ fetchImpl: fetch, now: 1000 });
  t.check(/signature/.test(run.errors[0] ?? ''), 'a signature demand is reported as such');
}

{
  // The transport failing is a different failure from the platform refusing, and
  // both have to be legible.
  const failing = /** @type {typeof fetch} */ (async () => {
    throw new Error('getaddrinfo ENOTFOUND');
  });
  const run = await browsePopular({ fetchImpl: failing, now: 1000 });
  t.check(run.errors.length === 1, 'a dead network reports one error');
  t.check(/network/.test(run.errors[0]), `and names the layer (got ${run.errors[0]})`);
}

{
  const { fetch } = fakeFetch({
    'x/web-interface/popular': { status: 503, body: {} },
  });
  const run = await browsePopular({ fetchImpl: fetch, now: 1000 });
  t.check(/HTTP 503/.test(run.errors[0] ?? ''), 'a server error keeps its status code');
}

{
  // `limit` is a request parameter, but a feed that ignores it must not flood the
  // store. The cap is applied on the way out too.
  const list = Array.from({ length: 30 }, (_, index) => popularItem({ bvid: `BV${index}` }));
  const { fetch } = fakeFetch({ 'x/web-interface/popular': { body: { code: 0, data: { list } } } });
  const run = await browsePopular({ fetchImpl: fetch, now: 1000, limit: 3 });
  t.check(run.views.length === 3, `the local cap holds even when the feed ignores it (got ${run.views.length})`);
}

// --- keyword search ----------------------------------------------------------
{
  // The search endpoint is the only one that needs a session. Everything about
  // this path is about that: the cookie goes out, the highlight markup comes off,
  // and a refusal is reported rather than rendered as "nothing found".
  const { fetch, headers } = fakeFetch({
    'search/type': {
      body: {
        code: 0,
        data: {
          result: [
            {
              bvid: 'BV1a',
              title: '【Day 0】我是<em class="keyword">DeepSeek</em>鲸鱼娘',
              author: '鲸鱼娘在运营',
              description: 'AI 生成',
              pic: '//i2.hdslb.com/x.jpg',
              duration: '1:23',
              play: 411127,
              pubdate: 1792398083,
              typename: '手机游戏',
            },
          ],
        },
      },
    },
  });

  const run = await searchVideos({ keyword: '大肥鱼', cookie: 'SESSDATA=abc', fetchImpl: fetch, now: 1000, interests: ['大肥鱼'] });
  t.check(run.errors.length === 0, 'a search with a session reports no errors');
  t.check(run.views.length === 1, 'one result comes back');
  t.check(run.views[0].title === '【Day 0】我是DeepSeek鲸鱼娘', `the highlight markup is gone (got ${run.views[0].title})`);
  t.check(run.views[0].duration === 83, `"1:23" became 83 seconds (got ${run.views[0].duration})`);
  t.check(run.views[0].cover === 'https://i2.hdslb.com/x.jpg', 'a protocol-relative cover gets https:');
  t.check(run.views[0].interest > 0, 'the row is scored like any other');
  t.check(String(headers[0].Cookie ?? '').includes('SESSDATA=abc'), 'the session cookie was sent');
}

{
  const { fetch } = fakeFetch({ 'search/type': { body: { code: 0, data: { result: [] } } } });
  await searchVideos({ keyword: 'x', fetchImpl: fetch });
  // Not asserted on the header directly; the next block does that with an
  // explicit comparison, because "no cookie" and "cookie" must not look alike.
  t.check(true, 'an anonymous search is allowed to be attempted');
}

{
  const { fetch, headers } = fakeFetch({ 'search/type': { body: { code: 0, data: { result: [] } } } });
  await searchVideos({ keyword: 'x', fetchImpl: fetch });
  t.check(headers[0].Cookie === undefined, 'without a session no Cookie header is sent');
}

{
  // 412 is what a datacenter IP gets. It must be a named failure, because it is
  // the difference between "the cookie is missing" and "there is nothing to see".
  const { fetch } = fakeFetch({ 'search/type': { status: 412, body: {} } });
  const run = await searchVideos({ keyword: '大肥鱼', cookie: 'SESSDATA=x', fetchImpl: fetch });
  t.check(run.views.length === 0, 'a refused search returns nothing');
  t.check(run.errors.length === 1, 'and says so once');
  t.check(/HTTP 412/.test(run.errors[0]), `with the status (got ${run.errors[0]})`);
  t.check(run.errors[0].includes('大肥鱼'), 'and names the keyword it failed on');
}

{
  const { fetch, calls } = fakeFetch({ 'search/type': { body: { code: 0, data: { result: [] } } } });
  const run = await searchVideos({ keyword: '   ', fetchImpl: fetch });
  t.check(run.errors[0] === 'search: empty keyword', 'an empty keyword is refused without a request');
  t.check(calls.length === 0, 'and nothing was sent');
}

// --- one video ---------------------------------------------------------------
{
  const { fetch } = fakeFetch({
    'x/web-interface/view': {
      body: {
        code: 0,
        data: { title: '一个视频', owner: { name: 'UP' }, desc: '简介', tname: '生活', duration: 60, pubdate: 1792400400, stat: { view: 10, like: 2 } },
      },
    },
  });
  const found = await lookUp('BV1', { fetchImpl: fetch, now: 1000 });
  t.check(found.view !== undefined, 'a known id comes back');
  t.check(found.view.nativeId === 'BV1', 'with the id that was asked for');
}

{
  const { fetch } = fakeFetch({});
  const found = await lookUp('', { fetchImpl: fetch });
  t.check(found.view === undefined && /empty/.test(found.error ?? ''), 'an empty id is refused locally');
}

{
  const { fetch } = fakeFetch({
    'x/web-interface/view': { body: { code: -404, message: '啥都木有' } },
  });
  const found = await lookUp('BVnope', { fetchImpl: fetch });
  t.check(found.view === undefined, 'a missing video yields no view');
  t.check(/not found/.test(found.error ?? ''), `and a readable reason (got ${found.error})`);
}

t.done();