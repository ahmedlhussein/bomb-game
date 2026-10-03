'use strict';
/**
 * اختبارات آلية شاملة لمحرك اللعبة عبر محاكاة آلاف الجولات الكاملة
 * لعدد لاعبين من 2 إلى 6، مع "لاعبين آليين" يتخذون قرارات متنوعة
 * (حذرة، عشوائية، جريئة) لتغطية أكبر عدد من المسارات والفروع.
 *
 * التشغيل: node tests/simulate.js
 */
const Engine = require('../engine/gameEngine.js');

let failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

function randi(n) { return Math.floor(Math.random() * n); }

function playAiTurn(state, playerId, strategy, clockRef) {
  const actions = Engine.getAvailableActions(state, playerId);
  assert(actions.length > 0, 'لا توجد أفعال متاحة للاعب صاحب الدور - LOOP محتمل: ' + JSON.stringify({ phase: state.phase }));
  if (state.phase === Engine.PHASES.CRITICAL_PENDING) {
    const puzzle = Engine.getPendingPuzzle(state);
    let wireIndex;
    if (strategy === 'perfect') wireIndex = puzzle.correctIndex;
    else if (strategy === 'bad') wireIndex = (puzzle.correctIndex + 1) % puzzle.wires.length;
    else wireIndex = randi(puzzle.wires.length);
    return Engine.applyAction(state, playerId, { type: Engine.ACTIONS.DEFUSE_ATTEMPT, wireIndex }, clockRef.now);
  }
  // اختيار فعل عشوائي من بين الشرعي فقط (يحاكي تنوع قرارات اللاعبين البشريين)
  const choice = actions[randi(actions.length)];
  return Engine.applyAction(state, playerId, choice, clockRef.now);
}

function simulateOneGame(numPlayers, seed, strategy) {
  const names = Array.from({ length: numPlayers }, (_, i) => 'لاعب' + (i + 1));
  const clockRef = { now: 1000000 };
  let state = Engine.createGame(names, seed, clockRef.now);

  let safetyCounter = 0;
  const MAX_TURNS = 5000; // حارس ضد أي Loop غير متوقع في الاختبار نفسه
  while (state.phase !== Engine.PHASES.FINISHED) {
    safetyCounter++;
    assert(safetyCounter < MAX_TURNS, `تجاوز الحد الأقصى لعدد الأدوار (Loop لا نهائي محتمل) - seed=${seed} players=${numPlayers}`);
    if (safetyCounter >= MAX_TURNS) break;

    clockRef.now += randi(4000) + 500; // تقدم زمني واقعي بين 0.5 و 4.5 ثانية لكل قرار

    const holder = state.bombHolderId;
    const res = playAiTurn(state, holder, strategy, clockRef);
    assert(res.ok, `فعل مرفوض بشكل غير متوقع: ${res.error} - seed=${seed}`);
  }

  const elapsed = Engine._internal.effectiveElapsed(state, clockRef.now);
  return { state, elapsed, seed, numPlayers };
}

function testExactlyOneWinnerNoTies() {
  for (let n = 2; n <= 6; n++) {
    for (let s = 0; s < 60; s++) {
      const { state } = simulateOneGame(n, s * 97 + n, 'mixed');
      const aliveCount = Engine._internal.alivePlayers(state).length;
      assert(aliveCount === 1, `يجب أن يبقى لاعب واحد بالضبط، وجد ${aliveCount} - n=${n} seed=${s}`);
      assert(!!state.winnerId, `لا يوجد winnerId رغم انتهاء الجولة - n=${n} seed=${s}`);
      const winner = state.players.find((p) => p.id === state.winnerId);
      assert(winner && winner.alive, 'الفائز المُعلن غير حي فعليًا');
    }
  }
  console.log('✓ اختبار: فائز واحد بالضبط، لا تعادل، في 5×60 جولة (2-6 لاعبين)');
}

