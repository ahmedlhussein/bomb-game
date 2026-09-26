'use strict';
/**
 * تطبيق واجهة "القنبلة" - يربط محرك اللعبة (engine.js) بالشاشات وبالـ Backend الحقيقي.
 * ملف JS خالص بدون أي إطار عمل أو مكتبة خارجية.
 *
 * التحقق من صيغة الكود محليًا (6 خانات) هو فحص شكلي سريع فقط لتحسين تجربة الاستخدام؛
 * التحقق الحقيقي من الأكواد الفعلية يتم دائمًا عبر /api/verify-code (انظر lib/codeAuth.js)،
 * ولا يظهر أي كود حقيقي أو هاش له في هذا الملف أو في أي كود يصل المتصفح.
 */

const STORAGE_KEY = 'bombgame_state_v1';
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
    return BombGameEngine.deserialize(raw);
  } catch (e) { return null; }
}
function clearGame() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* تجاهل */ }
}

/** ------------------------- حالة التطبيق ------------------------- */
let gameState = null;
let setupPlayerCount = null;
let selectedActionType = 'PASS_NORMAL';

function render() {
  const saved = gameState ? true : false;
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
    gameState = BombGameEngine.createGame(names, undefined, Date.now());
    saveGame(gameState);
    playSound('start');
    render();
  });
}

/** ------------------------- شاشة 4: اللعب ------------------------- */
const DANGER_CLASS = { 'منخفض': 'low', 'متوسط': 'mid', 'مرتفع': 'high', 'حرج': 'crit' };
const WIRE_CLASS = { 'أحمر': 'wire-red', 'أزرق': 'wire-blue', 'أصفر': 'wire-yellow' };

function renderGameScreen() {
  const view = BombGameEngine.getPublicView(gameState, gameState.bombHolderId);
  const holder = gameState.players.find((p) => p.id === gameState.bombHolderId);
  const isPaused = gameState.phase === BombGameEngine.PHASES.PAUSED;
  const dClass = DANGER_CLASS[view.dangerLabel] || 'low';
  const bombLevelClass = 'level-' + dClass;

  root.innerHTML = `
    <div class="screen game-screen" id="screen-game">
      <div class="top-bar">
        <button class="pause-btn" id="pause-btn" aria-label="Pause">⏸</button>
        <div class="players-strip-title" style="color:var(--text-dim);font-size:13px;">القنبلة</div>
        <button class="sound-btn" id="sound-btn" aria-label="Sound">${soundOn ? '🔊' : '🔇'}</button>
      </div>

      <div class="holder-banner">
        <div class="label">دور اللاعب الآن</div>
        <div class="name">${escapeHtml(holder.name)} — دورك الآن</div>
      </div>

      <div class="bomb-wrap">
        <div class="bomb ${bombLevelClass}" id="bomb-emoji">💣</div>
        <div class="danger-label ${dClass}">مستوى الخطر: ${view.dangerLabel}</div>
      </div>

      <div class="players-strip" id="players-strip">
        ${view.players.map((p) => `<div class="player-chip ${p.isHolder ? 'holder' : ''} ${!p.alive ? 'dead' : ''}">${escapeHtml(p.name)}${p.alive ? ' (هادئ×' + p.calmCharges + ')' : ' - خرج'}</div>`).join('')}
      </div>

      <div class="log-line" id="log-line">${view.recentLog.length ? escapeHtml(view.recentLog[view.recentLog.length - 1]) : ''}</div>

      <div class="actions-area" id="actions-area"></div>
    </div>
    ${isPaused ? `
      <div class="pause-overlay" id="pause-overlay">
        <div class="title-brand">توقف مؤقت</div>
        <div class="subtitle">اللعبة متوقفة الآن</div>
        <button class="btn btn-primary" id="resume-btn" style="max-width:220px;">استئناف</button>
      </div>` : ''}
  `;

  root.querySelector('#pause-btn').addEventListener('click', () => {
    BombGameEngine.pauseGame(gameState, Date.now());
    saveGame(gameState);
    render();
  });
  root.querySelector('#sound-btn').addEventListener('click', () => {
    soundOn = !soundOn;
    render();
  });
  if (isPaused) {
    root.querySelector('#resume-btn').addEventListener('click', () => {
      BombGameEngine.resumeGame(gameState, Date.now());
      saveGame(gameState);
      render();
    });
    return; // لا نعرض أي أفعال Gameplay أثناء الإيقاف
  }

  renderActionsArea(view, holder);
}

