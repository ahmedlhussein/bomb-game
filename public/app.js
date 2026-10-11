'use strict';
/**
 * تطبيق واجهة "القنبلة" - يربط محرك اللعبة (engine.js) بالشاشات وبالـ Backend الحقيقي.
 * ملف JS خالص بدون أي إطار عمل أو مكتبة خارجية.
 *
 * التحقق من صيغة الكود محليًا (6 خانات) هو فحص شكلي سريع فقط لتحسين تجربة الاستخدام؛
 * التحقق الحقيقي من الأكواد الفعلية يتم دائمًا عبر /api/verify-code (انظر lib/codeAuth.js)،
 * ولا يظهر أي كود حقيقي أو هاش له في هذا الملف أو في أي كود يصل المتصفح.
 */

const STORAGE_KEY = 'bombgame_state_v2'; // v2: شكل الحالة الجديد (رمية القنبلة) - حالات v1 القديمة تُتجاهل
const SESSION_KEY = 'bombgame_session_v1'; // { codeHash, sessionToken, expiresInSeconds }
const TEST_OVERRIDES = (typeof window !== 'undefined' && window.__BOMBGAME_TEST__) || {};
const HEARTBEAT_INTERVAL_MS = TEST_OVERRIDES.heartbeatIntervalMs || 25000;
const HEARTBEAT_GRACE_MS = TEST_OVERRIDES.heartbeatGraceMs || HeartbeatPolicy.DEFAULT_GRACE_MS;
let heartbeatTimer = null;
let lastHeartbeatSuccessAt = null;

const root = document.getElementById('app');
let soundOn = true;

/** ------------------------- أدوات صيغة الكود ------------------------- */
function normalizeCode(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function isValidCodeFormat(code) {
  // 2-4 حروف إنجليزية صغيرة ثم أرقام تكمل العدد إلى 6
  return /^[a-z]{2,4}[0-9]{2,4}$/.test(code) && code.length === 6;
}

/** ------------------------- التخزين المحلي (لدعم Refresh) ------------------------- */
function saveGame(state) {
  try { localStorage.setItem(STORAGE_KEY, BombGameEngine.serialize(state)); } catch (e) { /* تجاهل بصمت */ }
}
function loadGame() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const st = BombGameEngine.deserialize(raw);
    return st && st.version === 2 ? st : null;
  } catch (e) { return null; }
}
function clearGame() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* تجاهل */ }
}

/** ------------------------- حالة التطبيق ------------------------- */
let gameState = null;
let setupPlayerCount = null;
let selectedThrowType = 'accurate';
let uiLocked = false;
let aimRaf = null;
let tickTimer = null;

function render() {
  stopLoops();
  if (!hasCodeAccess()) return renderCodeScreen();
  if (!gameState) return renderCountScreen();
  if (gameState.phase === BombGameEngine.PHASES.FINISHED) return renderWinnerScreen();
  return renderGameScreen();
}

function hasCodeAccess() {
  return !!getSession();
}
function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function setSession(obj) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(obj)); } catch (e) {}
}
function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  lastHeartbeatSuccessAt = null;
}
async function apiCall(path, payload) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: { ok: false, error: 'تعذّر الاتصال بالخادم' } };
  }
}
function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (lastHeartbeatSuccessAt == null) lastHeartbeatSuccessAt = Date.now();
  heartbeatTimer = setInterval(async () => {
    const session = getSession();
    if (!session) return;
    const res = await apiCall('/api/heartbeat', { codeHash: session.codeHash, sessionToken: session.sessionToken });
    const ok = !!(res.body && res.body.ok);
    if (ok) {
      lastHeartbeatSuccessAt = Date.now();
      return;
    }
    const msSinceLastSuccess = Date.now() - (lastHeartbeatSuccessAt || Date.now());
    const forceReauth = HeartbeatPolicy.shouldForceReauth({
      ok: false,
      status: res.status,
      msSinceLastSuccess,
      graceMs: HEARTBEAT_GRACE_MS,
    });
    if (forceReauth) {
      // إما رفض قطعي من الخادم (جهاز آخر / انتهاء صلاحية)، أو تجاوزنا مهلة السماح لانقطاع شبكي فعلي
      clearSession();
      render();
    }
    // وإلا: انقطاع مؤقت ضمن مهلة السماح - نستمر بصمت دون أي تأثير على اللعب المحلي
  }, HEARTBEAT_INTERVAL_MS);
}