function testRoundDuration() {
  let minSeen = Infinity, maxSeen = 0, tooShort = 0, tooLong = 0;
  const TOTAL = 200;
  for (let i = 0; i < TOTAL; i++) {
    const n = 2 + (i % 5);
    const { elapsed } = simulateOneGame(n, i * 13 + 7, 'mixed');
    minSeen = Math.min(minSeen, elapsed);
    maxSeen = Math.max(maxSeen, elapsed);
    if (elapsed < 30000) tooShort++;
    if (elapsed > 300000) tooLong++;
  }
  console.log(`  مدى المدة الملاحظة عبر ${TOTAL} جولة: ${(minSeen/1000).toFixed(1)}ث - ${(maxSeen/1000).toFixed(1)}ث`);
  // نسمح بنسبة تسامح صغيرة جدًا للحالات الشاذة الإحصائية للمحاكاة العشوائية البحتة (قرارات AI عشوائية بالكامل قد تُنهي أسرع من لاعب بشري حقيقي)
  const longRatio = tooLong / TOTAL;
  assert(longRatio === 0, `${tooLong} جولة تجاوزت 5 دقائق من أصل ${TOTAL}`);
  assert(tooShort === 0, `${tooShort} جولة أقل من 30 ثانية من أصل ${TOTAL} - يجب أن يكون صفرًا دائمًا`);
  console.log('✓ اختبار: لا توجد جولة تقل عن 30 ثانية ولا تتجاوز 5 دقائق (0 مخالفات من ' + TOTAL + ')');
}

function testNoIllegalActions() {
  // نحاول أفعالًا غير قانونية عمدًا ونتأكد من رفضها
  const state = Engine.createGame(['أحمد', 'محمد', 'سارة'], 42, 0);
  const holder = state.bombHolderId;
  const other = state.players.find((p) => p.id !== holder).id;

  // فعل من لاعب ليس صاحب الدور
  let res = Engine.applyAction(state, other, { type: Engine.ACTIONS.PASS_NORMAL, targetId: holder }, 1000);
  assert(!res.ok, 'يجب رفض فعل من لاعب ليس صاحب الدور');

  // تمرير لنفس اللاعب (هدف غير قانوني)
  res = Engine.applyAction(state, holder, { type: Engine.ACTIONS.PASS_NORMAL, targetId: holder }, 1000);
  assert(!res.ok, 'يجب رفض تمرير القنبلة لنفس حاملها');

  // تمرير لهدف غير موجود
  res = Engine.applyAction(state, holder, { type: Engine.ACTIONS.PASS_NORMAL, targetId: 'ghost' }, 1000);
  assert(!res.ok, 'يجب رفض هدف غير موجود');

  console.log('✓ اختبار: رفض الأفعال غير القانونية (دور خاطئ، هدف ذاتي، هدف وهمي)');
}

function testPauseFreezesEverything() {
  const state = Engine.createGame(['أحمد', 'محمد'], 5, 10000);
  const before = JSON.parse(Engine.serialize(state));
  Engine.pauseGame(state, 10500);
  const holder = state.bombHolderId;
  const res = Engine.applyAction(state, holder, { type: Engine.ACTIONS.PASS_NORMAL, targetId: state.players.find(p=>p.id!==holder).id }, 20000);
  assert(!res.ok, 'يجب ألا يُقبل أي فعل أثناء Pause');

  Engine.resumeGame(state, 70500); // بعد 60 ثانية Pause
  assert(state.totalPausedMs === 60000, `يجب احتساب مدة الـPause بدقة، وجد ${state.totalPausedMs}`);
  assert(state.danger === before.danger, 'يجب ألا يتغير مستوى الخطر أثناء Pause');
  assert(state.bombHolderId === before.bombHolderId, 'يجب ألا يتغير حامل القنبلة أثناء Pause');
  console.log('✓ اختبار: Pause يجمّد الحالة تمامًا، ووقت الـPause لا يُحتسب ضمن مدة الجولة');
}

