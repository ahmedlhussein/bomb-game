/**
 * محرك لعبة "القنبلة" - Game Engine
 * ---------------------------------
 * ملف JavaScript خالص، بدون أي مكتبات خارجية، وبدون أي تعامل مع DOM.
 * يعمل في المتصفح (عبر <script>) وفي Node.js (للاختبارات الآلية) بنفس الكود تمامًا.
 *
 * فلسفة التصميم: مهارة + توقيت + قراءة الموقف + عدم توقع منضبط.
 * - لا يوجد أي عملية "اختيار خاسر عشوائيًا".
 * - أي إقصاء يحدث فقط نتيجة فشل قرار محدد (محاولة نزع فتيل) اتخذه اللاعب صاحب القنبلة.
 * - كل الأرقام العشوائية تُسحب من مولّد عشوائية قابل للبذر (seed) لضمان إمكانية إعادة الاختبار.
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
  // مولّد عشوائية قابل للبذر (mulberry32) - لا يعتمد على Math.random حتى تكون
  // الاختبارات قابلة للتكرار بالضبط.
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

  function randRange(rng, min, max) {
    return min + rng() * (max - min);
  }

  function randInt(rng, min, max) {
    return Math.floor(randRange(rng, min, max + 1));
  }

  function pick(rng, arr) {
    return arr[Math.floor(rng() * arr.length)];
  }

  // ----------------------------------------------------------------------
  // ثوابت التوازن (Balance Constants)
  // تم اختيارها وضبطها عبر محاكاة آلاف الجولات (انظر tests/simulate.js)
  // بحيث:
  //   - أقل مدة طبيعية للجولة >= 30 ثانية.
  //   - كل المسارات الطبيعية تنتهي خلال أقل من 5 دقائق.
  // ----------------------------------------------------------------------
  const CONST = {
    START_DANGER: 20,
    CRITICAL_MIN: 82, // نطاق عتبة "اللحظة الحرجة" يختلف كل جولة (غير متوقع لكنه عادل)
    CRITICAL_MAX: 94,
    CALM_CHARGES_PER_PLAYER: 2,
    CALM_DELTA: [4, 9],
    NORMAL_DELTA: [9, 15],
    BOLD_DELTA: [16, 24],
    BOLD_COOLDOWN_TURNS: 2, // بعد التمرير الجريء، التصاعد أهدأ للاعبين التاليين (نتيجة منطقية للقرار)
    BOLD_COOLDOWN_FACTOR: 0.55,
    EVENT_BASE_CHANCE: 0.08, // فرصة أساسية لحدث عشوائي عادل بعد كل تمريرة
    EVENT_DANGER_WEIGHT: 0.006, // كل نقطة خطر فوق المتوسط تزيد فرصة الحدث
    EVENT_COOLDOWN_TURNS: 2, // لا يتكرر حدث مباشرة بعد آخر حدث
    TIME_ESCALATION_MS: [60000, 150000, 240000], // نقاط تسريع داخلية بالمللي ثانية (لا تُعرض للاعب أبدًا)
    TIME_ESCALATION_FACTORS: [1.15, 1.35, 1.7],
    RESTRICTED_TARGET_MEMORY: 2, // "خلل القنبلة": يمنع تكرار نفس الهدف خلال آخر عدد أدوار
    DEFUSE_OPTIONS_COUNT: 4,
    MIN_ROUND_MS: 31000, // لا يمكن الوصول لـ"اللحظة الحرجة" قبل مرور هذه المدة الداخلية (هامش أمان فوق 30 ثانية)
    DANGER_CAP_BEFORE_MIN: 96,
    TIME_FATIGUE_START_MS: 140000, // من هذه اللحظة الداخلية فصاعدًا، يبدأ ضمان زمني إضافي لإنهاء الجولة
    TIME_FATIGUE_FULL_MS: 190000, // عند هذه اللحظة، فرصة الإفلات تصل 100% (هامش أمان كافٍ قبل حد الـ5 دقائق)
    HARD_ROUND_CUTOFF_MS: 210000, // ضمان صارم غير احتمالي إطلاقًا: بعد هذه اللحظة، لا يمكن أن ينجح نزع الفتيل مهما حدث (هامش ~90 ثانية قبل حد الـ5 دقائق لاستيعاب إقصاءات متتالية عند عدد لاعبين كبير)
  };

  const ACTIONS = Object.freeze({
    PASS_NORMAL: 'PASS_NORMAL',
    PASS_CALM: 'PASS_CALM',
    PASS_BOLD: 'PASS_BOLD',
    RESOLVE_EVENT: 'RESOLVE_EVENT',
    DEFUSE_ATTEMPT: 'DEFUSE_ATTEMPT',
  });

  const PHASES = Object.freeze({
    PLAYING: 'PLAYING',
    EVENT_PENDING: 'EVENT_PENDING',
    CRITICAL_PENDING: 'CRITICAL_PENDING',
    PAUSED: 'PAUSED',
    FINISHED: 'FINISHED',
  });

  function dangerLabel(danger) {
    // تصنيف نوعي فقط - لا رقم دقيق يُعرض للاعب أبدًا
    if (danger < 35) return 'منخفض';
    if (danger < 60) return 'متوسط';
    if (danger < 82) return 'مرتفع';
    return 'حرج';
  }

  /**
   * إنشاء جولة جديدة. كل جولة مستقلة تمامًا (بذرة عشوائية جديدة، حالة جديدة).
   * @param {string[]} playerNames - 2 إلى 6 أسماء
   * @param {number} seed - بذرة عشوائية (اختيارية، لأغراض الاختبار)
   * @param {number} now - وقت البداية الداخلي (ms) - قابل للحقن للاختبار
   */
  function createGame(playerNames, seed, now) {
    if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 6) {
      throw new Error('عدد اللاعبين يجب أن يكون بين 2 و 6');
    }
    const rng = createRng(seed != null ? seed : (Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
    const players = playerNames.map((name, i) => ({
      id: 'p' + i,
      name: String(name).trim(),
      alive: true,
      calmCharges: CONST.CALM_CHARGES_PER_PLAYER,
      eliminationReason: null,
      turnsHeld: 0,
    }));

    // اختيار حامل القنبلة الأول بعدالة: عشوائي بحت من بذرة الجولة، لا ميزة لأول/آخر اسم.
    const firstHolderIndex = randInt(rng, 0, players.length - 1);

    const state = {
      version: 1,
      seed: seed,
      players,
      order: players.map((p) => p.id),
      bombHolderId: players[firstHolderIndex].id,
      danger: CONST.START_DANGER,
      criticalThreshold: randInt(rng, CONST.CRITICAL_MIN, CONST.CRITICAL_MAX),
      phase: PHASES.PLAYING,
      pendingEvent: null,
      boldCooldownTurnsLeft: 0,
      lastEventAtTurn: -CONST.EVENT_COOLDOWN_TURNS,
      turnCounter: 0,
      recentTargets: [], // لآلية "خلل القنبلة" - منع تكرار نفس الهدف
      defuseSuccessStreak: 0, // صمّام أمان ضد الحلقات اللانهائية النظرية (انظر resolveDefuse)
      startedAt: now != null ? now : Date.now(),
      pausedAt: null,
      totalPausedMs: 0,
      winnerId: null,
      log: [],
      _rngState: seed != null ? seed : 0,
    };
    // نخزن الـ rng نفسه خارج الحالة القابلة للتسلسل (serializable) في سجل منفصل عند الحاجة،
    // لكن لإعادة البناء بعد Refresh نعيد إنشاء rng من seed + عدد الاستدعاءات (turnCounter كتقريب كافٍ عمليًا،
    // لأن كل الحسابات العشوائية اللاحقة تُشتق من حالة السجل وليس من استمرارية rng الدقيقة).
    state._rng = rng;
    pushLog(state, `بدأت الجولة. القنبلة الأولى مع ${players[firstHolderIndex].name}.`);
    return state;
  }

  function pushLog(state, text) {
    state.log.push({ t: Date.now(), text });
    if (state.log.length > 50) state.log.shift();
  }

  function alivePlayers(state) {
    return state.players.filter((p) => p.alive);
  }

  function getPlayer(state, id) {
    return state.players.find((p) => p.id === id);
  }

  function effectiveElapsed(state, now) {
    const end = state.pausedAt != null ? state.pausedAt : now;
    return end - state.startedAt - state.totalPausedMs;
  }

  function escalationFactor(elapsedMs) {
    let f = 1;
    for (let i = 0; i < CONST.TIME_ESCALATION_MS.length; i++) {
      if (elapsedMs >= CONST.TIME_ESCALATION_MS[i]) f = CONST.TIME_ESCALATION_FACTORS[i];
    }
    return f;
  }

  function legalTargets(state, forPlayerId) {
    return alivePlayers(state)
      .filter((p) => p.id !== forPlayerId)
      .filter((p) => !state.recentTargets.slice(-CONST.RESTRICTED_TARGET_MEMORY).includes(p.id) || alivePlayers(state).length <= CONST.RESTRICTED_TARGET_MEMORY)
      .map((p) => p.id);
  }

  /**
   * الأفعال المتاحة حاليًا لصاحب الدور - تُستخدم في الواجهة لتوليد الأزرار،
   * ولمنع أي فعل غير قانوني من جهة العميل (يُعاد التحقق منه في applyAction أيضًا).
   */
  function getAvailableActions(state, playerId) {
    if (state.phase === PHASES.PAUSED || state.phase === PHASES.FINISHED) return [];
    if (state.bombHolderId !== playerId) return [];
    const player = getPlayer(state, playerId);
    if (!player || !player.alive) return [];

    if (state.phase === PHASES.CRITICAL_PENDING) {
      return [{ type: ACTIONS.DEFUSE_ATTEMPT }];
    }
    if (state.phase === PHASES.EVENT_PENDING) {
      return (state.pendingEvent.options || [])
        .filter((o) => !o.costsCalm || player.calmCharges > 0)
        .map((o) => ({ type: ACTIONS.RESOLVE_EVENT, choiceId: o.id }));
    }
    const targets = legalTargets(state, playerId);
    const actions = [];
    targets.forEach((t) => {
      actions.push({ type: ACTIONS.PASS_NORMAL, targetId: t });
      if (player.calmCharges > 0) actions.push({ type: ACTIONS.PASS_CALM, targetId: t });
      actions.push({ type: ACTIONS.PASS_BOLD, targetId: t });
    });
    return actions;
  }

  function checkWinner(state) {
    const alive = alivePlayers(state);
    if (alive.length === 1) {
      state.phase = PHASES.FINISHED;
      state.winnerId = alive[0].id;
      pushLog(state, `الفائز: ${alive[0].name}`);
      return true;
    }
    return false;
  }

  function triggerCritical(state) {
    state.phase = PHASES.CRITICAL_PENDING;
    // نولّد اللغز فورًا هنا (وليس لاحقًا عند العرض) حتى يُحفَظ ضمن أول serialize() ممكن بعد هذه
    // اللحظة مباشرة - إذا تأخّر التوليد إلى وقت العرض فقط، قد يُحفَظ Refresh للحالة قبل توليد
    // اللغز، فيُعاد توليد لغز مختلف بعد الاستعادة (تم اكتشاف هذا كخطأ فعلي أثناء اختبار المتصفح
    // الحقيقي وتم إصلاحه هنا).
    state._pendingPuzzle = generateDefusePuzzle(state._rng);
    pushLog(state, `القنبلة وصلت لحالة حرجة عند ${getPlayer(state, state.bombHolderId).name}!`);
  }

  function maybeTriggerEvent(state, now) {
    const elapsed = effectiveElapsed(state, now);
    const turnsSinceEvent = state.turnCounter - state.lastEventAtTurn;
    if (turnsSinceEvent < CONST.EVENT_COOLDOWN_TURNS) return false;
    const dangerAbove = Math.max(0, state.danger - 40);
    let chance = CONST.EVENT_BASE_CHANCE + dangerAbove * CONST.EVENT_DANGER_WEIGHT;
    chance *= escalationFactor(elapsed);
    chance = Math.min(chance, 0.6);
    if (state._rng() < chance) {
      spawnEvent(state);
      return true;
    }
    return false;
  }

  function spawnEvent(state) {
    state.lastEventAtTurn = state.turnCounter;
    const holder = getPlayer(state, state.bombHolderId);
    const roll = state._rng();
    if (roll < 0.5) {
      // ارتفاع مفاجئ: قرار "شجاعة/حذر" - كلاهما مفهوم ومعلن السبب
      state.pendingEvent = {
        type: 'SURGE',
        title: 'ارتفاع مفاجئ في القنبلة!',
        options: [
          { id: 'brave', label: 'تحمّل الخطر', dangerDelta: 6 },
          { id: 'careful', label: 'تهدئة حذرة', dangerDelta: -4, costsCalm: true },
        ],
      };
    } else {
      // خلل في القنبلة: يقيّد اختيار الهدف مؤقتًا (تحدٍ إضافي، ليس عقابًا عشوائيًا)
      const targets = legalTargets(state, holder.id);
      const forced = targets.length > 0 ? [pick(state._rng, targets)] : [];
      state.pendingEvent = {
        type: 'MALFUNCTION',
        title: 'خلل في القنبلة! التمرير مقيّد هذه المرة',
        options: forced.map((tid) => ({ id: 'to_' + tid, label: 'مرّر إلى ' + getPlayer(state, tid).name, targetId: tid, dangerDelta: 5 })),
      };
      if (state.pendingEvent.options.length === 0) {
        // لا يوجد هدف صالح - نلغي الحدث فورًا (حالة نادرة عند لاعبَين فقط)
        state.pendingEvent = null;
        return;
      }
    }
    state.phase = PHASES.EVENT_PENDING;
    pushLog(state, state.pendingEvent.title);
  }

  function advanceTurn(state, newHolderId, now) {
    state.bombHolderId = newHolderId;
    state.recentTargets.push(newHolderId);
    if (state.recentTargets.length > 5) state.recentTargets.shift();
    state.turnCounter += 1;
    const p = getPlayer(state, newHolderId);
    p.turnsHeld += 1;
    if (state.boldCooldownTurnsLeft > 0) state.boldCooldownTurnsLeft -= 1;

    const elapsed = effectiveElapsed(state, now != null ? now : Date.now());
    if (elapsed < CONST.MIN_ROUND_MS) {
      // نضمن ألا تنتهي الجولة قبل الحد الأدنى الطبيعي، دون كشف أي مؤقت للاعب
      state.danger = Math.min(state.danger, CONST.DANGER_CAP_BEFORE_MIN);
    } else if (state.danger >= state.criticalThreshold) {
      triggerCritical(state);
    }
  }

  function applyDangerDelta(state, delta) {
    let d = delta;
    if (state.boldCooldownTurnsLeft > 0) d *= CONST.BOLD_COOLDOWN_FACTOR;
    state.danger = Math.max(0, Math.min(100, state.danger + d));
  }

  /**
   * تنفيذ فعل. يُعيد { ok: true } أو { ok: false, error }.
   * هذه الدالة الوحيدة المخوّلة بتغيير الحالة استجابةً لفعل لاعب - كل التحقق من الشرعية هنا.
   */
  function applyAction(state, playerId, action, now) {
    now = now != null ? now : Date.now();
    if (state.phase === PHASES.FINISHED) return { ok: false, error: 'الجولة انتهت' };
    if (state.phase === PHASES.PAUSED) return { ok: false, error: 'اللعبة متوقفة مؤقتًا (Pause)' };
    if (state.bombHolderId !== playerId) return { ok: false, error: 'ليس دورك الآن' };
    const player = getPlayer(state, playerId);
    if (!player || !player.alive) return { ok: false, error: 'لاعب غير صالح' };

    if (state.phase === PHASES.CRITICAL_PENDING) {
      if (action.type !== ACTIONS.DEFUSE_ATTEMPT) return { ok: false, error: 'يجب محاولة نزع الفتيل الآن' };
      return resolveDefuse(state, player, action, now);
    }

    if (state.phase === PHASES.EVENT_PENDING) {
      if (action.type !== ACTIONS.RESOLVE_EVENT) return { ok: false, error: 'يجب الرد على الحدث الحالي' };
      const choice = (state.pendingEvent.options || []).find((o) => o.id === action.choiceId);
      if (!choice) return { ok: false, error: 'خيار غير صالح' };
      if (choice.costsCalm && player.calmCharges <= 0) return { ok: false, error: 'لا تملك محاولات تهدئة كافية' };
      if (choice.costsCalm) player.calmCharges -= 1;
      applyDangerDelta(state, choice.dangerDelta || 0);
      pushLog(state, `${player.name} اختار: ${choice.label}`);
      state.pendingEvent = null;
      const nextHolder = choice.targetId || state.bombHolderId;
      state.phase = PHASES.PLAYING;
      advanceTurn(state, nextHolder, now);
      if (state.phase === PHASES.PLAYING) maybeTriggerEvent(state, now);
      checkWinner(state);
      return { ok: true };
    }

    // PLAYING phase: أفعال التمرير
    if (![ACTIONS.PASS_NORMAL, ACTIONS.PASS_CALM, ACTIONS.PASS_BOLD].includes(action.type)) {
      return { ok: false, error: 'فعل غير معروف في هذه المرحلة' };
    }
    const targets = legalTargets(state, playerId);
    if (!targets.includes(action.targetId)) return { ok: false, error: 'هدف غير قانوني' };

    let delta;
    if (action.type === ACTIONS.PASS_NORMAL) {
      delta = randRange(state._rng, CONST.NORMAL_DELTA[0], CONST.NORMAL_DELTA[1]);
    } else if (action.type === ACTIONS.PASS_CALM) {
      if (player.calmCharges <= 0) return { ok: false, error: 'لا تملك تمريرات هادئة متبقية' };
      player.calmCharges -= 1;
      delta = randRange(state._rng, CONST.CALM_DELTA[0], CONST.CALM_DELTA[1]);
    } else {
      delta = randRange(state._rng, CONST.BOLD_DELTA[0], CONST.BOLD_DELTA[1]);
      state.boldCooldownTurnsLeft = CONST.BOLD_COOLDOWN_TURNS;
    }
    applyDangerDelta(state, delta);
    const targetName = getPlayer(state, action.targetId).name;
    pushLog(state, `${player.name} مرّر القنبلة إلى ${targetName}`);
    advanceTurn(state, action.targetId, now);
    if (state.phase === PHASES.PLAYING) maybeTriggerEvent(state, now);
    checkWinner(state);
    return { ok: true };
  }

  function generateDefusePuzzle(rng) {
    // لغز بصري بسيط: 4 أسلاك، سلك واحد "مختلف عن الباقي" وفق قاعدة معلنة بعد الحدث.
    // ليس عشوائيًا بالكامل: نفس القاعدة تُطبَّق دائمًا (اللون الفريد بين الأربعة)، فقط ترتيب الألوان يتغير.
    const colors = ['أحمر', 'أزرق', 'أصفر'];
    const majority = pick(rng, colors);
    const oddOptions = colors.filter((c) => c !== majority);
    const odd = pick(rng, oddOptions);
    const wires = [majority, majority, majority, odd];
    // خلط المواضع
    for (let i = wires.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [wires[i], wires[j]] = [wires[j], wires[i]];
    }
    const correctIndex = wires.indexOf(odd);
    return { wires, correctIndex };
  }

  function resolveDefuse(state, player, action, now) {
    // نولّد اللغز عند لحظة المحاولة نفسها إن لم يكن موجودًا، حتى تُعرَض الأسلاك للاعب قبل اختياره
    // (الواجهة تطلب اللغز عبر getPendingPuzzle قبل استدعاء applyAction).
    const puzzle = state._pendingPuzzle || generateDefusePuzzle(state._rng);
    let success = action.wireIndex === puzzle.correctIndex;
    state._pendingPuzzle = null;

    if (success) {
      // صمّام أمان ضد أي حلقة لا نهائية نظرية: كل نجاح متتالٍ يزيد "تعب القنبلة" (Bomb Fatigue).
      // بعد 3 نجاحات متتالية ضمن نفس الجولة، تبدأ فرصة صغيرة ومتصاعدة لإفلات القنبلة حتى مع
      // القرار الصحيح - يُعرض هذا للاعب كجزء معلن من هوية اللعبة ("ضغط تراكمي")، وليس عشوائية
      // مخفية، ونادرًا ما يظهر في اللعب الطبيعي لأنه يتطلب عدة دورات "حرجة" كاملة ضمن نفس الجولة.
      state.defuseSuccessStreak = (state.defuseSuccessStreak || 0) + 1;
      const streakChance = Math.min(0.85, Math.max(0, state.defuseSuccessStreak - 3) * 0.22);
      // ضمان زمني صارم: كلما اقتربنا من الحد الأقصى الداخلي للجولة (5 دقائق)، ترتفع فرصة إفلات
      // القنبلة رغم القرار الصحيح حتى تصل شبه مؤكدة قرب النهاية - هذا يضمن هندسيًا استحالة تجاوز
      // الجولة الحد الأقصى المصمم، بصرف النظر عن مهارة اللاعبين أو أسلوب لعبهم.
      const elapsed = effectiveElapsed(state, now != null ? now : Date.now());
      const timeSpan = CONST.TIME_FATIGUE_FULL_MS - CONST.TIME_FATIGUE_START_MS;
      const timeChance = Math.max(0, Math.min(1, (elapsed - CONST.TIME_FATIGUE_START_MS) / timeSpan));
      const fatigueChance = Math.max(streakChance, timeChance);
      const hardCutoff = elapsed >= CONST.HARD_ROUND_CUTOFF_MS; // ضمان صارم غير قابل للكسر مهما كانت الاحتمالات
      if (hardCutoff || (fatigueChance > 0 && state._rng() < fatigueChance)) {
        success = false;
      }
    }

    if (success) {
      state.danger = 30;
      state.criticalThreshold = randInt(state._rng, CONST.CRITICAL_MIN, CONST.CRITICAL_MAX);
      state.phase = PHASES.PLAYING;
      pushLog(state, `${player.name} نزع الفتيل بنجاح! القنبلة عادت آمنة نسبيًا.`);
      // نفس اللاعب لا يزال يحمل القنبلة، لكن يجب أن يمرّرها في دوره - ننتقل مباشرة لدور تمرير عادي
      maybeTriggerEvent(state, now);
      checkWinner(state);
      return { ok: true, success: true };
    } else {
      state.defuseSuccessStreak = 0;
      player.alive = false;
      player.eliminationReason = 'فشل في نزع الفتيل عند اللحظة الحرجة';
      pushLog(state, `${player.name} خرج! فشل نزع الفتيل.`);
      const alive = alivePlayers(state);
      if (!checkWinner(state)) {
        // القنبلة تنتقل عادلة: لأقل اللاعبين حملًا لها حتى الآن (وليس عشوائيًا خالصًا ولا للاعب الأخير دائمًا)
        const minHeld = Math.min(...alive.map((p) => p.turnsHeld));
        const candidates = alive.filter((p) => p.turnsHeld === minHeld);
        const next = pick(state._rng, candidates);
        state.danger = 25;
        state.criticalThreshold = randInt(state._rng, CONST.CRITICAL_MIN, CONST.CRITICAL_MAX);
        state.phase = PHASES.PLAYING;
        state.bombHolderId = next.id;
        pushLog(state, `القنبلة الجديدة بدأت مع ${next.name}.`);
        maybeTriggerEvent(state, now);
      }
      return { ok: true, success: false };
    }
  }

  function getPendingPuzzle(state) {
    if (state.phase !== PHASES.CRITICAL_PENDING) return null;
    if (!state._pendingPuzzle) state._pendingPuzzle = generateDefusePuzzle(state._rng);
    return state._pendingPuzzle;
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
    const pausedDuration = now - state.pausedAt;
    state.totalPausedMs += Math.max(0, pausedDuration);
    state.pausedAt = null;
    state.phase = state._phaseBeforePause || PHASES.PLAYING;
    delete state._phaseBeforePause;
    pushLog(state, 'استؤنفت اللعبة.');
    return { ok: true };
  }

  // ------------------------- عرض للواجهة (لا يكشف معلومات مستقبلية) -------------------------
  function getPublicView(state, forPlayerId) {
    return {
      players: state.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        calmCharges: p.calmCharges,
        isHolder: p.id === state.bombHolderId,
        eliminationReason: p.eliminationReason,
      })),
      dangerLabel: dangerLabel(state.danger),
      phase: state.phase,
      pendingEvent: state.pendingEvent
        ? { title: state.pendingEvent.title, options: state.pendingEvent.options.map((o) => ({ id: o.id, label: o.label })) }
        : null,
      puzzle: state.phase === PHASES.CRITICAL_PENDING ? getPendingPuzzle(state).wires : null,
      winnerId: state.winnerId,
      bombHolderId: state.bombHolderId,
      availableActions: forPlayerId ? getAvailableActions(state, forPlayerId) : [],
      recentLog: state.log.slice(-5).map((l) => l.text),
    };
  }

  // ------------------------- تسلسل/استعادة الحالة (لدعم Refresh) -------------------------
  function serialize(state) {
    const clone = Object.assign({}, state);
    delete clone._rng;
    // ملاحظة: نُبقي _pendingPuzzle (إن وُجد) داخل التسلسل عمدًا - وهو بيانات صرفة (JSON-safe)
    // بلا دوال. هذا ضروري لضمان ألا يتغير لغز نزع الفتيل المعروض بعد Refresh في "اللحظة الحرجة"
    // (لو حُذف هنا، كان سيُعاد توليد لغز مختلف بعد الاستعادة، وهو ما كان يخالف اشتراط
    // "لا تتغير حالة القنبلة" و"لا يُفقد أي تقدم" بعد Refresh - تم اكتشاف هذا وإصلاحه أثناء الاختبار).
    return JSON.stringify(clone);
  }

  function deserialize(json) {
    const state = JSON.parse(json);
    // نعيد بناء مولّد عشوائية جديد مشتق من seed + turnCounter لضمان استمرار معقول بعد Refresh.
    // (الحالة الأساسية بالفعل محفوظة بالكامل؛ الـ rng يُستخدم فقط للأحداث القادمة، وهذا لا يخل بالعدالة).
    const derivedSeed = ((state.seed || 0) ^ (state.turnCounter * 2654435761)) >>> 0;
    state._rng = createRng(derivedSeed);
    // _pendingPuzzle يأتي بالفعل من الـ JSON إن كان موجودًا وقت التسلسل (انظر الملاحظة أعلاه)؛
    // لا نفرض null هنا حتى لا نفقده أثناء "اللحظة الحرجة".
    if (state._pendingPuzzle === undefined) state._pendingPuzzle = null;
    return state;
  }

  return {
    CONST,
    ACTIONS,
    PHASES,
    createGame,
    applyAction,
    getAvailableActions,
    getPublicView,
    getPendingPuzzle,
    pauseGame,
    resumeGame,
    serialize,
    deserialize,
    dangerLabel,
    _internal: { createRng, alivePlayers, effectiveElapsed },
  };
});
