// X 페이지 MAIN world에서 실행. 트윗 작성자 정보는 React props에서 읽음
(() => {
  'use strict';
  if (window.__blueSweepLoaded) return;
  window.__blueSweepLoaded = true;

  const { classify } = window.__blueSweep;
  const KEY = 'blue-sweep-v1';
  const DEFAULTS = {
    mode: 'dry',          // 'dry' 표시만 | 'hide' 숨김 | 'block' 숨김 + 자동 차단
    blockAt: 6,           // 이 점수 이상이면 차단 대상
    hideAt: 5,            // 이 점수 이상이면 숨김 대상
    skipFollowers: true,  // 나를 팔로우하는 계정은 건드리지 않음
    intervalSec: 6,       // 차단 요청 간격
    dailyCap: 300,        // 하루 최대 차단 수
    allow: [],            // screen_name 허용 목록
    log: [],              // 차단 기록
    day: '', dayCount: 0,
    totalBlocked: null,   // log는 500개까지만 남아 누적 수는 따로 셈
  };
  const RECENT_BLOCKS = 20;   // 패널에 보여 줄 최근 차단 계정 수

  // 이름 변경 전 저장 키에서 한 번 이전
  const OLD_KEY = 'padak-blocker-v1';
  if (localStorage.getItem(KEY) === null && localStorage.getItem(OLD_KEY) !== null) {
    localStorage.setItem(KEY, localStorage.getItem(OLD_KEY));
    localStorage.removeItem(OLD_KEY);
  }

  const loadConfig = () => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch { return { ...DEFAULTS }; }
  };
  const cfg = loadConfig();
  if (cfg.totalBlocked === null) cfg.totalBlocked = cfg.log.length;
  const save = () => localStorage.setItem(KEY, JSON.stringify(cfg));
  // 다른 탭에서 바뀐 설정과 차단 기록 반영
  window.addEventListener('storage', (event) => { if (event.key === KEY) Object.assign(cfg, loadConfig()); });

  // 차단 요청용 authorization 헤더는 X 요청에서 가로채 메모리에만 보관
  let auth = null;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!auth && String(name).toLowerCase() === 'authorization') auth = value;
    return origSetHeader.apply(this, arguments);
  };
  const cookie = (name) => (document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)')) || [])[1];
  const myId = () => decodeURIComponent(cookie('twid') || '').replace('u=', '');

  async function callApi(path, userId) {
    const res = await fetch('/i/api/1.1/' + path, {
      method: 'POST',
      credentials: 'include',
      headers: {
        authorization: auth,
        'x-csrf-token': cookie('ct0'),
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'user_id=' + encodeURIComponent(userId),
    });
    return res.status;
  }

  // 트윗 정보 읽기
  function readTweet(article) {
    const key = Object.keys(article).find((k) => k.startsWith('__reactFiber$'));
    for (let fiber = key && article[key], i = 0; fiber && i < 40; fiber = fiber.return, i++) {
      const props = fiber.memoizedProps;
      if (props && props.tweet && props.tweet.user) return { tweet: props.tweet, promoted: !!props.promotedContent };
    }
    return null;
  }

  // 구형 평면 구조와 신형 중첩 구조 사용자 객체 모두 지원
  function normalizeUser(u) {
    const legacy = u.legacy || u, core = u.core || u, rel = u.relationship_perspectives || u;
    const counts = u.relationship_counts || {}, tweets = u.tweet_counts || {};
    return {
      id: u.id_str || u.rest_id,
      screenName: core.screen_name,
      name: core.name,
      createdAt: core.created_at,
      bio: (u.profile_bio && u.profile_bio.description) || legacy.description || '',
      followers: counts.followers ?? legacy.followers_count,
      following: counts.following ?? legacy.friends_count,
      statuses: tweets.tweets ?? legacy.statuses_count,
      media: tweets.media_tweets ?? legacy.media_count,
      blue: !!u.is_blue_verified,
      verifiedType: (u.verification && u.verification.verified_type) || legacy.verified_type || null,
      isFollowing: !!rel.following,
      followedBy: !!rel.followed_by,
      blocking: !!rel.blocking,
      isProtected: !!((u.privacy && u.privacy.protected) ?? legacy.protected),
    };
  }

  // 판정
  const flagged = new Map();   // userId별 { user, score, why, tier, status, tries }
  const queue = [];            // 차단 대기 userId
  const manual = new Set();    // 패널에서 직접 차단을 누른 userId, 모드와 무관하게 처리

  const tierOf = (entry) => (entry.score >= cfg.blockAt && entry.signal ? 'block' : 'hide');
  const isKnownSlop = (userId) => {
    const entry = flagged.get(userId);
    return (entry && entry.tier === 'block') || cfg.log.some((item) => item.id === userId);
  };

  function score(user, tweet) {
    const result = classify(user, tweet.full_text || tweet.text || '', Date.now());
    // 품앗이 답글: 이미 차단 대상으로 판정된 계정에게 답글을 다는 활발한 계정
    const parentId = tweet.in_reply_to_user_id_str;
    if (result.active && parentId && parentId !== user.id && isKnownSlop(parentId)) {
      result.score += result.mutual ? 2 : 1;
      result.why.push('품앗이답글');
      result.signal = true;
    }
    return result;
  }

  let readOk = 0, readFail = 0;   // X 구조 변경으로 트윗 정보를 못 읽으면 패널에 표시

  function judge(article) {
    const read = readTweet(article);
    if (!read) { readFail++; return; }
    readOk++;
    const tweet = read.tweet.retweeted_status || read.tweet;
    if (article.dataset.bbId === tweet.id_str) return;
    article.dataset.bbId = tweet.id_str;
    delete article.dataset.bb;
    delete article.dataset.bbLabel;

    if (read.promoted) return;
    const user = normalizeUser(tweet.user);
    if (!user.id || user.id === myId()) return;
    if (!user.blue || user.verifiedType || user.isFollowing || user.isProtected || user.blocking) return;
    if (cfg.skipFollowers && user.followedBy) return;
    if (cfg.allow.includes(user.screenName)) return;

    const result = score(user, tweet);
    if (result.score < cfg.hideAt) return;

    let entry = flagged.get(user.id);
    if (!entry) {
      entry = { user, score: result.score, why: result.why, signal: result.signal, tier: 'hide', status: 'flagged', tries: 0 };
      flagged.set(user.id, entry);
    } else if (result.score > entry.score) {
      Object.assign(entry, { user, score: result.score, why: result.why, signal: result.signal });
    }
    if (entry.status === 'flagged') entry.tier = tierOf(entry);

    const markOnly = cfg.mode === 'dry' || !entry.signal;
    article.dataset.bbLabel = `@${user.screenName} ${result.score}점: ${result.why.join(', ')}${markOnly ? '' : '. 누르면 펼칩니다'}`;
    article.dataset.bb = markOnly ? 'mark' : 'hide';
    if (cfg.mode === 'block' && entry.tier === 'block') enqueue(user.id);
    renderSoon();
  }

  function scan() {
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      try { judge(article); } catch (e) { console.warn('[blue-sweep] judge 실패', e); }
    }
  }

  function rejudgeAll() {
    for (const [id, entry] of flagged) if (entry.status === 'flagged' && entry.score < cfg.hideAt) flagged.delete(id);
    for (const entry of flagged.values()) if (entry.status === 'flagged') entry.tier = tierOf(entry);
    for (const article of document.querySelectorAll('article[data-bb-id]')) delete article.dataset.bbId;
    if (cfg.mode === 'block') for (const [id, entry] of flagged) if (entry.tier === 'block') enqueue(id);
    scan();
    render();
  }

  // 차단 대기열
  let nextAt = 0, pausedUntil = 0;
  const today = () => new Date().toISOString().slice(0, 10);

  function enqueue(userId, isManual = false) {
    const entry = flagged.get(userId);
    if (!entry || entry.status !== 'flagged') return;
    entry.status = 'queued';
    if (isManual) manual.add(userId);
    queue.push(userId);
  }

  async function tick() {
    const now = Date.now();
    if (!queue.length || !auth || now < nextAt || now < pausedUntil) return;
    const index = queue.findIndex((id) => cfg.mode === 'block' || manual.has(id));
    if (index < 0) return;
    if (cfg.day !== today()) { cfg.day = today(); cfg.dayCount = 0; }
    if (cfg.dayCount >= cfg.dailyCap) return;

    nextAt = now + cfg.intervalSec * 1000 * (0.7 + Math.random() * 0.6);
    const [userId] = queue.splice(index, 1);
    const entry = flagged.get(userId);
    if (!entry || entry.status !== 'queued' || cfg.allow.includes(entry.user.screenName)) return;

    let status = 0;
    try { status = await callApi('blocks/create.json', userId); } catch { /* 네트워크 오류는 아래에서 재시도 처리 */ }
    entry.tries++;
    if (status === 200) {
      entry.status = 'blocked';
      cfg.dayCount++;
      cfg.totalBlocked++;
      cfg.log.unshift({ id: userId, sn: entry.user.screenName, score: entry.score, why: entry.why, at: now });
      cfg.log.length = Math.min(cfg.log.length, 500);
      save();
    } else if (status === 400 || status === 404 || entry.tries >= 2) {
      entry.status = 'failed';   // 정지, 삭제된 계정이거나 두 번 실패라 이 계정만 건너뜀
    } else {
      // 요청 한도나 인증 문제일 수 있어 15분 대기 후 재시도
      queue.unshift(userId);
      pausedUntil = now + 15 * 60 * 1000;
      lastError = `차단 요청 실패: ${status ? 'HTTP ' + status : '연결 오류'}. 15분 뒤 다시 시도합니다.`;
    }
    renderSoon();
  }

  async function unblock(userId, screenName) {
    if (!auth) { lastError = '타임라인을 조금 내린 뒤 다시 눌러주세요.'; renderSoon(); return; }
    let status = 0;
    try { status = await callApi('blocks/destroy.json', userId); } catch { /* 연결 오류는 아래 안내로 처리 */ }
    if (status !== 200) { lastError = `차단 해제 실패: ${status ? 'HTTP ' + status : '연결 오류'}`; renderSoon(); return; }
    allow(screenName);
    const entry = flagged.get(userId);
    if (entry) entry.status = 'allowed';
    if (cfg.log.some((item) => item.id === userId)) cfg.totalBlocked = Math.max(0, cfg.totalBlocked - 1);
    cfg.log = cfg.log.filter((item) => item.id !== userId);
    save();
    renderSoon();
  }

  function allow(screenName) {
    if (!cfg.allow.includes(screenName)) cfg.allow.push(screenName);
    for (const entry of flagged.values()) if (entry.user.screenName === screenName && entry.status !== 'blocked') entry.status = 'allowed';
    save();
    for (const article of document.querySelectorAll('article[data-bb]')) {
      if ((article.dataset.bbLabel || '').includes('@' + screenName + ' ')) { delete article.dataset.bb; delete article.dataset.bbLabel; }
    }
    renderSoon();
  }

  // 패널
  let lastError = '';
  let panelOpen = false;
  let root = null;
  let renderTimer = null;
  const renderSoon = () => { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 300); };

  const CSS = `
    article[data-bb="hide"] > * { display: none !important; }
    article[data-bb="hide"]::before, article[data-bb="mark"]::before {
      content: attr(data-bb-label); display: block; padding: 6px 16px; font: 13px/1.4 system-ui, sans-serif;
      color: #8b98a5; cursor: pointer; }
    article[data-bb="mark"] { outline: 2px solid #f5a623; outline-offset: -2px; }
    article[data-bb="mark"]::before { color: #f5a623; cursor: default; }
    #bb-root { position: fixed; left: 12px; bottom: 12px; z-index: 9999; font: 13px/1.4 system-ui, sans-serif; color: #e7e9ea; }
    #bb-root button { font: inherit; color: inherit; background: #1d2a35; border: 1px solid #38444d; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    #bb-root button.on { background: #1d9bf0; border-color: #1d9bf0; }
    #bb-pill { border-radius: 999px !important; padding: 6px 12px !important; background: #15202b !important; }
    #bb-panel { width: 340px; max-height: 60vh; overflow: auto; margin-bottom: 8px; padding: 12px; background: #15202b; border: 1px solid #38444d; border-radius: 12px; }
    #bb-panel h4 { margin: 10px 0 4px; font-size: 12px; color: #8b98a5; font-weight: 600; }
    #bb-panel .row { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
    #bb-panel .item { display: flex; gap: 6px; align-items: baseline; padding: 3px 0; border-top: 1px solid #22303c; }
    #bb-panel .item span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #bb-panel input[type="number"] { width: 44px; background: #1d2a35; color: inherit; border: 1px solid #38444d; border-radius: 6px; padding: 2px 4px; }
    #bb-panel .err { color: #f4212e; }`;

  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) node.append(child);
    return node;
  };

  function numberInput(field, label) {
    const input = el('input', { type: 'number', value: cfg[field] });
    input.addEventListener('change', () => {
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;
      cfg[field] = value;
      save();
      rejudgeAll();
    });
    return el('label', {}, [label + ' ', input]);
  }

  function checkbox(field, label) {
    const input = el('input', { type: 'checkbox', checked: cfg[field] });
    input.addEventListener('change', () => { cfg[field] = input.checked; save(); rejudgeAll(); });
    return el('label', {}, [input, ' ' + label]);
  }

  function render() {
    if (!document.body) return;
    if (!root) {
      document.head.append(el('style', { textContent: CSS }));
      root = el('div', { id: 'bb-root' });
      document.body.append(root);
    }
    const entries = [...flagged.values()];
    const pending = entries.filter((e) => e.status === 'queued').length;
    const broken = readOk === 0 && readFail >= 20;
    const pill = el('button', { id: 'bb-pill', textContent: broken ? 'Blue Sweep: 트윗 정보를 읽지 못했습니다' : `차단 ${cfg.totalBlocked}, 대기 ${pending}, 탐지 ${entries.length}` });
    pill.addEventListener('click', () => { panelOpen = !panelOpen; render(); });

    const children = [];
    if (panelOpen) {
      const modes = [['dry', '표시만'], ['hide', '숨김'], ['block', '자동 차단']].map(([mode, label]) => {
        const button = el('button', { textContent: label, className: cfg.mode === mode ? 'on' : '' });
        button.addEventListener('click', () => { cfg.mode = mode; save(); rejudgeAll(); });
        return button;
      });
      const status = !auth ? '타임라인을 조금 내리면 시작됩니다.'
        : Date.now() < pausedUntil ? `차단을 잠시 멈췄습니다. ${new Date(pausedUntil).toLocaleTimeString()}에 다시 시작합니다.`
        : `오늘 차단 ${cfg.day === today() ? cfg.dayCount : 0} / ${cfg.dailyCap}`;
      const recent = cfg.log.slice(0, RECENT_BLOCKS).map((item) => {
        const undo = el('button', { textContent: '해제' });
        undo.addEventListener('click', () => unblock(item.id, item.sn));
        return el('div', { className: 'item', title: item.why.join(', ') }, [
          el('span', { textContent: `@${item.sn} ${item.score}점: ${item.why.join(', ')}` }), undo,
        ]);
      });
      const list = entries.filter((entry) => entry.status !== 'blocked').sort((a, b) => b.score - a.score).slice(0, 60).map((entry) => {
        const { user } = entry;
        const state = { flagged: '탐지', queued: '대기', allowed: '허용', failed: '실패' }[entry.status];
        const buttons = [];
        if (entry.status === 'flagged' || entry.status === 'queued') {
          if (entry.status === 'flagged') {
            const block = el('button', { textContent: '차단' });
            block.addEventListener('click', () => { enqueue(user.id, true); render(); });
            buttons.push(block);
          }
          const ok = el('button', { textContent: '허용' });
          ok.addEventListener('click', () => allow(user.screenName));
          buttons.push(ok);
        }
        return el('div', { className: 'item', title: entry.why.join(', ') + '\n' + user.bio }, [
          el('span', { textContent: `[${state}] @${user.screenName} ${entry.score}점: ${entry.why.join(', ')}` }), ...buttons,
        ]);
      });
      children.push(el('div', { id: 'bb-panel' }, [
        el('div', { className: 'row' }, modes),
        el('div', { className: 'row' }, [numberInput('blockAt', '차단 기준'), numberInput('hideAt', '숨김 기준')]),
        el('div', { className: 'row' }, [checkbox('skipFollowers', '나를 팔로우하는 계정은 제외')]),
        el('div', { className: 'row', textContent: status }),
        ...(lastError ? [el('div', { className: 'row err', textContent: lastError })] : []),
        el('h4', { textContent: `최근 차단 ${recent.length}개, 누적 ${cfg.totalBlocked}개` }),
        ...recent,
        el('h4', { textContent: `이번에 탐지한 계정 ${list.length}개, 허용 ${cfg.allow.length}개` }),
        ...list,
      ]));
    }
    root.replaceChildren(...children, pill);
  }

  document.addEventListener('click', (event) => {
    const article = event.target instanceof Element && event.target.closest('article[data-bb="hide"]');
    if (!article || event.target !== article) return;
    event.preventDefault();
    event.stopPropagation();
    article.dataset.bb = 'shown';
  }, true);

  let scanTimer = null;
  const scanSoon = () => { if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 150); };

  function start() {
    new MutationObserver(scanSoon).observe(document.body, { childList: true, subtree: true });
    setInterval(scan, 1500);
    setInterval(tick, 1000);
    scan();
    render();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);

})();
