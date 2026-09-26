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

console.log('\n=== النتيجة ===');
if (failures.length === 0) {
  console.log('✅ نجحت جميع الاختبارات (' + 11 + ' مجموعات اختبار)');
  process.exit(0);
} else {
  console.log(`❌ فشل ${failures.length} تحقق:`);
  failures.slice(0, 20).forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