function testRefreshRestoresExactState() {
  const state = Engine.createGame(['أحمد', 'محمد', 'سارة', 'ليلى'], 77, 0);
  Engine.applyAction(state, state.bombHolderId, Engine.getAvailableActions(state, state.bombHolderId)[0], 1000);
  const serialized = Engine.serialize(state);
  const restored = Engine.deserialize(serialized);
  assert(restored.danger === state.danger, 'يجب أن يتطابق مستوى الخطر بعد الاستعادة (محاكاة Refresh)');
  assert(restored.bombHolderId === state.bombHolderId, 'يجب أن يتطابق حامل القنبلة بعد الاستعادة');
  assert(restored.phase === state.phase, 'يجب أن تتطابق المرحلة بعد الاستعادة');
  assert(JSON.stringify(restored.players) === JSON.stringify(state.players), 'يجب أن تتطابق حالة اللاعبين بعد الاستعادة');
  console.log('✓ اختبار: استعادة الحالة بعد "Refresh" مطابقة تمامًا (لا فقدان تقدم)');
}

function testFairnessAcrossPositions() {
  // نتحقق أن اللاعب الأول أو الأخير في الترتيب لا يفوز بمعدل غير متناسب عبر عدد كبير من الجولات
  const winsByIndex = [0, 0, 0, 0];
  const N = 400;
  for (let i = 0; i < N; i++) {
    const { state } = simulateOneGame(4, i * 31 + 3, 'mixed');
    const idx = state.players.findIndex((p) => p.id === state.winnerId);
    winsByIndex[idx]++;
  }
  console.log(`  توزيع الفوز حسب ترتيب الاسم عبر ${N} جولة (4 لاعبين): ${winsByIndex.map(w => (w/N*100).toFixed(1)+'%').join(' | ')}`);
  const expected = N / 4;
  winsByIndex.forEach((w, i) => {
    const deviation = Math.abs(w - expected) / expected;
    assert(deviation < 0.35, `انحراف كبير جدًا في نسبة فوز اللاعب رقم ${i} (${(deviation*100).toFixed(0)}%) - قد يوجد تحيز`);
  });
  console.log('✓ اختبار: لا توجد أفضلية واضحة لأول أو آخر لاعب في الترتيب (ضمن هامش إحصائي معقول)');
}

function testMultipleIndependentSessions() {
  // محاكاة جلستين مستقلتين تمامًا للتأكد من عدم تسرب الحالة بينهما
  const a = Engine.createGame(['A1', 'A2'], 1, 0);
  const b = Engine.createGame(['B1', 'B2', 'B3'], 2, 0);
  Engine.applyAction(a, a.bombHolderId, Engine.getAvailableActions(a, a.bombHolderId)[0], 100);
  Engine.pauseGame(a, 200);
  assert(b.phase !== Engine.PHASES.PAUSED, 'يجب ألا يتأثر Pause في الجلسة A بالجلسة B');
  assert(b.players.length === 3 && a.players.length === 2, 'يجب أن تحتفظ كل جلسة بلاعبيها الخاصين فقط');
  console.log('✓ اختبار: عزل تام بين جلستين مختلفتين (لا تسرب حالة)');
}

function testEliminationAlwaysTiedToDecision() {
  // نتأكد أن كل إقصاء في السجل مرتبط فقط بفشل نزع فتيل، وليس أي سبب آخر
  for (let s = 0; s < 30; s++) {
    const { state } = simulateOneGame(2 + (s % 5), s * 5 + 1, 'mixed');
    state.players.forEach((p) => {
      if (!p.alive) {
        assert(p.eliminationReason === 'فشل في نزع الفتيل عند اللحظة الحرجة', `سبب إقصاء غير متوقع: ${p.eliminationReason}`);
      }
    });
  }
  console.log('✓ اختبار: كل إقصاء ناتج حصريًا عن فشل قرار (نزع الفتيل)، ولا يوجد إقصاء عشوائي');
}