/** ------------------------- شاشة 1: كود الدخول ------------------------- */
function renderCodeScreen() {
  root.innerHTML = `
    <div class="screen" id="screen-code">
      <div class="title-brand">القنبلة<span>.</span></div>
      <h2>ادخل الكود الخاص بيك</h2>
      <div class="code-inputs" id="code-inputs">
        ${Array.from({ length: 6 }).map((_, i) => `<input maxlength="1" inputmode="text" data-idx="${i}" autocomplete="off">`).join('')}
      </div>
      <div class="code-hint">مثال على شكل الكود: zxc123 - bnm456 - asd789</div>
      <div class="error-msg" id="code-error"></div>
      <button class="btn btn-primary" id="submit-code">دخول</button>
    </div>
  `;
  const inputs = Array.from(root.querySelectorAll('#code-inputs input'));
  inputs.forEach((inp, i) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\s/g, '');
      if (inp.value && i < inputs.length - 1) inputs[i + 1].focus();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i - 1].focus();
    });
    inp.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = normalizeCode((e.clipboardData || window.clipboardData).getData('text'));
      text.split('').slice(0, 6).forEach((ch, j) => { if (inputs[j]) inputs[j].value = ch; });
      const last = Math.min(text.length, 6) - 1;
      if (last >= 0) inputs[last].focus();
    });
  });
  root.querySelector('#submit-code').addEventListener('click', async () => {
    const submitBtn = root.querySelector('#submit-code');
    if (submitBtn.disabled) return; // يمنع أي طلب مزدوج من نقرة مزدوجة سريعة على نفس الجهاز
    const code = normalizeCode(inputs.map((i) => i.value).join(''));
    const errBox = root.querySelector('#code-error');
    if (!isValidCodeFormat(code)) {
      errBox.textContent = 'صيغة الكود غير صحيحة';
      return;
    }
    submitBtn.disabled = true;
    errBox.textContent = 'جارٍ التحقق...';
    const res = await apiCall('/api/verify-code', { code });
    if (res.body && res.body.ok) {
      setSession({ codeHash: res.body.codeHash, sessionToken: res.body.sessionToken });
      startHeartbeat();
      render();
    } else {
      errBox.textContent = (res.body && res.body.error) || 'حدث خطأ غير متوقع';
      submitBtn.disabled = false;
    }
  });
}

/** ------------------------- شاشة 2: عدد اللاعبين ------------------------- */
function renderCountScreen() {
  root.innerHTML = `
    <div class="screen" id="screen-count">
      <div class="title-brand">القنبلة<span>.</span></div>
      <h2>كم عدد اللاعبين؟</h2>
      <div class="count-grid" id="count-grid">
        ${[2, 3, 4, 5, 6].map((n) => `<button class="btn" data-n="${n}">${n}</button>`).join('')}
      </div>
    </div>
  `;
  root.querySelectorAll('#count-grid .btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      setupPlayerCount = Number(btn.dataset.n);
      renderNamesScreen();
    });
  });
}

/** ------------------------- شاشة 3: أسماء اللاعبين ------------------------- */
function renderNamesScreen() {
  root.innerHTML = `
    <div class="screen" id="screen-names">
      <h2>أدخل أسماء اللاعبين</h2>
      <div class="subtitle">كل لاعب معاه ${BombGameEngine.CONST.HEARTS_BY_PLAYERS[setupPlayerCount]} ❤️ • انفجار القنبلة في إيدك يخسّرك قلبًا</div>
      <div class="name-list" id="name-list">
        ${Array.from({ length: setupPlayerCount }).map((_, i) => `<input type="text" placeholder="اسم اللاعب ${i + 1}" data-idx="${i}" maxlength="20">`).join('')}
      </div>
      <div class="error-msg" id="names-error"></div>
      <button class="btn btn-primary" id="start-round">ابدأ الجولة</button>
    </div>
  `;
  const inputs = Array.from(root.querySelectorAll('#name-list input'));
  root.querySelector('#start-round').addEventListener('click', () => {
    const names = inputs.map((i) => i.value.trim()).filter(Boolean);
    if (names.length !== setupPlayerCount) {
      root.querySelector('#names-error').textContent = 'يجب إدخال جميع الأسماء';
      return;
    }
    gameState = BombGameEngine.createGame(names, undefined, nowMs());
    saveGame(gameState);
    playSound('start');
    render();
  });
}

