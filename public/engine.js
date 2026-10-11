/**
 * محرك لعبة "القنبلة" - نسخة "رمية القنبلة"
 * ------------------------------------------
 * JavaScript خالص بدون مكتبات وبدون DOM. يعمل في المتصفح وفي Node.js بنفس الكود.
 *
 * فكرة اللعبة:
 *  - لكل لاعب قلوب (3 للاعبين اثنين، 2 لثلاثة، 1 لأربعة فأكثر). انفجار القنبلة في
 *    يدك يخسّرك قلبًا (أو يكسر درعك). آخر لاعب بقلوب يفوز.
 *  - التمرير مهارة توقيت: يتحرك مؤشر على شريط، ويجب إيقافه داخل "منطقة النجاح".
 *      ⚡ سريعة: منطقة ضيقة جدًا، خطر قليل، وتُربك المستلم (منطقة رميته الأولى أضيق).
 *      🎯 مضبوطة: منطقة متوسطة وخطر متوسط.
 *      🤝 تسليم آمن: شبه مضمون وخطر قليل جدًا لكن لكل لاعب مرتان فقط في الجولة.
 *  - مستوى الخطر له تأثير حقيقي: الأصفر يضيّق مناطق الرمي 20%، البرتقالي 40%، والأحمر يمنع الرمي
 *    ويفرض تحدّي فكّ الفتيل (توقيت أيضًا). فشل الفكّ = انفجار. وفكّ الفتيل ممكن مرة واحدة لكل قنبلة.
 *  - كل انفجار يجعل القنبلة التالية أسخن (خط سير متصاعد: هادئ في البداية، محموم في النهاية).
 *  - النقاط عملة: 20 نقطة تشتري درعًا يمتص انفجارًا واحدًا (درع واحد لكل لاعب في الجولة).
 *  - ضمان إنهاء الجولة: بعد مدة داخلية يبدأ "وضع الحسم" (قلب واحد للجميع، بلا دروع، والأحمر = انفجار فوري).
 *  - لا يوجد أي مؤقت ظاهر للاعبين، والزمن الداخلي لا يُحسب أثناء Pause.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.BombGameEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ----------------------------------------------------------------------
  // مولّد عشوائية قابل للبذر
  // ----------------------------------------------------------------------
  function createRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randRange(rng, min, max) { return min + rng() * (max - min); }
  function randInt(rng, min, max) { return Math.floor(randRange(rng, min, max + 1)); }
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  // ----------------------------------------------------------------------
  // ثوابت التوازن (كلها قابلة للضبط من مكان واحد)
  // ----------------------------------------------------------------------
  const CONST = {
    // عدد القلوب يتناسب عكسيًا مع عدد اللاعبين كي تبقى الجولة بين دقيقتين وثلاث تقريبًا
    // (مقاس بمحاكاة: 3 قلوب للجميع تجعل جولات 4-6 لاعبين تتجاوز 3 دقائق وتنتهي غالبًا بوضع الحسم)
    HEARTS_BY_PLAYERS: { 2: 3, 3: 2, 4: 1, 5: 1, 6: 1 },
    SAFE_HANDOFFS: 2,
    SHIELD_COST: 20,
    SHIELD_MAX_BUY: 1,

    START_DANGER: 20, // أول قنبلة في الجولة
    NEW_BOMB_BASE: 40, // خطر أول قنبلة جديدة بعد انفجار
    NEW_BOMB_STEP: 5, // كل انفجار يجعل القنبلة التالية أسخن بهذا القدر (خط سير متصاعد)
    NEW_BOMB_MAX: 66,
    AFTER_DEFUSE_DANGER: 58,
    SUDDEN_START_DANGER: 50,

    // حدود مناطق الخطر (الأحمر يبدأ عند 80)
    ZONE_YELLOW: 35,
    ZONE_ORANGE: 60,
    ZONE_RED: 80,
    ZONE_SHRINK: { green: 1, yellow: 0.8, orange: 0.6 }, // تضييق منطقة النجاح
    ZONE_POINTS: { green: 2, yellow: 4, orange: 6 }, // الرمية الناجحة في منطقة أخطر = نقاط أكثر
    CONFUSED_FACTOR: 0.75, // المستلم المُربَك: رميته الأولى أضيق 25%

    // width: عرض منطقة النجاح من الشريط (0-1) | period: زمن دورة المؤشر كاملة بالثواني
    THROWS: {
      fast: { width: 0.14, period: 1.1, danger: [9, 14], bonus: 3, shrinkable: true },
      accurate: { width: 0.26, period: 1.4, danger: [15, 22], bonus: 1, shrinkable: true },
      safe: { width: 0.85, period: 2.4, danger: [6, 9], bonus: 0, shrinkable: false },
    },
    SLIP_DANGER: [16, 24], // إفلات القنبلة: الخطر يقفز وتبقى معك
    DEFUSE: { width: 0.16, period: 0.9, points: 10 },

    // ضمانات المدة (بالمللي ثانية، الزمن الداخلي بدون وقت الـPause)
    MIN_ROUND_MS: 31000, // قبل هذا الزمن لا يمكن دخول المنطقة الحمراء (لا انفجار مبكر)
    ESCALATION_MS: [50000, 90000],
    ESCALATION_FACTORS: [1.15, 1.3],
    SUDDEN_DEATH_MS: 160000,
    SUDDEN_FACTOR: 1.5,

    // الأحداث المفاجئة
    EVENT_BASE_CHANCE: 0.12,
    EVENT_DANGER_WEIGHT: 0.004,
    EVENT_MAX_CHANCE: 0.35,
    EVENT_COOLDOWN_TURNS: 3,
    SURGE_DANGER: 10,
    COOL_DANGER: -8,
    POINTS_SURGE_BRAVE: 4,
    POINTS_SURGE_COOL: 2,
    POINTS_BOLD_SAFE: 4,
    POINTS_BOLD_GAMBLE_RANGE: [5, 25],
    BOLD_GAMBLE_DANGER: 10,
    RESTRICT_BACK_THROW_MIN_ALIVE: 4, // مع 4 لاعبين أو أكثر: لا يمكن الرد على من رماها لك مباشرة
  };

  const ACTIONS = Object.freeze({
    START_THROW: 'START_THROW',
    RELEASE: 'RELEASE',
    START_DEFUSE: 'START_DEFUSE',
    BUY_SHIELD: 'BUY_SHIELD',
    RESOLVE_EVENT: 'RESOLVE_EVENT',
  });

  const PHASES = Object.freeze({
    READY: 'READY', // صاحب الدور يختار نوع الرمية والهدف (أو يشتري درعًا)
    AIM: 'AIM', // المؤشر يتحرك: رمية أو فكّ فتيل
    DEFUSE_READY: 'DEFUSE_READY', // المنطقة الحمراء: ممنوع الرمي، يجب فكّ الفتيل
    EVENT_PENDING: 'EVENT_PENDING',
    PAUSED: 'PAUSED',
    FINISHED: 'FINISHED',
  });

  const ZONE_INFO = {
    green: { label: 'آمن', effect: 'مناطق الرمي بحجمها الطبيعي' },
    yellow: { label: 'حذر', effect: 'مناطق الرمي أضيق 20%' },
    orange: { label: 'خطر', effect: 'مناطق الرمي أضيق 40%' },
    red: { label: 'حرج', effect: 'ممنوع الرمي! فكّ الفتيل أو تنفجر' },
  };

  function zoneOf(danger) {
    if (danger >= CONST.ZONE_RED) return 'red';
    if (danger >= CONST.ZONE_ORANGE) return 'orange';
    if (danger >= CONST.ZONE_YELLOW) return 'yellow';
    return 'green';
  }
  function dangerLabel(danger) { return ZONE_INFO[zoneOf(danger)].label; }

  // ----------------------------------------------------------------------
  // أدوات الحالة
  // ----------------------------------------------------------------------
  function pushLog(state, text) {
    state.log.push({ t: Date.now(), text });
    if (state.log.length > 50) state.log.shift();
  }
  function alivePlayers(state) { return state.players.filter((p) => p.alive); }
  function getPlayer(state, id) { return state.players.find((p) => p.id === id); }
  function effectiveElapsed(state, now) {
    const end = state.pausedAt != null ? state.pausedAt : now;
    return end - state.startedAt - state.totalPausedMs;
  }
  function escalationFactor(state, elapsed) {
    if (state.suddenDeath) return CONST.SUDDEN_FACTOR;
    let f = 1;
    for (let i = 0; i < CONST.ESCALATION_MS.length; i++) {
      if (elapsed >= CONST.ESCALATION_MS[i]) f = CONST.ESCALATION_FACTORS[i];
    }
    return f;
  }
  function fail(error) { return { ok: false, error }; }

  /** تغيير الخطر: الزيادات تتضاعف مع الزمن، ولا يمكن دخول الأحمر قبل MIN_ROUND_MS */
  function addDanger(state, amount, now, scale) {
    let a = amount;
    const elapsed = effectiveElapsed(state, now);
    if (scale && a > 0) a *= escalationFactor(state, elapsed);
    let d = Math.max(0, Math.min(100, state.danger + a));
    if (a > 0 && elapsed < CONST.MIN_ROUND_MS) d = Math.min(d, CONST.ZONE_RED - 1);
    state.danger = d;
  }

  function legalTargets(state, playerId) {
    const alive = alivePlayers(state);
    let ids = alive.filter((p) => p.id !== playerId).map((p) => p.id);
    if (state.forcedTargetId && ids.includes(state.forcedTargetId)) return [state.forcedTargetId];
    if (alive.length >= CONST.RESTRICT_BACK_THROW_MIN_ALIVE && state.lastThrowerId) {
      const filtered = ids.filter((id) => id !== state.lastThrowerId);
      if (filtered.length) ids = filtered;
    }
    return ids;
  }

  function throwWidth(state, type, holderId) {
    const spec = CONST.THROWS[type];
    let w = spec.width;
    if (spec.shrinkable) {
      w *= CONST.ZONE_SHRINK[zoneOf(state.danger)] || 1;
      if (state.confusedId === holderId) w *= CONST.CONFUSED_FACTOR;
    }
    return w;
  }

  function canBuyShield(state, player) {
    return (
      !state.suddenDeath &&
      !player.shield &&
      player.shieldsBought < CONST.SHIELD_MAX_BUY &&
      player.score >= CONST.SHIELD_COST
    );
  }

  /** موضع المؤشر (0 = يسار الشريط، 1 = يمينه) - نفس الدالة تُستخدم في الواجهة للرسم وفي المحرك للتحقق */
  function cursorAt(aim, now) {
    const t = Math.max(0, now - aim.startedAt) / 1000;
    const ph = (t / aim.period) % 1;
    return ph < 0.5 ? ph * 2 : 2 - ph * 2;
  }

  // ----------------------------------------------------------------------
  // إنشاء جولة جديدة
  // ----------------------------------------------------------------------
  function createGame(playerNames, seed, now) {
    if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 6) {
      throw new Error('عدد اللاعبين يجب أن يكون بين 2 و 6');
    }
    const usedSeed = seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0;
    const rng = createRng(usedSeed);
    const hearts = CONST.HEARTS_BY_PLAYERS[playerNames.length];
    const players = playerNames.map((name, i) => ({
      id: 'p' + i,
      name: String(name).trim(),
      alive: true,
      hearts,
      maxHearts: hearts,
      shield: false,
      shieldsBought: 0,
      safeHandoffs: CONST.SAFE_HANDOFFS,
      score: 0,
      turnsHeld: 0,
      eliminationReason: null,
    }));
    const first = randInt(rng, 0, players.length - 1);
    players[first].turnsHeld = 1;

    const state = {
      version: 2,
      seed: usedSeed,
      players,
      bombHolderId: players[first].id,
      danger: CONST.START_DANGER,
      phase: PHASES.READY,
      aim: null,
      pendingEvent: null,
      confusedId: null,
      forcedTargetId: null,
      doublePoints: false,
      lastThrowerId: null,
      bombDefused: false, // القنبلة فُكّ فتيلها مرة: الأحمر القادم = انفجار فوري
      suddenDeath: false,
      lastEventAtTurn: -CONST.EVENT_COOLDOWN_TURNS,
      turnCounter: 0,
      explosions: 0,
      startedAt: now != null ? now : Date.now(),
      pausedAt: null,
      totalPausedMs: 0,
      winnerId: null,
      log: [],
    };
    state._rng = rng;
    pushLog(state, `بدأت الجولة. القنبلة الأولى مع ${players[first].name}.`);
    return state;
  }

  // ----------------------------------------------------------------------
  // مسار الدور: بداية الدور، المنطقة الحمراء، الانفجار، قنبلة جديدة
  // ----------------------------------------------------------------------
  function checkWinner(state, fx) {
    const alive = alivePlayers(state);
    if (alive.length === 1) {
      state.phase = PHASES.FINISHED;
      state.winnerId = alive[0].id;
      state.aim = null;
      state.pendingEvent = null;
      fx.push({ type: 'WIN', who: alive[0].id });
      pushLog(state, `الفائز: ${alive[0].name}`);
      return true;
    }
    return false;
  }

  function checkSuddenDeath(state, now, fx) {
    if (state.suddenDeath) return;
    if (effectiveElapsed(state, now) < CONST.SUDDEN_DEATH_MS) return;
    state.suddenDeath = true;
    alivePlayers(state).forEach((p) => { p.hearts = 1; p.shield = false; });
    state.danger = Math.max(state.danger, CONST.SUDDEN_START_DANGER);
    state.forcedTargetId = null;
    state.doublePoints = false;
    fx.push({ type: 'SUDDEN_DEATH' });
    pushLog(state, 'وضع الحسم! قلب واحد لكل لاعب، لا دروع، والأحمر = انفجار فوري.');
  }

  function moveHolder(state, newHolderId) {
    state.bombHolderId = newHolderId;
    state.turnCounter += 1;
    getPlayer(state, newHolderId).turnsHeld += 1;
  }

  function enterRed(state, now, fx) {
    if (state.suddenDeath || state.bombDefused) {
      explode(state, now, fx);
    } else {
      state.phase = PHASES.DEFUSE_READY;
      fx.push({ type: 'RED', who: state.bombHolderId });
      pushLog(state, `${getPlayer(state, state.bombHolderId).name} في المنطقة الحمراء!`);
    }
  }

  /** بعد أي تغيّر في الخطر مع بقاء القنبلة عند نفس اللاعب */
  function afterDangerChange(state, now, fx) {
    if (state.danger >= CONST.ZONE_RED) enterRed(state, now, fx);
    else state.phase = PHASES.READY;
  }

  /** بداية دور جديد لصاحب القنبلة الحالي بعد استلامها */
  function beginTurn(state, now, fx) {
    checkSuddenDeath(state, now, fx);
    state.phase = PHASES.READY;
    if (state.danger >= CONST.ZONE_RED) {
      enterRed(state, now, fx);
      return;
    }
    maybeSpawnEvent(state, fx);
  }

  function explode(state, now, fx) {
    const p = getPlayer(state, state.bombHolderId);
    state.explosions += 1;
    state.aim = null;
    let shieldUsed = false;
    let eliminated = false;
    if (p.shield && !state.suddenDeath) {
      p.shield = false;
      shieldUsed = true;
      pushLog(state, `انفجرت القنبلة عند ${p.name} لكن الدرع امتص الانفجار!`);
    } else {
      p.hearts = Math.max(0, p.hearts - 1);
      if (p.hearts === 0) {
        p.alive = false;
        p.eliminationReason = 'انفجرت القنبلة في يده بعد نفاد قلوبه';
        eliminated = true;
        pushLog(state, `${p.name} خرج!`);
      } else {
        pushLog(state, `انفجرت القنبلة عند ${p.name}! بقي له ${p.hearts} قلب.`);
      }
    }
    fx.push({ type: 'EXPLODE', who: p.id, shieldUsed, heartsLeft: p.hearts, eliminated });
    if (checkWinner(state, fx)) return;
    newBomb(state, fx);
  }

  function newBomb(state, fx) {
    state.danger = state.suddenDeath
      ? CONST.SUDDEN_START_DANGER
      : Math.min(CONST.NEW_BOMB_MAX, CONST.NEW_BOMB_BASE + CONST.NEW_BOMB_STEP * (state.explosions - 1));
    state.confusedId = null;
    state.forcedTargetId = null;
    state.doublePoints = false;
    state.lastThrowerId = null;
    state.bombDefused = false;
    state.aim = null;
    state.pendingEvent = null;
    const alive = alivePlayers(state);
    const minHeld = Math.min(...alive.map((p) => p.turnsHeld));
    const candidates = alive.filter((p) => p.turnsHeld === minHeld);
    const next = pick(state._rng, candidates);
    moveHolder(state, next.id);
    state.phase = PHASES.READY;
    fx.push({ type: 'NEW_BOMB', holder: next.id, danger: state.danger });
    pushLog(state, `قنبلة جديدة مع ${next.name}.`);
  }

  // ----------------------------------------------------------------------
  // الأحداث المفاجئة (عادلة، لها قاعدة واضحة، ولا تقرر الفائز)
  // ----------------------------------------------------------------------
  function maybeSpawnEvent(state, fx) {
    if (state.suddenDeath) return;
    if (state.turnCounter - state.lastEventAtTurn < CONST.EVENT_COOLDOWN_TURNS) return;
    const chance = Math.min(
      CONST.EVENT_MAX_CHANCE,
      CONST.EVENT_BASE_CHANCE + Math.max(0, state.danger - 40) * CONST.EVENT_DANGER_WEIGHT
    );
    if (state._rng() >= chance) return;
    spawnEvent(state, fx);
  }

  function spawnEvent(state, fx) {
    state.lastEventAtTurn = state.turnCounter;
    const holder = getPlayer(state, state.bombHolderId);
    const roll = state._rng();
    let event = null;
    if (roll < 0.4) {
      event = {
        type: 'SURGE',
        title: '⚡ ارتفاع مفاجئ في القنبلة!',
        options: [
          { id: 'brave', label: 'تحمّل الخطر', desc: 'الخطر +10 • +4 نقاط', dangerDelta: CONST.SURGE_DANGER, points: CONST.POINTS_SURGE_BRAVE },
          { id: 'cool', label: 'تبريد القنبلة', desc: 'الخطر −8 • رميتك القادمة أضيق 25% • +2 نقطة', dangerDelta: CONST.COOL_DANGER, points: CONST.POINTS_SURGE_COOL, confuse: true },
        ],
      };
    } else if (roll < 0.7) {
      const targets = legalTargets(state, holder.id);
      if (targets.length >= 2) {
        const tid = pick(state._rng, targets);
        const tname = getPlayer(state, tid).name;
        event = {
          type: 'MALFUNCTION',
          title: '🔒 القنبلة انحشرت!',
          options: [
            { id: 'ok', label: `فهمت — الرمي على ${tname}`, desc: `لازم ترمي على ${tname} • نقاط الرمية ×2`, forcedTargetId: tid, doublePoints: true },
          ],
        };
      }
    }
    if (!event) {
      event = {
        type: 'BOLD_MOMENT',
        title: '🎲 لحظة الجرأة! أمّن رصيدك أم تجازف؟',
        options: [
          { id: 'safe', label: 'أمّن نقاطك', desc: '+4 نقاط مضمونة • بدون أي خطر إضافي', dangerDelta: 0, points: CONST.POINTS_BOLD_SAFE },
          { id: 'gamble', label: 'جازف!', desc: `الخطر +10 • من ${CONST.POINTS_BOLD_GAMBLE_RANGE[0]} إلى ${CONST.POINTS_BOLD_GAMBLE_RANGE[1]} نقطة`, dangerDelta: CONST.BOLD_GAMBLE_DANGER, pointsRange: CONST.POINTS_BOLD_GAMBLE_RANGE },
        ],
      };
    }
    state.pendingEvent = event;
    state.phase = PHASES.EVENT_PENDING;
    fx.push({ type: 'EVENT', eventType: event.type });
    pushLog(state, event.title);
  }

  // ----------------------------------------------------------------------
  // الأفعال المتاحة (تُستخدم لبناء أزرار الواجهة ولا تُعتمد وحدها - applyAction يتحقق مجددًا)
  // ----------------------------------------------------------------------
  function getAvailableActions(state, playerId) {
    if (state.phase === PHASES.PAUSED || state.phase === PHASES.FINISHED) return [];
    if (state.bombHolderId !== playerId) return [];
    const player = getPlayer(state, playerId);
    if (!player || !player.alive) return [];
    const actions = [];
    if (state.phase === PHASES.EVENT_PENDING) {
      return state.pendingEvent.options.map((o) => ({ type: ACTIONS.RESOLVE_EVENT, choiceId: o.id }));
    }
    if (state.phase === PHASES.AIM) return [{ type: ACTIONS.RELEASE }];
    if (canBuyShield(state, player)) actions.push({ type: ACTIONS.BUY_SHIELD });
    if (state.phase === PHASES.DEFUSE_READY) {
      actions.push({ type: ACTIONS.START_DEFUSE });
      return actions;
    }
    legalTargets(state, playerId).forEach((t) => {
      Object.keys(CONST.THROWS).forEach((type) => {
        if (type === 'safe' && player.safeHandoffs <= 0) return;
        actions.push({ type: ACTIONS.START_THROW, throwType: type, targetId: t });
      });
    });
    return actions;
  }

  // ----------------------------------------------------------------------
  // تنفيذ فعل - المكان الوحيد الذي يغيّر الحالة استجابةً للاعب
  // يُعيد { ok, effects[] } أو { ok:false, error }
  // ----------------------------------------------------------------------
  function applyAction(state, playerId, action, now) {
    now = now != null ? now : Date.now();
    if (!action || typeof action.type !== 'string') return fail('فعل غير صالح');
    if (state.phase === PHASES.FINISHED) return fail('الجولة انتهت');
    if (state.phase === PHASES.PAUSED) return fail('اللعبة متوقفة مؤقتًا (Pause)');
    if (state.bombHolderId !== playerId) return fail('ليس دورك الآن');
    const player = getPlayer(state, playerId);
    if (!player || !player.alive) return fail('لاعب غير صالح');

    const fx = [];
    let res;
    switch (state.phase) {
      case PHASES.READY:
      case PHASES.DEFUSE_READY:
        res = applyReadyAction(state, player, action, now, fx);
        break;
      case PHASES.AIM:
        res = applyAimAction(state, player, action, now, fx);
        break;
      case PHASES.EVENT_PENDING:
        res = applyEventAction(state, player, action, now, fx);
        break;
      default:
        res = fail('حالة غير معروفة');
    }
    if (res && res.ok) res.effects = fx;
    return res;
  }

  function applyReadyAction(state, player, action, now, fx) {
    if (action.type === ACTIONS.BUY_SHIELD) {
      if (!canBuyShield(state, player)) return fail('لا يمكنك شراء درع الآن');
      player.score -= CONST.SHIELD_COST;
      player.shield = true;
      player.shieldsBought += 1;
      fx.push({ type: 'SHIELD_BOUGHT', who: player.id });
      pushLog(state, `${player.name} اشترى درعًا 🛡️`);
      return { ok: true };
    }

    if (state.phase === PHASES.DEFUSE_READY) {
      if (action.type !== ACTIONS.START_DEFUSE) return fail('أنت في المنطقة الحمراء: يجب فكّ الفتيل');
      const start = randRange(state._rng, 0.05, 0.95 - CONST.DEFUSE.width);
      state.aim = {
        kind: 'defuse',
        zoneStart: start,
        zoneEnd: start + CONST.DEFUSE.width,
        period: CONST.DEFUSE.period,
        startedAt: now,
      };
      state.phase = PHASES.AIM;
      fx.push({ type: 'AIM_START', kind: 'defuse' });
      return { ok: true };
    }

    if (action.type !== ACTIONS.START_THROW) return fail('فعل غير معروف في هذه المرحلة');
    const spec = CONST.THROWS[action.throwType];
    if (!spec) return fail('نوع رمية غير معروف');
    if (!legalTargets(state, player.id).includes(action.targetId)) return fail('هدف غير قانوني');
    if (action.throwType === 'safe' && player.safeHandoffs <= 0) return fail('انتهت تسليماتك الآمنة');

    const width = throwWidth(state, action.throwType, player.id);
    const start = randRange(state._rng, 0.04, 0.96 - width);
    state.aim = {
      kind: 'throw',
      throwType: action.throwType,
      targetId: action.targetId,
      zoneStart: start,
      zoneEnd: start + width,
      period: spec.period,
      startedAt: now,
      zoneKey: zoneOf(state.danger),
      doubled: state.doublePoints,
      forcedTargetId: state.forcedTargetId,
    };
    if (action.throwType === 'safe') player.safeHandoffs -= 1;
    state.confusedId = state.confusedId === player.id ? null : state.confusedId;
    state.forcedTargetId = null;
    state.doublePoints = false;
    state.phase = PHASES.AIM;
    fx.push({ type: 'AIM_START', kind: 'throw', throwType: action.throwType });
    return { ok: true };
  }

  function applyAimAction(state, player, action, now, fx) {
    if (action.type !== ACTIONS.RELEASE) return fail('يجب إيقاف المؤشر الآن');
    const c = action.cursor;
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) return fail('موضع المؤشر غير صالح');
    const a = state.aim;
    const hit = c >= a.zoneStart && c <= a.zoneEnd;
    state.aim = null;

    if (a.kind === 'defuse') {
      if (hit) {
        state.danger = CONST.AFTER_DEFUSE_DANGER;
        state.bombDefused = true;
        player.score += CONST.DEFUSE.points;
        state.phase = PHASES.READY;
        fx.push({ type: 'DEFUSE', who: player.id, success: true, points: CONST.DEFUSE.points });
        pushLog(state, `${player.name} فكّ الفتيل بنجاح! (+${CONST.DEFUSE.points} نقطة)`);
      } else {
        fx.push({ type: 'DEFUSE', who: player.id, success: false });
        pushLog(state, `${player.name} فشل في فكّ الفتيل!`);
        explode(state, now, fx);
      }
      return { ok: true };
    }

    const spec = CONST.THROWS[a.throwType];
    const dangerBefore = state.danger;
    if (hit) {
      addDanger(state, randRange(state._rng, spec.danger[0], spec.danger[1]), now, true);
      let pts = CONST.ZONE_POINTS[a.zoneKey] + spec.bonus;
      if (a.doubled) pts *= 2;
      player.score += pts;
      fx.push({ type: 'THROW', from: player.id, to: a.targetId, throwType: a.throwType, points: pts, dangerBefore, dangerAfter: state.danger });
      pushLog(state, `${player.name} رمى القنبلة إلى ${getPlayer(state, a.targetId).name} (+${pts})`);
      state.lastThrowerId = player.id;
      if (a.throwType === 'fast') {
        state.confusedId = a.targetId;
        fx.push({ type: 'CONFUSED', who: a.targetId });
      }
      moveHolder(state, a.targetId);
      beginTurn(state, now, fx);
    } else {
      addDanger(state, randRange(state._rng, CONST.SLIP_DANGER[0], CONST.SLIP_DANGER[1]), now, true);
      state.forcedTargetId = a.forcedTargetId || null;
      state.doublePoints = !!a.doubled;
      fx.push({ type: 'SLIP', who: player.id, throwType: a.throwType, dangerBefore, dangerAfter: state.danger });
      pushLog(state, `${player.name} أفلتت منه القنبلة!`);
      afterDangerChange(state, now, fx);
    }
    return { ok: true };
  }

  function applyEventAction(state, player, action, now, fx) {
    if (action.type !== ACTIONS.RESOLVE_EVENT) return fail('يجب الرد على الحدث الحالي');
    const choice = state.pendingEvent.options.find((o) => o.id === action.choiceId);
    if (!choice) return fail('خيار غير صالح');
    let pts = choice.points || 0;
    if (choice.pointsRange) pts = randInt(state._rng, choice.pointsRange[0], choice.pointsRange[1]);
    if (choice.dangerDelta) addDanger(state, choice.dangerDelta, now, false);
    if (choice.confuse) state.confusedId = player.id;
    if (choice.forcedTargetId) {
      state.forcedTargetId = choice.forcedTargetId;
      state.doublePoints = !!choice.doublePoints;
    }
    player.score += pts;
    fx.push({ type: 'EVENT_RESOLVED', who: player.id, eventType: state.pendingEvent.type, choiceId: choice.id, points: pts });
    pushLog(state, `${player.name} اختار: ${choice.label}` + (pts ? ` (+${pts})` : ''));
    state.pendingEvent = null;
    afterDangerChange(state, now, fx);
    return { ok: true };
  }

  // ------------------------- Pause / Resume -------------------------
  function pauseGame(state, now) {
    now = now != null ? now : Date.now();
    if (state.phase === PHASES.PAUSED || state.phase === PHASES.FINISHED) return { ok: false };
    state._phaseBeforePause = state.phase;
    state.phase = PHASES.PAUSED;
    state.pausedAt = now;
    pushLog(state, 'تم إيقاف اللعبة مؤقتًا (Pause).');
    return { ok: true };
  }

  function resumeGame(state, now) {
    now = now != null ? now : Date.now();
    if (state.phase !== PHASES.PAUSED) return { ok: false };
    const paused = Math.max(0, now - state.pausedAt);
    state.totalPausedMs += paused;
    if (state.aim) state.aim.startedAt += paused; // المؤشر يكمل من نفس موضعه تمامًا
    state.pausedAt = null;
    state.phase = state._phaseBeforePause || PHASES.READY;
    delete state._phaseBeforePause;
    pushLog(state, 'استؤنفت اللعبة.');
    return { ok: true };
  }

  // ------------------------- عرض للواجهة -------------------------
  function getPublicView(state, forPlayerId) {
    const zone = zoneOf(state.danger);
    const holder = getPlayer(state, state.bombHolderId);
    const preview = {};
    Object.keys(CONST.THROWS).forEach((type) => {
      preview[type] = {
        widthPct: Math.round(throwWidth(state, type, state.bombHolderId) * 100),
        available: type !== 'safe' || holder.safeHandoffs > 0,
      };
    });
    return {
      players: state.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        hearts: p.hearts,
        maxHearts: p.maxHearts,
        shield: p.shield,
        safeHandoffs: p.safeHandoffs,
        score: p.score,
        isHolder: p.id === state.bombHolderId,
        eliminationReason: p.eliminationReason,
      })),
      zone,
      dangerLabel: ZONE_INFO[zone].label,
      zoneEffect: (state.suddenDeath || state.bombDefused) && zone === 'red' ? 'انفجار فوري!' : ZONE_INFO[zone].effect,
      bombDefused: state.bombDefused,
      dangerPct: Math.round(state.danger),
      phase: state.phase,
      suddenDeath: state.suddenDeath,
      pendingEvent: state.pendingEvent
        ? { type: state.pendingEvent.type, title: state.pendingEvent.title, options: state.pendingEvent.options.map((o) => ({ id: o.id, label: o.label, desc: o.desc })) }
        : null,
      aim: state.aim ? Object.assign({}, state.aim) : null,
      confused: state.confusedId === state.bombHolderId,
      forcedTargetId: state.forcedTargetId,
      blockedBackTargetId:
        !state.forcedTargetId && state.lastThrowerId && alivePlayers(state).length >= CONST.RESTRICT_BACK_THROW_MIN_ALIVE &&
        getPlayer(state, state.lastThrowerId).alive
          ? state.lastThrowerId
          : null,
      doublePoints: state.doublePoints,
      throwPreview: preview,
      canBuyShield: holder.alive ? canBuyShield(state, holder) : false,
      shieldCost: CONST.SHIELD_COST,
      winnerId: state.winnerId,
      bombHolderId: state.bombHolderId,
      availableActions: forPlayerId ? getAvailableActions(state, forPlayerId) : [],
      recentLog: state.log.slice(-5).map((l) => l.text),
    };
  }

  // ------------------------- تسلسل/استعادة (لدعم Refresh) -------------------------
  function serialize(state) {
    const clone = Object.assign({}, state);
    delete clone._rng;
    return JSON.stringify(clone);
  }

  function deserialize(json) {
    const state = JSON.parse(json);
    const derived = ((state.seed || 0) ^ Math.imul(state.turnCounter + 1, 2654435761) ^ Math.imul(state.explosions + 7, 40503)) >>> 0;
    state._rng = createRng(derived);
    return state;
  }

  return {
    CONST,
    ACTIONS,
    PHASES,
    ZONE_INFO,
    createGame,
    applyAction,
    getAvailableActions,
    getPublicView,
    pauseGame,
    resumeGame,
    serialize,
    deserialize,
    cursorAt,
    zoneOf,
    dangerLabel,
    _internal: { createRng, alivePlayers, effectiveElapsed, legalTargets, throwWidth },
  };
});