function testStrategyVariants() {
  // نغطي فروعًا إضافية: لاعبون "مثاليون" في نزع الفتيل دائمًا، ولاعبون "سيئون" يفشلون دائمًا
  ['perfect', 'bad', 'mixed'].forEach((strategy) => {
    for (let n = 2; n <= 6; n++) {
      for (let s = 0; s < 15; s++) {
        const { state, elapsed } = simulateOneGame(n, s * 211 + n * 17 + strategy.length, strategy);
        assert(Engine._internal.alivePlayers(state).length === 1, `[${strategy}] يجب أن يبقى لاعب واحد - n=${n}`);
        assert(elapsed >= 30000 && elapsed <= 300000, `[${strategy}] مدة خارج النطاق المسموح: ${elapsed}ms - n=${n}`);
      }
    }
  });
  console.log('✓ اختبار: تغطية فروع إضافية (لاعبون يفشلون دائمًا / ينجحون دائمًا في نزع الفتيل) عبر كل أحجام اللاعبين');
}

function testRefreshDuringCriticalPuzzlePreservesExactWires() {
  // بحث متعمد عن seed يصل للحظة الحرجة بسرعة لتسريع الاختبار
  let found = null;
  for (let seed = 1; seed < 2000 && !found; seed++) {
    const state = Engine.createGame(['أحمد', 'محمد'], seed, 0);
    let clock = 40000; // نتجاوز MIN_ROUND_MS مباشرة
    let guard = 0;
    while (state.phase !== Engine.PHASES.CRITICAL_PENDING && guard < 60) {
      const actions = Engine.getAvailableActions(state, state.bombHolderId);
      if (!actions.length) break;
      const bold = actions.find((a) => a.type === Engine.ACTIONS.PASS_BOLD) || actions[0];
      Engine.applyAction(state, state.bombHolderId, bold, clock);
      clock += 2000;
      guard++;
    }
    if (state.phase === Engine.PHASES.CRITICAL_PENDING) found = state;
  }
  assert(found, 'يجب الوصول إلى اللحظة الحرجة خلال عدد معقول من المحاولات (بيئة الاختبار)');
  if (!found) return;

  const puzzleBefore = Engine.getPendingPuzzle(found); // يولّد اللغز ويخزّنه إن لم يكن موجودًا
  const serialized = Engine.serialize(found);
  const restored = Engine.deserialize(serialized);
  const puzzleAfter = Engine.getPendingPuzzle(restored);

  assert(JSON.stringify(puzzleBefore.wires) === JSON.stringify(puzzleAfter.wires),
    `لغز نزع الفتيل يجب ألا يتغير بعد Refresh - قبل: ${JSON.stringify(puzzleBefore.wires)} بعد: ${JSON.stringify(puzzleAfter.wires)}`);
  assert(puzzleBefore.correctIndex === puzzleAfter.correctIndex,
    'السلك الصحيح يجب ألا يتغير بعد Refresh (وإلا فقد اللاعب قرارًا كان قد اتخذه بناءً على المعلومة المعروضة سابقًا)');
  console.log('✓ اختبار: Refresh أثناء "اللحظة الحرجة" يحافظ تمامًا على نفس لغز الأسلاك (لا تغيّر في حالة القنبلة)');
}