/** ------------------------- شاشة 4: اللعب ------------------------- */
const ACTIONS = BombGameEngine.ACTIONS;
const PHASES = BombGameEngine.PHASES;
const ZONE_CLASS = { green: 'low', yellow: 'mid', orange: 'high', red: 'crit' };
const ZONE_ICON = { green: '🟢', yellow: '🟡', orange: '🟠', red: '🔴' };
const ANIM = { FLY: 650, HIT: 350, SLIP: 750, BOOM: 1500, NEWBOMB: 550, SUDDEN: 1900, TOAST: 1900, SHORT: 350 };

function nowMs() { return Date.now() + (TEST_OVERRIDES.timeOffsetMs || 0); }
function dur(ms) { return TEST_OVERRIDES.fastAnimations ? 20 : ms; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function stopLoops() {
  if (aimRaf != null) { cancelAnimationFrame(aimRaf); aimRaf = null; }
  if (tickTimer != null) { clearInterval(tickTimer); tickTimer = null; }
}

function heartsHtml(p) {
  let out = '';
  for (let i = 0; i < p.maxHearts; i++) out += i < p.hearts ? '❤️' : '🖤';
  return out;
}

function statusLine(view, holder) {
  const parts = [];
  if (view.forcedTargetId) {
    const t = gameState.players.find((p) => p.id === view.forcedTargetId);
    parts.push(`🔒 لازم ترمي على ${escapeHtml(t.name)} — نقاط الرمية ×2`);
  } else if (view.confused) {
    parts.push('😵 مُربَك: منطقة رميتك الأولى أضيق 25%');
  }
  const red = view.zone === 'red';
  parts.push(`${ZONE_ICON[view.zone]} ${view.zoneEffect}`);
  if (view.bombDefused && !red) parts.push('🔥 قنبلة منهكة: الأحمر القادم = انفجار فوري');
  return parts.map((t) => `<div>${t}</div>`).join('');
}

function renderGameScreen() {
  const view = BombGameEngine.getPublicView(gameState, gameState.bombHolderId);
  const holder = gameState.players.find((p) => p.id === gameState.bombHolderId);
  const isPaused = gameState.phase === PHASES.PAUSED;
  const zoneClass = ZONE_CLASS[view.zone] || 'low';
  const modeTag = view.suddenDeath ? '⚡ وضع الحسم' : view.bombDefused ? '🔥 قنبلة منهكة' : '';

  root.innerHTML = `
    <div class="screen game-screen" id="screen-game">
      <div class="top-bar">
        <button class="pause-btn" id="pause-btn" aria-label="Pause">⏸</button>
        <div class="mode-tag" id="mode-tag">${modeTag}</div>
        <button class="sound-btn" id="sound-btn" aria-label="Sound">${soundOn ? '🔊' : '🔇'}</button>
      </div>

      <div class="holder-banner">
        <div class="label">دور اللاعب الآن</div>
        <div class="name">${escapeHtml(holder.name)} — دورك الآن</div>
        <div class="status-line" id="status-line">${statusLine(view, holder)}</div>
      </div>

      <div class="bomb-wrap">
        <div class="bomb level-${zoneClass}" id="bomb-emoji">💣</div>
        <div class="gauge-box">
          <div class="gauge" id="gauge" dir="ltr">
            <div class="seg seg-green"></div><div class="seg seg-yellow"></div><div class="seg seg-orange"></div><div class="seg seg-red"></div>
            <div class="gauge-pointer" id="gauge-pointer" style="left:${view.dangerPct}%"></div>
          </div>
          <div class="danger-label ${zoneClass}">مستوى الخطر: ${view.dangerLabel}</div>
        </div>
      </div>

      <div class="players-strip" id="players-strip" style="grid-template-columns:repeat(${view.players.length <= 4 ? view.players.length : 3}, 1fr)">
        ${view.players.map((p) => `
          <div class="player-chip ${p.isHolder ? 'holder' : ''} ${!p.alive ? 'dead' : ''}" data-pid="${p.id}">
            <div class="chip-name">${escapeHtml(p.name)}</div>
            <div class="chip-hearts">${heartsHtml(p)}</div>
            <div class="chip-meta">${p.alive ? `🏆${p.score}${p.shield ? ' 🛡️' : ''} 🤝×${p.safeHandoffs}` : 'خرج'}</div>
          </div>`).join('')}
      </div>

      <div class="actions-area" id="actions-area"></div>
      <div class="legend">❤️ قلوب • 🛡️ درع (يمتص انفجارًا) • 🤝 تسليمات آمنة متبقية • 🏆 نقاط (20 = درع)</div>
      <div class="log-line" id="log-line">${view.recentLog.length ? escapeHtml(view.recentLog[view.recentLog.length - 1]) : ''}</div>
    </div>
    ${isPaused ? `
      <div class="pause-overlay" id="pause-overlay">
        <div class="title-brand">توقف مؤقت</div>
        <div class="subtitle">اللعبة متوقفة الآن</div>
        <button class="btn btn-primary" id="resume-btn" style="max-width:220px;">استئناف</button>
      </div>` : ''}
    <div id="toasts"></div>
  `;

  root.querySelector('#pause-btn').addEventListener('click', () => {
    if (uiLocked) return;
    BombGameEngine.pauseGame(gameState, nowMs());
    saveGame(gameState);
    render();
  });
  root.querySelector('#sound-btn').addEventListener('click', () => {
    soundOn = !soundOn;
    render();
  });
  if (isPaused) {
    root.querySelector('#resume-btn').addEventListener('click', () => {
      BombGameEngine.resumeGame(gameState, nowMs());
      saveGame(gameState);
      render();
    });
    return; // لا أفعال Gameplay أثناء الإيقاف
  }

  renderActionsArea(view, holder);
  startTicking(view.zone);
}

function shieldButtonHtml(view, holder) {
  if (holder.shield) return '<div class="shield-note">🛡️ معاك درع: هيمتص أول انفجار</div>';
  if (view.canBuyShield) {
    return `<button class="btn btn-shield" id="buy-shield">🛡️ اشترِ درعًا (${view.shieldCost} نقطة) — يمتص انفجارًا واحدًا</button>`;
  }
  return '';
}

function wireShieldButton(holder) {
  const b = root.querySelector('#buy-shield');
  if (b) b.addEventListener('click', () => doAction({ type: ACTIONS.BUY_SHIELD }));
}

function renderActionsArea(view, holder) {
  const area = root.querySelector('#actions-area');

  if (gameState.phase === PHASES.AIM) return renderAim(area, view);

  if (gameState.phase === PHASES.EVENT_PENDING) {
    area.innerHTML = `
      <div class="event-banner">
        <h3>${escapeHtml(view.pendingEvent.title)}</h3>
        <div class="btn-grid" id="event-options">
          ${view.pendingEvent.options.map((o) => `<button class="btn btn-secondary event-btn" data-id="${o.id}"><span class="ev-label">${escapeHtml(o.label)}</span><span class="ev-desc">${escapeHtml(o.desc || '')}</span></button>`).join('')}
        </div>
      </div>`;
    area.querySelectorAll('#event-options button').forEach((btn) => {
      btn.addEventListener('click', () => doAction({ type: ACTIONS.RESOLVE_EVENT, choiceId: btn.dataset.id }));
    });
    return;
  }

  if (gameState.phase === PHASES.DEFUSE_READY) {
    const instantNote = '';
    area.innerHTML = `
      <div class="event-banner red-banner">
        <h3>🔴 المنطقة الحمراء!</h3>
        <p class="red-text">ممنوع الرمي. ثبّت المؤشر داخل المنطقة الخضراء لفكّ الفتيل، وإلا تنفجر القنبلة وتخسر قلبًا.${instantNote}</p>
        <button class="btn btn-primary big-btn" id="start-defuse">ابدأ فكّ الفتيل</button>
        ${shieldButtonHtml(view, holder)}
      </div>`;
    area.querySelector('#start-defuse').addEventListener('click', () => doAction({ type: ACTIONS.START_DEFUSE }));
    wireShieldButton(holder);
    return;
  }

  // READY: نوع الرمية ثم الهدف
  const actions = view.availableActions;
  const pv = view.throwPreview;
  if (!pv[selectedThrowType] || !pv[selectedThrowType].available) selectedThrowType = 'accurate';
  const types = [
    { key: 'fast', icon: '⚡', title: 'رمية سريعة', sub: `منطقة النجاح ${pv.fast.widthPct}% • صعبة جدًا • خطر قليل • تربك المستلم` },
    { key: 'accurate', icon: '🎯', title: 'رمية مضبوطة', sub: `منطقة النجاح ${pv.accurate.widthPct}% • متوسطة • خطر متوسط` },
    { key: 'safe', icon: '🤝', title: `تسليم آمن ×${holder.safeHandoffs}`, sub: `منطقة النجاح ${pv.safe.widthPct}% • شبه مضمون • خطر قليل جدًا` },
  ];
  const targets = actions.filter((a) => a.type === ACTIONS.START_THROW && a.throwType === selectedThrowType);
  const blocked = view.blockedBackTargetId ? gameState.players.find((p) => p.id === view.blockedBackTargetId) : null;

  area.innerHTML = `
    <div class="throw-types" id="throw-types">
      ${types.map((t) => `
        <button class="throw-btn ${t.key === selectedThrowType ? 'selected' : ''}" data-type="${t.key}" ${pv[t.key].available ? '' : 'disabled'}>
          <span class="ic">${t.icon}</span><span class="t">${t.title}</span><span class="sub">${t.sub}</span>
        </button>`).join('')}
    </div>
    <div class="target-label">اختر مين تمرّر له:</div>
    <div class="target-select" id="target-select">
      ${targets.map((a) => `<button class="btn btn-outline" data-target="${a.targetId}">مرّر إلى ${escapeHtml(getPlayer(a.targetId).name)}</button>`).join('')}
    </div>
    ${blocked ? `<div class="hint">↩️ مش هتقدر ترد على ${escapeHtml(blocked.name)} مباشرة</div>` : ''}
    ${shieldButtonHtml(view, holder)}
  `;
  area.querySelectorAll('#throw-types button').forEach((btn) => {
    btn.addEventListener('click', () => { if (uiLocked) return; selectedThrowType = btn.dataset.type; renderActionsArea(view, holder); });
  });
  area.querySelectorAll('#target-select button').forEach((btn) => {
    btn.addEventListener('click', () => doAction({ type: ACTIONS.START_THROW, throwType: selectedThrowType, targetId: btn.dataset.target }));
  });
  wireShieldButton(holder);
}

function renderAim(area, view) {
  const aim = view.aim;
  const isDefuse = aim.kind === 'defuse';
  const title = isDefuse ? '🔴 فكّ الفتيل! أوقف المؤشر داخل المنطقة الخضراء' : `${aim.throwType === 'fast' ? '⚡' : aim.throwType === 'safe' ? '🤝' : '🎯'} أوقف المؤشر داخل المنطقة الخضراء!`;
  area.innerHTML = `
    <div class="aim-panel ${isDefuse ? 'aim-defuse' : ''}">
      <div class="aim-title">${title}</div>
      <div class="aim-bar" id="aim-bar" dir="ltr">
        <div class="aim-zone" id="aim-zone" style="left:${(aim.zoneStart * 100).toFixed(2)}%;width:${((aim.zoneEnd - aim.zoneStart) * 100).toFixed(2)}%"></div>
        <div class="aim-cursor" id="aim-cursor"></div>
      </div>
      <button class="btn release-btn ${isDefuse ? 'btn-primary' : 'btn-secondary'}" id="release-btn">${isDefuse ? 'فكّ!' : 'ارمِ!'}</button>
    </div>`;
  const cursorEl = area.querySelector('#aim-cursor');
  const loop = () => {
    if (!gameState || gameState.phase !== PHASES.AIM) return;
    cursorEl.style.left = (BombGameEngine.cursorAt(gameState.aim, nowMs()) * 100).toFixed(2) + '%';
    aimRaf = requestAnimationFrame(loop);
  };
  loop();
  area.querySelector('#release-btn').addEventListener('click', () => {
    if (uiLocked || gameState.phase !== PHASES.AIM) return;
    const a = gameState.aim;
    let cursor = BombGameEngine.cursorAt(a, nowMs());
    if (TEST_OVERRIDES.forceCursor === 'zone') cursor = (a.zoneStart + a.zoneEnd) / 2;
    else if (TEST_OVERRIDES.forceCursor === 'miss') cursor = 0;
    playSound('tap');
    doAction({ type: ACTIONS.RELEASE, cursor });
  });
}

function startTicking(zone) {
  if (!soundOn || TEST_OVERRIDES.fastAnimations) return;
  const iv = { green: 1500, yellow: 950, orange: 600, red: 300 }[zone] || 1500;
  tickTimer = setInterval(() => {
    if (uiLocked || !gameState || gameState.phase === PHASES.PAUSED || gameState.phase === PHASES.FINISHED) return;
    playSound(zone === 'red' ? 'tickFast' : 'tick');
  }, iv);
}

/** ------------------------- تنفيذ الأفعال + الحركات ------------------------- */
async function doAction(action) {
  if (uiLocked || !gameState) return;
  const holderId = gameState.bombHolderId;
  const res = BombGameEngine.applyAction(gameState, holderId, action, nowMs());
  if (!res.ok) return;
  saveGame(gameState);
  const animatable = res.effects.some((e) => e.type !== 'AIM_START');
  if (animatable) {
    uiLocked = true;
    stopLoops();
    try { await playEffects(res.effects); } finally { uiLocked = false; }
  }
  render();
}

function chipEl(pid) { return root.querySelector(`.player-chip[data-pid="${pid}"]`); }
function nameOf(pid) { const p = gameState.players.find((x) => x.id === pid); return p ? p.name : ''; }

function toast(text, kind) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => el.remove(), dur(ANIM.TOAST));
}