function renderActionsArea(view, holder) {
  const area = root.querySelector('#actions-area');

  if (gameState.phase === BombGameEngine.PHASES.CRITICAL_PENDING) {
    const wires = view.puzzle;
    area.innerHTML = `
      <div class="event-banner">
        <h3>⚠️ اللحظة الحرجة! اختر السلك المختلف عن الباقي</h3>
        <div class="puzzle-wires" id="wires">
          ${wires.map((w, i) => `<button class="wire-btn ${WIRE_CLASS[w]}" data-i="${i}">سلك ${i + 1}</button>`).join('')}
        </div>
      </div>
    `;
    area.querySelectorAll('.wire-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wireIndex = Number(btn.dataset.i);
        const res = BombGameEngine.applyAction(gameState, holder.id, { type: BombGameEngine.ACTIONS.DEFUSE_ATTEMPT, wireIndex }, Date.now());
        if (res.ok) { playSound(res.success ? 'defuseSuccess' : 'eliminate'); saveGame(gameState); render(); }
      });
    });
    return;
  }

  if (gameState.phase === BombGameEngine.PHASES.EVENT_PENDING) {
    area.innerHTML = `
      <div class="event-banner">
        <h3>${escapeHtml(view.pendingEvent.title)}</h3>
        <div class="btn-grid" id="event-options">
          ${view.pendingEvent.options.map((o) => `<button class="btn btn-secondary" data-id="${o.id}">${escapeHtml(o.label)}</button>`).join('')}
        </div>
      </div>
    `;
    area.querySelectorAll('#event-options button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const res = BombGameEngine.applyAction(gameState, holder.id, { type: BombGameEngine.ACTIONS.RESOLVE_EVENT, choiceId: btn.dataset.id }, Date.now());
        if (res.ok) { playSoundAfterAction(); saveGame(gameState); render(); }
      });
    });
    return;
  }

  // مرحلة اللعب العادية: اختيار نوع التمرير ثم الهدف
  const actions = view.availableActions;
  const types = [
    { key: 'PASS_NORMAL', label: 'تمرير عادي' },
    { key: 'PASS_CALM', label: 'تمرير هادئ' },
    { key: 'PASS_BOLD', label: 'تمرير جريء' },
  ].filter((t) => actions.some((a) => a.type === t.key));

  if (!types.some((t) => t.key === selectedActionType)) selectedActionType = types[0].key;

  const targets = actions.filter((a) => a.type === selectedActionType);

  area.innerHTML = `
    <div class="action-type-tabs" id="type-tabs">
      ${types.map((t) => `<button class="btn ${t.key === selectedActionType ? 'selected' : ''}" data-type="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div class="target-select" id="target-select">
      ${targets.map((a) => `<button class="btn btn-outline" data-target="${a.targetId}">مرّر إلى ${escapeHtml(getPlayer(a.targetId).name)}</button>`).join('')}
    </div>
  `;
  area.querySelectorAll('#type-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => { selectedActionType = btn.dataset.type; renderActionsArea(view, holder); });
  });
  area.querySelectorAll('#target-select button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const res = BombGameEngine.applyAction(gameState, holder.id, { type: selectedActionType, targetId: btn.dataset.target }, Date.now());
      if (res.ok) { playSoundAfterAction(); saveGame(gameState); render(); }
    });
  });
}

function playSoundAfterAction() {
  if (gameState.phase === BombGameEngine.PHASES.CRITICAL_PENDING) playSound('criticalWarning');
  else if (gameState.phase === BombGameEngine.PHASES.EVENT_PENDING) playSound('event');
  else if (gameState.phase === BombGameEngine.PHASES.FINISHED) playSound('winner');
  else playSound('pass');
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
  if (restored && restored.phase !== BombGameEngine.PHASES.FINISHED) {
    gameState = restored;
  }
  if (getSession()) startHeartbeat();
  render();
})();
