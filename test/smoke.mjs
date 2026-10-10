// 가짜 DOM에서 content.js의 판정, 표시, 차단 대기열 검사. 실행은 node test/smoke.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, '..');
const ago = (days) => new Date(Date.now() - days * 864e5).toUTCString();
const user = (id, sn, o) => ({ id_str: id, screen_name: sn, name: sn, created_at: ago(o.age), description: o.bio || '', followers_count: o.fo, friends_count: o.fr, statuses_count: o.st, media_count: o.md || 0, is_blue_verified: o.blue !== false, following: !!o.following, followed_by: false, blocking: false, protected: false, verified_type: o.vt });

function run(config, store = { 'blue-sweep-v1': JSON.stringify(config) }) {
  const articles = [];
  const add = (tweet, promoted) => articles.push({ dataset: {}, '__reactFiber$t': { memoizedProps: {}, return: { memoizedProps: { tweet, promotedContent: promoted }, return: null } } });
  const mkEl = () => ({ children: [], listeners: {}, append(...c) { this.children.push(...c); }, addEventListener(type, fn) { this.listeners[type] = fn; }, replaceChildren(...c) { this.children = c; } });
  const intervals = [], timeouts = [], fetches = [];
  function XHR() {}
  XHR.prototype.setRequestHeader = function () {};
  const ctx = {
    console, Date, Math, JSON, Object, Number, RegExp, Map, Set, Promise, encodeURIComponent, decodeURIComponent,
    document: {
      body: mkEl(), head: mkEl(), cookie: 'ct0=csrf123; twid=u%3D999', createElement: mkEl, addEventListener() {},
      querySelectorAll: (sel) => (sel.includes('data-testid') ? articles : sel.includes('data-bb-id') ? articles.filter((a) => a.dataset.bbId) : articles.filter((a) => a.dataset.bb)),
    },
    localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
    XMLHttpRequest: XHR,
    fetch: async (url, init) => { fetches.push({ url, body: init.body, csrf: init.headers['x-csrf-token'], auth: init.headers.authorization }); return { status: 200 }; },
    MutationObserver: class { observe() {} },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    addEventListener() {},
    Element: class {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  // 화면에 뜬 트윗들
  add({ id_str: 't1', full_text: '오늘도 수익 인증합니다', user: user('1', 'slop_a', { age: 60, fo: 1200, fr: 1500, st: 9000, bio: '맞팔 100% 수익화 도전' }) });
  add({ id_str: 't2', full_text: '@slop_a 맞아요 ㅎㅎ', in_reply_to_user_id_str: '1', user: user('2', 'reply_b', { age: 400, fo: 900, fr: 1000, st: 4000, bio: '일상' }) });
  add({ id_str: 't3', full_text: '오늘 그림', user: user('3', 'art_c', { age: 300, fo: 5000, fr: 900, st: 3000, md: 2000, bio: 'illustrator' }) });
  add({ id_str: 't4', full_text: '수익 인증', user: user('4', 'followed_d', { age: 60, fo: 1200, fr: 1500, st: 9000, bio: '맞팔 수익화', following: true }) });
  add({ id_str: 't5', full_text: '수익 인증', user: user('5', 'ad_e', { age: 60, fo: 1200, fr: 1500, st: 9000, bio: '맞팔 수익화' }) }, { advertiser: true });
  add({ id_str: 't6', full_text: '수익 인증', user: user('6', 'plain_f', { age: 60, fo: 1200, fr: 1500, st: 9000, bio: '맞팔 수익화', blue: false }) });
  add({ id_str: 't7', full_text: '수익 인증', user: user('7', 'biz_g', { age: 60, fo: 1200, fr: 1500, st: 9000, bio: '맞팔 수익화', vt: 'Business' }) });
  add({ id_str: 't8', full_text: '오늘 점심', user: user('8', 'stats_h', { age: 60, fo: 1200, fr: 1500, st: 9000, bio: '일상' }) });

  for (const file of ['classifier.js', 'content.js']) vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), ctx, { filename: file });
  return { ctx, store, articles, intervals, timeouts, fetches, XHR };
}

const flush = () => new Promise((r) => setImmediate(r));
const states = (t) => t.articles.map((a) => a.dataset.bb || '-');

// 기본 자동 숨김 모드: 대상 두 개 숨김, 내용 신호 없는 stats_h는 표시만, 요청 없음
let t = run({});
new t.XHR().setRequestHeader('authorization', 'Bearer TEST');
for (const fn of t.intervals) await fn();
await flush();
assert.deepEqual(states(t), ['hide', 'hide', '-', '-', '-', '-', '-', 'mark']);
assert.match(t.articles[0].dataset.bbLabel, /^@slop_a \d+점/);
assert.match(t.articles[1].dataset.bbLabel, /품앗이답글/);
assert.equal(t.fetches.length, 0);

// 표시만 모드: 숨기지 않고 표시만
t = run({ mode: 'dry' });
for (const fn of t.intervals) await fn();
assert.deepEqual(states(t), ['mark', 'mark', '-', '-', '-', '-', '-', 'mark']);

// 자동 차단 모드: 숨김, 순차 차단 요청, 기록 저장. 내용 신호 없는 stats_h는 표시만
t = run({ mode: 'block', intervalSec: 0 });
new t.XHR().setRequestHeader('authorization', 'Bearer TEST');
for (let i = 0; i < 4; i++) { for (const fn of t.intervals) await fn(); await flush(); }
assert.deepEqual(states(t), ['hide', 'hide', '-', '-', '-', '-', '-', 'mark']);
assert.deepEqual(t.fetches.map((f) => f.body), ['user_id=1', 'user_id=2']);
assert.ok(t.fetches.every((f) => f.url === '/i/api/1.1/blocks/create.json' && f.csrf === 'csrf123'));
const saved = JSON.parse(t.store['blue-sweep-v1']);
assert.deepEqual(saved.log.map((item) => item.sn).sort(), ['reply_b', 'slop_a']);
assert.equal(saved.dayCount, 2);

// 새로고침 뒤에도 버튼과 패널에 저장된 차단 기록 표시
const texts = (node) => (typeof node === 'string' ? [node] : [node.textContent, ...(node.children || []).flatMap(texts)].filter(Boolean));
t = run(null, { 'blue-sweep-v1': t.store['blue-sweep-v1'] });
t.articles.length = 0;
for (const fn of t.intervals) await fn();
const root = t.ctx.document.body.children[0];
const pill = () => root.children.at(-1);
assert.match(pill().textContent, /^차단 2,/);
pill().listeners.click();
const panel = texts(root);
assert.ok(panel.some((s) => s.startsWith('@slop_a ')) && panel.some((s) => s.startsWith('@reply_b ')));
assert.equal(panel.filter((s) => s === '해제').length, 2);

console.log('ok');