async function flyBomb(fromId, toId) {
  const a = chipEl(fromId);
  const b = chipEl(toId);
  if (!a || !b) return;
  const ra = a.getBoundingClientRect();
  const rb = b.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'flying-bomb';
  el.textContent = '💣';
  el.style.left = ra.left + ra.width / 2 + 'px';
  el.style.top = ra.top + ra.height / 2 + 'px';
  document.body.appendChild(el);
  void el.offsetWidth;
  const d = dur(ANIM.FLY);
  el.style.transition = `transform ${d}ms cubic-bezier(.3,.7,.4,1)`;
  el.style.transform = `translate(${rb.left + rb.width / 2 - (ra.left + ra.width / 2)}px, ${rb.top + rb.height / 2 - (ra.top + ra.height / 2)}px) scale(1.25) rotate(360deg)`;
  await sleep(d);
  el.remove();
  b.classList.add('hit');
  setTimeout(() => b.classList.remove('hit'), dur(ANIM.HIT + 100));
}

async function boom(shieldUsed) {
  const o = document.createElement('div');
  o.className = 'boom-overlay';
  o.innerHTML = `<div class="boom-burst">${shieldUsed ? '🛡️' : '💥'}</div>`;
  document.body.appendChild(o);
  root.classList.add('shake');
  playSound(shieldUsed ? 'shieldBreak' : 'explosion');
  await sleep(dur(ANIM.BOOM));
  o.remove();
  root.classList.remove('shake');
}