function testRefreshDuringPendingEventPreservesOptions() {
  let found = null;
  for (let seed = 1; seed < 2000 && !found; seed++) {
    const state = Engine.createGame(['أحمد', 'محمد', 'سارة'], seed, 0);
    let clock = 5000;
    let guard = 0;
    while (state.phase !== Engine.PHASES.EVENT_PENDING && state.phase !== Engine.PHASES.FINISHED && guard < 40) {
      const actions = Engine.getAvailableActions(state, state.bombHolderId);
      if (!actions.length) break;
      Engine.applyAction(state, state.bombHolderId, actions[0], clock);
      clock += 1500;
      guard++;
    }
    if (state.phase === Engine.PHASES.EVENT_PENDING) found = state;
  }
  assert(found, 'يجب الوصول إلى حدث ديناميكي معلّق (EVENT_PENDING) خلال عدد معقول من المحاولات');
  if (!found) return;

  const before = Engine.getPublicView(found, found.bombHolderId);
  const restored = Engine.deserialize(Engine.serialize(found));
  const after = Engine.getPublicView(restored, restored.bombHolderId);

  assert(JSON.stringify(before.pendingEvent) === JSON.stringify(after.pendingEvent),
    'خيارات الحدث المعلّق يجب ألا تتغير بعد Refresh');
  assert(before.dangerLabel === after.dangerLabel, 'مستوى الخطر يجب ألا يتغير بعد Refresh أثناء حدث معلّق');
  console.log('✓ اختبار: Refresh أثناء حدث ديناميكي معلّق (SURGE/MALFUNCTION) يحافظ على نفس الخيارات المعروضة');
}

function testScoresNeverNegativeAndWinnerHasScore() {
  for (let n = 2; n <= 6; n++) {
    for (let s = 0; s < 40; s++) {
      const { state } = simulateOneGame(n, s * 71 + n, 'mixed');
      state.players.forEach((p) => {
        assert(Number.isFinite(p.score) && p.score >= 0, `نقاط اللاعب ${p.name} يجب ألا تكون سالبة أبدًا - وُجد ${p.score}`);
      });
      const winner = state.players.find((p) => p.id === state.winnerId);
      assert(winner.score > 0, `الفائز يجب أن يكون قد جمع نقاط جرأة أثناء اللعبة (نجا من دورات فعلية) - وُجد ${winner.score}`);
    }
  }
  console.log('✓ اختبار: نقاط الجرأة لا تكون سالبة أبدًا، والفائز دائمًا يملك نقاطًا مكتسبة فعليًا');
}

function testScoreAwardedOnEveryPassType() {
  const state = Engine.createGame(['أحمد', 'محمد'], 999, 40000);
  const holder = state.bombHolderId;
  const scoreBefore = Engine.getPublicView(state, holder).players.find((p) => p.id === holder).score;
  const actions = Engine.getAvailableActions(state, holder);
  const normalAction = actions.find((a) => a.type === Engine.ACTIONS.PASS_NORMAL);
  assert(normalAction, 'يجب توفر فعل تمرير عادي لإجراء هذا الاختبار');
  Engine.applyAction(state, holder, normalAction, 41000);
  const scoreAfter = state.players.find((p) => p.id === holder).score;
  assert(scoreAfter === scoreBefore + Engine.CONST.POINTS_PASS_NORMAL,
    `تمرير عادي ناجح يجب أن يضيف بالضبط ${Engine.CONST.POINTS_PASS_NORMAL} نقطة - قبل=${scoreBefore} بعد=${scoreAfter}`);
  console.log('✓ اختبار: التمرير العادي الناجح يضيف نقاط الجرأة الصحيحة بالضبط لصاحب القرار');
}

function testDefuseSuccessAwardsBigPoints() {
  // حقن مباشر لحالة "اللحظة الحرجة" عند وقت مبكر جدًا من الجولة، لعزل اختبار قيمة النقاط عن
  // آلية "تعب القنبلة" الزمنية/التراكمية (المُختبرة بالفعل في اختبارات أخرى منفصلة).
  const state = Engine.createGame(['أحمد', 'محمد'], 55, 0);
  const holderId = state.bombHolderId;
  state.phase = Engine.PHASES.CRITICAL_PENDING;
  state.criticalThreshold = 0;
  const puzzle = Engine.getPendingPuzzle(state);
  const scoreBefore = state.players.find((p) => p.id === holderId).score;
  const res = Engine.applyAction(state, holderId, { type: Engine.ACTIONS.DEFUSE_ATTEMPT, wireIndex: puzzle.correctIndex }, 1000);
  assert(res.ok && res.success, 'يجب أن ينجح نزع الفتيل بالسلك الصحيح مبكرًا في الجولة (بلا تعب تراكمي) لإجراء هذا الاختبار');
  const scoreAfter = state.players.find((p) => p.id === holderId).score;
  assert(scoreAfter === scoreBefore + Engine.CONST.POINTS_DEFUSE_SUCCESS,
    `نزع الفتيل الناجح يجب أن يضيف بالضبط ${Engine.CONST.POINTS_DEFUSE_SUCCESS} نقطة - قبل=${scoreBefore} بعد=${scoreAfter}`);
  console.log('✓ اختبار: نزع الفتيل الناجح يضيف أعلى قيمة نقاط في اللعبة بالضبط');
}

