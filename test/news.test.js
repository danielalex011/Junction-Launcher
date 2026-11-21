'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeCtx } = require('./helpers');
const { writeJson } = require('../src/core/util');
const { News, normalizeNews, NEWS_TTL, RETRY_AFTER_FAIL } = require('../src/core/news');
const { msErrorMessage, isPublicClientError, PUBLIC_CLIENT_MESSAGE } = require('../src/core/auth/accounts');

const entry = (n, o = {}) => ({
  title: `Article ${n}`, tag: 'news', category: 'Minecraft: Java Edition', date: `2026-11-${String(10 + n).padStart(2, '0')}`, text: `Summary ${n}`,
  newsPageImage: { url: `/v2/images/a${n}.png` }, readMoreLink: `https://www.minecraft.net/article/a${n}`, newsType: ['News page'], id: `id${n}`, ...o,
});
const URL_ = 'https://launchercontent.mojang.com/v2/news.json';

async function setup(feedFn) {
  const calls = { n: 0 };
  const ctx = await makeCtx([['GET', URL_, () => { calls.n++; return feedFn(); }]]);
  return { ctx, news: new News(ctx), calls };
}

test('news feed: newest first, https links only, images resolved against Mojang, play-page-only promos dropped', () => {
  const items = normalizeNews({ entries: [
    entry(1), entry(3), entry(2),
    entry(4, { readMoreLink: 'javascript:alert(1)' }), entry(5, { readMoreLink: 'http://example.com/x' }), entry(6, { title: '' }),
    entry(7, { newsType: ['Play page'] }), entry(3), entry(8, { newsPageImage: { url: 'https://evil.example/x.png' }, playPageImage: undefined }),
  ] });
  assert.deepEqual(items.map((i) => i.title), ['Article 8', 'Article 3', 'Article 2', 'Article 1']);
  assert.equal(items[1].image, 'https://launchercontent.mojang.com/v2/images/a3.png');
  assert.equal(items[0].image, null, 'an image from another host is not used');
  assert.equal(items[1].url, 'https://www.minecraft.net/article/a3');
  assert.deepEqual(normalizeNews(null), []);
  assert.ok(normalizeNews({ entries: [entry(1, { text: 'x'.repeat(500) })] })[0].summary.length <= 220);
});

test('news is cached: a fresh cache makes no request, an old one is fetched again', async () => {
  const s = await setup(() => ({ json: { entries: [entry(1), entry(2)] } }));
  let st = await s.news.state();
  assert.equal(st.stale, true);
  assert.deepEqual(st.items, []);
  await s.news.refresh();
  assert.equal(s.calls.n, 1);
  st = await s.news.state();
  assert.equal(st.stale, false);
  assert.equal(st.items.length, 2);
  await s.news.refresh();
  assert.equal(s.calls.n, 1, 'fresh cache: nothing is fetched');
  assert.equal((await s.news.state(Date.now() + NEWS_TTL + 1000)).stale, true);
  await s.news.refresh({ force: true });
  assert.equal(s.calls.n, 2);
});

test('news: when the fetch fails the last news stays, and it does not retry at once', async () => {
  let fail = false;
  const s = await setup(() => (fail ? { status: 503, body: 'down' } : { json: { entries: [entry(1)] } }));
  await s.news.refresh();
  fail = true;
  await s.news.refresh({ force: true });
  assert.equal((await s.news.state()).items.length, 1, 'the old article is still there');

  // The cache is old, but a try failed a minute ago: wait before asking again.
  const c = await s.news.read();
  await writeJson(s.news.file, { ...c, checkedAt: Date.now() - NEWS_TTL - 1000, triedAt: Date.now() - 60 * 1000 });
  const n = s.calls.n;
  assert.equal((await s.news.state()).stale, false);
  await s.news.refresh();
  assert.equal(s.calls.n, n, 'no request right after a failure');
  await writeJson(s.news.file, { ...c, checkedAt: Date.now() - NEWS_TTL - 1000, triedAt: Date.now() - RETRY_AFTER_FAIL - 1000 });
  assert.equal((await s.news.state()).stale, true);
  fail = false;
  await s.news.refresh();
  assert.equal(s.calls.n, n + 1);
});

test('news: an empty or broken answer keeps the old news; turning news off hides it and stops fetching', async () => {
  let body = { entries: [entry(1)] };
  const s = await setup(() => ({ json: body }));
  await s.news.refresh();
  body = { entries: [] };
  await s.news.refresh({ force: true });
  assert.equal((await s.news.state()).items.length, 1);
  await s.ctx.settings.update({ showNews: false });
  const n = s.calls.n;
  await s.news.refresh({ force: true });
  assert.equal(s.calls.n, n, 'no request while news is off');
  const st = await s.news.state();
  assert.equal(st.enabled, false);
  assert.deepEqual(st.items, []);
});

test('Microsoft sign-in: AADSTS70002 / AADSTS7000218 become one plain sentence, not the raw JSON', () => {
  const raw = { error: 'invalid_client', error_description: 'AADSTS7000218: The request body must contain the following parameter: \'client_assertion\' or \'client_secret\'.\r\nTrace ID: 1\r\n', error_codes: [7000218] };
  assert.equal(isPublicClientError(raw), true);
  assert.equal(msErrorMessage(raw, 'x'), PUBLIC_CLIENT_MESSAGE);
  assert.equal(msErrorMessage(JSON.stringify({ error_description: 'AADSTS70002: The client must be public' }), 'x'), PUBLIC_CLIENT_MESSAGE);
  assert.match(PUBLIC_CLIENT_MESSAGE, /turn on Allow public client flows\.$/);
  assert.equal(msErrorMessage({ error: 'invalid_grant', error_description: 'Something else.\r\nTrace ID: 2' }, 'x'), 'Something else.');
  assert.equal(msErrorMessage({}, 'Token request failed (400)'), 'Token request failed (400)');
  assert.equal(isPublicClientError({ error_description: 'AADSTS700021: other' }), false);
});