async function playEffects(effects) {
  for (const e of effects) {
    switch (e.type) {
      case 'SHIELD_BOUGHT':
        playSound('shield');
        toast(`🛡️ ${nameOf(e.who)} اشترى درعًا`, 'good');
        await sleep(dur(ANIM.SHORT));
        break;
      case 'THROW':
        playSound('throw');
        toast(`🎯 ${nameOf(e.from)} رمى القنبلة إلى ${nameOf(e.to)} (+${e.points})`, 'good');
        await flyBomb(e.from, e.to);
        playSound('hit');
        break;
      case 'CONFUSED':
        toast(`😵 ${nameOf(e.who)} مُربَك! رميته الأولى أضيق`, 'warn');
        break;
      case 'SLIP': {
        playSound('slip');
        toast(`💨 فلتت القنبلة من ${nameOf(e.who)}! الخطر ارتفع`, 'bad');
        const bomb = document.getElementById('bomb-emoji');
        if (bomb) bomb.classList.add('slip');
        await sleep(dur(ANIM.SLIP));
        break;
      }
      case 'RED':
        playSound('redAlert');
        toast(`🔴 ${nameOf(e.who)} في المنطقة الحمراء!`, 'bad');
        await sleep(dur(ANIM.SHORT));
        break;
      case 'DEFUSE':
        if (e.success) {
          playSound('defuseSuccess');
          toast(`✅ ${nameOf(e.who)} فكّ الفتيل! (+${e.points}) — القنبلة منهكة الآن`, 'good');
          await sleep(dur(ANIM.SHORT + 250));
        } else {
          toast('❌ فشل فكّ الفتيل!', 'bad');
        }
        break;
      case 'EXPLODE':
        await boom(e.shieldUsed);
        if (e.shieldUsed) toast(`🛡️ الدرع امتص الانفجار عند ${nameOf(e.who)}!`, 'good');
        else if (e.eliminated) { playSound('eliminate'); toast(`💀 ${nameOf(e.who)} خرج!`, 'bad'); await sleep(dur(ANIM.SHORT + 300)); }
        else { playSound('heartLost'); toast(`💔 ${nameOf(e.who)} خسر قلبًا (بقي ${e.heartsLeft})`, 'bad'); await sleep(dur(ANIM.SHORT)); }
        break;
      case 'NEW_BOMB':
        playSound('start');
        toast(`💣 قنبلة جديدة مع ${nameOf(e.holder)}${e.danger >= 50 ? ' — أسخن!' : ''}`, 'warn');
        await sleep(dur(ANIM.NEWBOMB));
        break;
      case 'SUDDEN_DEATH':
        playSound('suddenDeath');
        toast('⚡ وضع الحسم! قلب واحد للجميع، لا دروع، والأحمر = انفجار فوري', 'sudden');
        await sleep(dur(ANIM.SUDDEN));
        break;
      case 'EVENT':
        playSound('event');
        await sleep(dur(ANIM.SHORT - 100));
        break;
      case 'EVENT_RESOLVED':
        if (e.points) toast(`+${e.points} 🏆`, 'good');
        if (e.eventType === 'BOLD_MOMENT' && e.choiceId === 'gamble') { playSound('pointsReveal'); await sleep(dur(ANIM.SHORT)); }
        break;
      case 'WIN':
        playSound('winner');
        toast(`🏆 ${nameOf(e.who)} هو الفائز!`, 'good');
        await sleep(dur(ANIM.SHORT + 300));
        break;
      default:
        break;
    }
  }
}

