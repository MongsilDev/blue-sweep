// X 페이지 MAIN world에서 실행. 트윗 작성자 정보는 React props에서 읽음
(() => {
  'use strict';
  if (window.__blueSweepLoaded) return;
  window.__blueSweepLoaded = true;

  const { classify } = window.__blueSweep;
  const KEY = 'blue-sweep-v1';
  const DEFAULTS = {
    mode: 'hide',         // 'dry' 표시만 | 'hide' 자동 숨김 | 'block' 숨김 + 자동 차단
    blockAt: 6,           // 이 점수 이상이면 차단 대상
    hideAt: 5,            // 이 점수 이상이면 숨김 대상
    skipFollowers: true,  // 나를 팔로우하는 계정은 건드리지 않음
    intervalSec: 6,       // 차단 요청 간격
    dailyCap: 300,        // 하루 최대 차단 수
    allow: [],            // screen_name 허용 목록
    log: [],              // 차단 기록
    day: '', dayCount: 0,
    totalBlocked: 0,      // log는 500개까지만 남아 누적 수는 따로 셈
  };
  const RECENT_BLOCKS = 20;   // 패널에 보여 줄 최근 차단 계정 수

  const loadConfig = () => {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch { return { ...DEFAULTS }; }
  };
  const cfg = loadConfig();
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
      result.why.push('품앗이 답글');
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
    clearMark(article);

    if (read.promoted) return;
    const user = normalizeUser(tweet.user);
    if (!user.id || user.id === myId()) return;
    article.dataset.bbUser = user.id;
    // 차단했거나 차단 대기 중인 계정은 모드와 무관하게 접고 상태만 보여 줌
    const known = flagged.get(user.id);
    if (known && (known.status === 'queued' || known.status === 'blocked')) { stateLabel(article, known); return; }
    if (cfg.log.some((item) => item.id === user.id)) { stateLabel(article, { user, status: 'blocked' }); return; }
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

    // 그 계정의 프로필이나 글 화면은 직접 찾아간 것이라 접지 않음
    const ownPage = location.pathname.split('/')[1].toLowerCase() === user.screenName.toLowerCase();
    const markOnly = cfg.mode === 'dry' || !entry.signal || ownPage;
    article.dataset.bbLabel = `@${user.screenName} ${result.score}점: ${result.why.join(', ')}`;
    article.dataset.bb = markOnly ? 'mark' : 'hide';
    attachLabel(article, entry, result);
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
    // 취소한 계정은 자동 차단에서 빼고 직접 누를 때만 다시 넣음
    if (entry.cancelled && !isManual) return;
    entry.cancelled = false;
    entry.status = 'queued';
    if (isManual) { manual.add(userId); refreshUser(userId); }
    queue.push(userId);
  }

  function cancelQueued(userId) {
    const entry = flagged.get(userId);
    if (!entry || entry.status !== 'queued') return;
    entry.status = 'flagged';
    entry.cancelled = true;
    manual.delete(userId);
    const index = queue.indexOf(userId);
    if (index >= 0) queue.splice(index, 1);
    refreshUser(userId);
    renderSoon();
  }

  // 그 계정의 트윗을 화면에서 다시 판정
  function refreshUser(userId) {
    for (const article of document.querySelectorAll('article[data-bb-user]')) {
      if (article.dataset.bbUser === userId) delete article.dataset.bbId;
    }
    scanSoon();
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
      refreshUser(userId);
    } else if (status === 400 || status === 404 || entry.tries >= 2) {
      entry.status = 'failed';   // 정지, 삭제된 계정이거나 두 번 실패라 이 계정만 건너뜀
      refreshUser(userId);
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
    if (status !== 200) { lastError = `차단 해제 실패: ${status ? 'HTTP ' + status : '연결 오류'}. 잠시 뒤 다시 눌러주세요.`; refreshUser(userId); renderSoon(); return; }
    allow(screenName);
    const entry = flagged.get(userId);
    if (entry) entry.status = 'allowed';
    if (cfg.log.some((item) => item.id === userId)) cfg.totalBlocked = Math.max(0, cfg.totalBlocked - 1);
    cfg.log = cfg.log.filter((item) => item.id !== userId);
    save();
    refreshUser(userId);
    renderSoon();
  }

  function allow(screenName) {
    if (!cfg.allow.includes(screenName)) cfg.allow.push(screenName);
    for (const entry of flagged.values()) if (entry.user.screenName === screenName && entry.status !== 'blocked') entry.status = 'allowed';
    save();
    for (const article of document.querySelectorAll('article[data-bb]')) {
      if ((article.dataset.bbLabel || '').startsWith('@' + screenName + ' ')) clearMark(article);
    }
    renderSoon();
  }

  function unallow(screenName) {
    cfg.allow = cfg.allow.filter((name) => name !== screenName);
    for (const entry of flagged.values()) if (entry.user.screenName === screenName && entry.status === 'allowed') entry.status = 'flagged';
    save();
    rejudgeAll();
  }

  // 트윗 위 표시 줄
  function clearMark(article) {
    delete article.dataset.bb;
    delete article.dataset.bbLabel;
    const old = article.querySelector(':scope > .bb-label');
    if (old) old.remove();
  }

  // X 라우터가 popstate를 따라가므로 새로고침 없이 이동
  function openProfile(screenName) {
    history.pushState({}, '', '/' + screenName);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }

  function userLink(screenName) {
    const link = el('a', { className: 'bb-user', href: '/' + screenName, textContent: '@' + screenName });
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      openProfile(screenName);
    });
    return link;
  }

  function attachLabel(article, entry, result) {
    const { user } = entry;
    const buttons = [];
    const toggle = article.dataset.bb === 'hide' ? el('button', { textContent: '펼치기' }) : null;
    if (toggle) buttons.push(toggle);
    const ok = el('button', { textContent: '허용' });
    buttons.push(ok);
    const block = entry.status === 'flagged' ? el('button', { textContent: '차단' }) : null;
    if (block) buttons.push(block);

    const label = el('div', { className: 'bb-label', title: user.bio }, [
      userLink(user.screenName),
      el('span', { className: 'bb-why', textContent: ` ${result.score}점: ${result.why.join(', ')}` }),
      ...buttons,
    ]);
    // 트윗 열기 같은 X 쪽 클릭 처리로 이벤트 전달 차단
    label.addEventListener('auxclick', (event) => event.stopPropagation());
    label.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.classList && event.target.classList.contains('bb-user')) return;
      event.preventDefault();
      if (event.target === ok) allow(user.screenName);
      else if (block && event.target === block) { enqueue(user.id, true); renderSoon(); }
      else if (toggle && (event.target === toggle || article.dataset.bb === 'hide')) {
        article.dataset.bb = article.dataset.bb === 'hide' ? 'shown' : 'hide';
        toggle.textContent = article.dataset.bb === 'hide' ? '펼치기' : '접기';
      }
    });
    article.prepend(label);
  }

  // 차단 대기나 차단한 계정의 트윗은 한 줄로 접고 취소, 해제 버튼만 둠
  function stateLabel(article, entry) {
    const { user } = entry;
    clearMark(article);
    article.dataset.bb = 'hide';
    article.dataset.bbLabel = `@${user.screenName} ${entry.status}`;
    const blocked = entry.status === 'blocked';
    const action = el('button', { textContent: blocked ? '차단 해제' : '취소' });
    const label = el('div', { className: 'bb-label bb-state' }, [
      userLink(user.screenName),
      el('span', { className: 'bb-why', textContent: blocked ? ' 차단함' : ' 차단 대기 중' }),
      action,
    ]);
    label.addEventListener('auxclick', (event) => event.stopPropagation());
    label.addEventListener('click', (event) => {
      event.stopPropagation();
      if (event.target.classList && event.target.classList.contains('bb-user')) return;
      event.preventDefault();
      if (event.target !== action) return;
      if (blocked) { action.textContent = '해제 중'; action.disabled = true; unblock(user.id, user.screenName); }
      else cancelQueued(user.id);
    });
    article.prepend(label);
  }

  // 패널
  let lastError = '';
  let panelOpen = false;
  let root = null;
  let renderTimer = null;
  const renderSoon = () => { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 300); };

  const CSS = `
    article[data-bb] { flex-wrap: wrap; }
    article[data-bb="hide"] > :not(.bb-label) { display: none !important; }
    article[data-bb="mark"] { box-shadow: inset 3px 0 0 #f5a623; }
    .bb-label { flex: 0 0 100%; box-sizing: border-box; display: flex; align-items: baseline; gap: 2px; padding: 10px 16px 0;
      font: 13px/1.4 system-ui, sans-serif; color: #71767b; cursor: default; }
    article[data-bb="mark"] .bb-label { color: #f5a623; }
    article[data-bb="hide"] .bb-label { padding: 12px 16px; cursor: pointer; }
    article[data-bb="hide"] .bb-state { cursor: default; }
    .bb-user { color: inherit; font-weight: 600; text-decoration: none; }
    .bb-user:hover { text-decoration: underline; }
    .bb-why { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bb-label button { font: inherit; color: #1d9bf0; background: none; border: 0; padding: 0 6px; cursor: pointer; }
    .bb-label button:hover { text-decoration: underline; }
    #bb-root[hidden] { display: none !important; }
    #bb-root { position: fixed; left: 12px; bottom: 12px; z-index: 9999; font: 13px/1.4 system-ui, sans-serif; color: #e7e9ea; }
    #bb-root button { font: inherit; color: inherit; background: #1d2a35; border: 1px solid #38444d; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
    #bb-root button.on { background: #1d9bf0; border-color: #1d9bf0; }
    #bb-pill { border-radius: 999px !important; padding: 6px 12px !important; background: #15202b !important; }
    #bb-panel { width: 340px; max-height: 60vh; overflow: auto; margin-bottom: 8px; padding: 12px; background: #15202b; border: 1px solid #38444d; border-radius: 12px; }
    #bb-panel h4 { margin: 10px 0 4px; font-size: 12px; color: #8b98a5; font-weight: 600; }
    #bb-panel .row { display: flex; gap: 6px; align-items: center; margin: 4px 0; flex-wrap: wrap; }
    #bb-panel .msg { display: block; }
    #bb-panel .item { display: flex; gap: 6px; align-items: baseline; padding: 3px 0; border-top: 1px solid #22303c; }
    #bb-panel .item span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #bb-panel .bb-user { color: #e7e9ea; }
    #bb-panel .title { justify-content: space-between; font-weight: 600; }
    #bb-panel input[type="number"] { width: 44px; background: #1d2a35; color: inherit; border: 1px solid #38444d; border-radius: 6px; padding: 2px 4px; }
    #bb-panel .err { color: #f4212e; }`;

  const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const child of children) node.append(child);
    return node;
  };
  const lines = (text) => text.split(/(?<=[.?!])\s+/).flatMap((line, i) => (i ? [el('br'), line] : [line]));

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
      // 동영상 전체화면 위에 버튼이 남지 않게 숨김
      const syncFullscreen = () => { root.hidden = !!document.fullscreenElement; };
      document.addEventListener('fullscreenchange', syncFullscreen);
      syncFullscreen();
    }
    // 입력 중에 다시 그리면 입력칸이 포커스를 잃으므로 미룸
    const active = document.activeElement;
    if (active && active.tagName === 'INPUT' && root.contains(active)) { renderSoon(); return; }
    const oldPanel = root.querySelector('#bb-panel');
    const scrollTop = oldPanel ? oldPanel.scrollTop : 0;

    const entries = [...flagged.values()];
    const pending = entries.filter((e) => e.status === 'queued').length;
    const broken = readOk === 0 && readFail >= 20;
    const modeName = { dry: '표시만', hide: '자동 숨김', block: '자동 차단' }[cfg.mode];
    const counts = [`탐지 ${entries.filter((e) => e.status !== 'blocked' && e.status !== 'allowed').length}`];
    if (cfg.mode === 'block' || cfg.totalBlocked) counts.push(`차단 ${cfg.totalBlocked}`);
    if (pending) counts.push(`대기 ${pending}`);
    const pill = el('button', { id: 'bb-pill', textContent: broken ? 'Blue Sweep: 트윗 정보를 읽지 못했습니다. 새 버전이 있는지 확인해주세요.' : `${modeName}: ${counts.join(', ')}` });
    pill.addEventListener('click', () => { panelOpen = !panelOpen; render(); });

    const children = [];
    if (panelOpen) {
      const modes = [['dry', '표시만'], ['hide', '자동 숨김'], ['block', '자동 차단']].map(([mode, label]) => {
        const button = el('button', { textContent: label, className: cfg.mode === mode ? 'on' : '' });
        button.addEventListener('click', () => { cfg.mode = mode; save(); rejudgeAll(); });
        return button;
      });
      const blocking = cfg.mode === 'block' || queue.length > 0;
      const status = Date.now() < pausedUntil ? `차단을 잠시 멈췄습니다. ${new Date(pausedUntil).toLocaleTimeString()}에 다시 시작합니다.`
        : !blocking ? ''
        : !auth ? '타임라인을 조금 내리면 차단을 시작합니다.'
        : `오늘 차단 ${cfg.day === today() ? cfg.dayCount : 0} / ${cfg.dailyCap}`;
      const button = (text, onClick) => { const b = el('button', { textContent: text }); b.addEventListener('click', onClick); return b; };
      const item = (screenName, text, title, buttons) => el('div', { className: 'item', title }, [
        userLink(screenName), el('span', { textContent: text }), ...buttons,
      ]);
      const recent = cfg.log.slice(0, RECENT_BLOCKS).map((entry) =>
        item(entry.sn, ` ${entry.score}점: ${entry.why.join(', ')}`, entry.why.join(', '), [button('해제', () => unblock(entry.id, entry.sn))]));
      const list = entries.filter((entry) => entry.status !== 'blocked' && entry.status !== 'allowed').sort((a, b) => b.score - a.score).slice(0, 60).map((entry) => {
        const { user } = entry;
        const state = { queued: ', 차단 대기', failed: ', 차단 실패' }[entry.status] || '';
        const buttons = [];
        if (entry.status === 'flagged') buttons.push(button('차단', () => { enqueue(user.id, true); render(); }));
        if (entry.status === 'flagged' || entry.status === 'queued') buttons.push(button('허용', () => allow(user.screenName)));
        return item(user.screenName, ` ${entry.score}점: ${entry.why.join(', ')}${state}`, entry.why.join(', ') + '\n' + user.bio, buttons);
      });
      const allowed = cfg.allow.map((screenName) => item(screenName, '', '', [button('취소', () => unallow(screenName))]));
      children.push(el('div', { id: 'bb-panel' }, [
        el('div', { className: 'row title' }, ['Blue Sweep', button('닫기', () => { panelOpen = false; render(); })]),
        el('div', { className: 'row' }, modes),
        el('div', { className: 'row' }, [numberInput('blockAt', '차단 기준'), numberInput('hideAt', '숨김 기준')]),
        el('div', { className: 'row' }, [checkbox('skipFollowers', '나를 팔로우하는 계정은 제외')]),
        ...(status ? [el('div', { className: 'row msg' }, lines(status))] : []),
        ...(lastError ? [el('div', { className: 'row msg err' }, lines(lastError))] : []),
        el('h4', { textContent: list.length ? `탐지한 계정 ${list.length}개` : '아직 탐지한 계정이 없습니다' }),
        ...list,
        ...(recent.length ? [el('h4', { textContent: `최근 차단 ${recent.length}개, 누적 ${cfg.totalBlocked}개` }), ...recent] : []),
        ...(allowed.length ? [el('h4', { textContent: `허용 목록 ${allowed.length}개` }), ...allowed] : []),
      ]));
    }
    root.replaceChildren(...children, pill);
    const panel = root.querySelector('#bb-panel');
    if (panel) panel.scrollTop = scrollTop;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panelOpen) { panelOpen = false; render(); }
  });

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