function testBoldMomentGambleWithinDeclaredRangeAndDangerRises() {
  // نبحث عن seed يصل لحدث BOLD_MOMENT مع خيار "جازف" سريعًا
  let found = null, foundChoice = null;
  for (let seed = 1; seed < 3000 && !found; seed++) {
    const state = Engine.createGame(['أحمد', 'محمد', 'سارة'], seed, 0);
    let clock = 5000, guard = 0;
    while (state.phase !== Engine.PHASES.FINISHED && guard < 40) {
      if (state.phase === Engine.PHASES.EVENT_PENDING && state.pendingEvent.type === 'BOLD_MOMENT') {
        const gamble = state.pendingEvent.options.find((o) => o.id === 'gamble');
        if (gamble) { found = state; foundChoice = gamble; break; }
      }
      const actions = Engine.getAvailableActions(state, state.bombHolderId);
      if (!actions.length) break;
      Engine.applyAction(state, state.bombHolderId, actions[0], clock);
      clock += 1500; guard++;
    }
  }
  assert(found, 'يجب الوصول إلى حدث "لحظة الجرأة" بخيار المجازفة خلال عدد معقول من المحاولات');
  if (!found) return;

  for (let trial = 0; trial < 30; trial++) {
    const state = Engine.createGame(['أحمد', 'محمد'], 12345 + trial, 0);
    // نفرض حالة مطابقة يدويًا: نحقن حدث BOLD_MOMENT مباشرة لتوليد عينات كافية للمدى الإحصائي
    state.pendingEvent = {
      type: 'BOLD_MOMENT',
      title: 'test',
      options: [
        { id: 'safe', label: 'أمّن', dangerDelta: 0, points: Engine.CONST.POINTS_BOLD_MOMENT_SAFE },
        { id: 'gamble', label: 'جازف', dangerDelta: Engine.CONST.BOLD_MOMENT_DANGER_DELTA, pointsRange: Engine.CONST.POINTS_BOLD_MOMENT_GAMBLE_RANGE },
      ],
    };
    state.phase = Engine.PHASES.EVENT_PENDING;
    const dangerBefore = state.danger;
    const scoreBefore = state.players.find((p) => p.id === state.bombHolderId).score;
    const res = Engine.applyAction(state, state.bombHolderId, { type: Engine.ACTIONS.RESOLVE_EVENT, choiceId: 'gamble' }, 1000);
    assert(res.ok, 'اختيار "جازف" يجب أن يُقبل دائمًا كفعل شرعي');
    const gained = state.players.find((p) => p.id === state.bombHolderId).score - scoreBefore;
    assert(gained >= Engine.CONST.POINTS_BOLD_MOMENT_GAMBLE_RANGE[0] && gained <= Engine.CONST.POINTS_BOLD_MOMENT_GAMBLE_RANGE[1],
      `نقاط المجازفة يجب أن تقع ضمن النطاق المُعلن [${Engine.CONST.POINTS_BOLD_MOMENT_GAMBLE_RANGE}] - وُجد ${gained}`);
    assert(state.danger >= dangerBefore + Engine.CONST.BOLD_MOMENT_DANGER_DELTA - 0.001,
      'اختيار "جازف" يجب أن يرفع خطر القنبلة فعليًا بالقدر المُعلن (المخاطرة حقيقية وليست شكلية)');
  }
  console.log('✓ اختبار: "جازف" في لحظة الجرأة يعطي نقاطًا ضمن النطاق المُعلن دائمًا، ويرفع خطر القنبلة فعليًا (مخاطرة حقيقية)');

  // والخيار الآمن يعطي القيمة الثابتة بالضبط بدون أي تغيير في الخطر
  const safeState = Engine.createGame(['أحمد', 'محمد'], 777, 0);
  safeState.pendingEvent = found.pendingEvent.type === 'BOLD_MOMENT' ? found.pendingEvent : {
    type: 'BOLD_MOMENT', title: 't',
    options: [{ id: 'safe', label: 'أمّن', dangerDelta: 0, points: Engine.CONST.POINTS_BOLD_MOMENT_SAFE }],
  };
  safeState.phase = Engine.PHASES.EVENT_PENDING;
  const dangerBeforeSafe = safeState.danger;
  const scoreBeforeSafe = safeState.players.find((p) => p.id === safeState.bombHolderId).score;
  Engine.applyAction(safeState, safeState.bombHolderId, { type: Engine.ACTIONS.RESOLVE_EVENT, choiceId: 'safe' }, 1000);
  const scoreAfterSafe = safeState.players.find((p) => p.id === safeState.bombHolderId).score;
  assert(scoreAfterSafe === scoreBeforeSafe + Engine.CONST.POINTS_BOLD_MOMENT_SAFE,
    'اختيار "أمّن نقاطك" يجب أن يعطي القيمة الثابتة المُعلنة بالضبط دائمًا');
  assert(safeState.danger === dangerBeforeSafe, 'اختيار "أمّن نقاطك" يجب ألا يغيّر خطر القنبلة إطلاقًا');
  console.log('✓ اختبار: "أمّن نقاطك" يعطي نفس القيمة الثابتة دائمًا بدون أي زيادة في الخطر');
}