function getPlayer(id) { return gameState.players.find((p) => p.id === id); }

/** ------------------------- شاشة 5: الفائز ------------------------- */
function renderWinnerScreen() {
  const winner = gameState.players.find((p) => p.id === gameState.winnerId);
  root.innerHTML = `
    <div class="screen winner-screen" id="screen-winner">
      <div class="confetti-emoji">🎉</div>
      <div class="subtitle">الفائز</div>
      <div class="name">${escapeHtml(winner.name)}</div>
      <div class="winner-score">🏆 ${winner.score} نقطة جرأة</div>
      <div class="winner-hearts">${heartsHtml(winner)}</div>
      <div class="btn-grid" style="margin-top:20px;">
        <button class="btn btn-primary" id="new-round">ابدأ دور جديد</button>
        <button class="btn btn-outline" id="exit-game">خروج</button>
      </div>
    </div>
  `;
  root.querySelector('#new-round').addEventListener('click', () => {
    gameState = null;
    setupPlayerCount = null;
    clearGame();
    render();
  });
  root.querySelector('#exit-game').addEventListener('click', async () => {
    gameState = null;
    setupPlayerCount = null;
    clearGame();
    const session = getSession();
    if (session) await apiCall('/api/release', { codeHash: session.codeHash, sessionToken: session.sessionToken });
    clearSession();
    render();
  });
}

/** ------------------------- أدوات مساعدة ------------------------- */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function playSound(name) {
  if (!soundOn) return;
  if (typeof BombSfx !== 'undefined') BombSfx.play(name);
}

/** ------------------------- بدء التطبيق ------------------------- */
(function init() {
  const restored = loadGame();
  if (restored && restored.phase !== PHASES.FINISHED) {
    gameState = restored;
  }
  if (getSession()) startHeartbeat();
  render();
})();