function testWinnerDeterminedBySurvivalNotScore() {
  // نتأكد أن الفوز لا يزال محسومًا بالبقاء فقط، وليس بأعلى نقاط - حتى لو جمع لاعب مُقصى نقاطًا أكثر
  for (let s = 0; s < 40; s++) {
    const { state } = simulateOneGame(2 + (s % 5), s * 19 + 3, 'mixed');
    const alive = Engine._internal.alivePlayers(state);
    assert(alive.length === 1 && alive[0].id === state.winnerId,
      'الفائز يجب أن يكون دائمًا اللاعب الباقي حيًا بغض النظر عن توزيع النقاط بين اللاعبين');
  }
  console.log('✓ اختبار: الفوز يُحسم بالبقاء فقط (كما كان)، ونقاط الجرأة طبقة ثانوية لا تتحكم في نتيجة الجولة');
}

console.log('=== بدء الاختبارات الآلية لمحرك لعبة "القنبلة" ===\n');
testExactlyOneWinnerNoTies();
testRoundDuration();
testNoIllegalActions();
testPauseFreezesEverything();
testRefreshRestoresExactState();
testFairnessAcrossPositions();
testMultipleIndependentSessions();
testEliminationAlwaysTiedToDecision();
testStrategyVariants();
testRefreshDuringCriticalPuzzlePreservesExactWires();
testRefreshDuringPendingEventPreservesOptions();
testScoresNeverNegativeAndWinnerHasScore();
testScoreAwardedOnEveryPassType();
testDefuseSuccessAwardsBigPoints();
testBoldMomentGambleWithinDeclaredRangeAndDangerRises();
testWinnerDeterminedBySurvivalNotScore();

console.log('\n=== النتيجة ===');
if (failures.length === 0) {
  console.log('✅ نجحت جميع الاختبارات (' + 16 + ' مجموعات اختبار)');
  process.exit(0);
} else {
  console.log(`❌ فشل ${failures.length} تحقق:`);
  failures.slice(0, 20).forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
