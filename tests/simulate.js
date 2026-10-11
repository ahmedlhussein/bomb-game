'use strict';
/**
 * اختبارات آلية شاملة لمحرك "رمية القنبلة".
 * تُشغَّل بـ: node tests/simulate.js
 *
 * نموذج اللاعبين الآليين: كل لاعب آلي يختار أفعالًا شرعية، ويوقف المؤشر قرب مركز منطقة النجاح بدقة
 * تحددها "مهارته" كخطأ توقيت بالمللي ثانية (perfect=0 | good=45 | poor=90 | random=عشوائي تمامًا).
 * خطأ التوقيت يتحول لخطأ مكان بحسب سرعة المؤشر (المؤشر الأسرع أصعب) كما يحدث للاعب حقيقي.
 * زمن كل قرار يحاكي سرعة بشرية واقعية + زمن حركات الشاشة.
 */
const Engine = require('../engine/gameEngine.js');
const { createRng } = Engine._internal;
const C = Engine.CONST;
const A = Engine.ACTIONS;
const P = Engine.PHASES;

const failures = [];
function assert(cond, msg) { if (!cond) failures.push(msg); }

// ---------------------------------------------------------------- أدوات المحاكاة
function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp01(x) { return Math.max(0, Math.min(1, x)); }
const TIMING_SIGMA_MS = { perfect: 0, good: 45, poor: 90 };

function cursorFor(aim, skill, rng) {
  if (skill === 'random') return rng();
  const center = (aim.zoneStart + aim.zoneEnd) / 2;
  const speed = 2 / aim.period; // أطوال شريط في الثانية
  return clamp01(center + gaussian(rng) * (TIMING_SIGMA_MS[skill] / 1000) * speed);
}

function chooseAction(state, pid, skill, rng, strategy) {
  const actions = Engine.getAvailableActions(state, pid);
  if (state.phase === P.AIM) return { type: A.RELEASE, cursor: cursorFor(state.aim, skill, rng) };
  if (state.phase === P.EVENT_PENDING) return actions[Math.floor(rng() * actions.length)];
  const buy = actions.find((a) => a.type === A.BUY_SHIELD);
  if (state.phase === P.DEFUSE_READY) {
    if (buy && rng() < 0.5) return buy;
    return { type: A.START_DEFUSE };
  }
  if (buy && rng() < 0.4) return buy;
  let throws = actions.filter((a) => a.type === A.START_THROW);
  if (strategy === 'stall') {
    // يفضّل أقل زيادة في الخطر ما أمكن (أسوأ حالة لإطالة الجولة)
    const safe = throws.filter((a) => a.throwType === 'safe');
    const fast = throws.filter((a) => a.throwType === 'fast');
    throws = safe.length ? safe : fast.length ? fast : throws;
  }
  if (rng() < 0.7) {
    // لاعب بشري يستهدف الأضعف (الأقل قلوبًا)
    const hp = (id) => state.players.find((p) => p.id === id).hearts;
    const minH = Math.min(...throws.map((a) => hp(a.targetId)));
    const weak = throws.filter((a) => hp(a.targetId) === minH);
    if (weak.length) throws = weak;
  }
  return throws[Math.floor(rng() * throws.length)];
}

function decisionTime(action, rng) {
  switch (action.type) {
    case A.START_THROW: return 1200 + rng() * 1300;
    case A.RELEASE: return 1000 + rng() * 1200;
    case A.START_DEFUSE: return 600 + rng() * 600;
    case A.RESOLVE_EVENT: return 1500 + rng() * 1500;
    default: return 800 + rng() * 700;
  }
}
function animationTime(effects) {
  let t = 0;
  effects.forEach((e) => {
    if (e.type === 'THROW') t += 700;
    if (e.type === 'SLIP') t += 900;
    if (e.type === 'EXPLODE') t += 2200;
    if (e.type === 'NEW_BOMB') t += 600;
    if (e.type === 'SUDDEN_DEATH') t += 1500;
    if (e.type === 'DEFUSE' && e.success) t += 600;
  });
  return t;
}

function runGame(n, seed, skills, opts) {
  opts = opts || {};
  const rng = createRng(seed * 7919 + 13);
  const names = Array.from({ length: n }, (_, i) => 'لاعب' + (i + 1));
  const state = Engine.createGame(names, seed, 0);
  let clock = 0;
  let steps = 0;
  let firstDangerEvent = null;
  const info = { explosions: 0, suddenDeath: false, lastActionAt: 0 };
  while (state.phase !== P.FINISHED) {
    steps += 1;
    if (steps > 40000) { assert(false, `حلقة لا نهائية محتملة - seed=${seed} n=${n}`); break; }
    const pid = state.bombHolderId;
    const skill = skills[Number(pid.slice(1)) % skills.length];
    const act = chooseAction(state, pid, skill, rng, opts.strategy);
    clock += opts.instant ? 50 : decisionTime(act, rng);
    const res = Engine.applyAction(state, pid, act, clock);
    assert(res.ok, `فعل شرعي رُفض: ${res.error} - seed=${seed} phase=${state.phase}`);
    if (!res.ok) break;
    info.lastActionAt = clock;
    res.effects.forEach((e) => {
      if ((e.type === 'RED' || e.type === 'EXPLODE') && firstDangerEvent == null) firstDangerEvent = clock;
      if (e.type === 'EXPLODE') info.explosions += 1;
      if (e.type === 'SUDDEN_DEATH') info.suddenDeath = true;
    });
    clock += opts.instant ? 0 : animationTime(res.effects);
  }
  return { state, endAt: info.lastActionAt, endWithAnim: clock, firstDangerEvent, info, steps };
}

function freshState(n, seed) {
  const names = Array.from({ length: n || 3 }, (_, i) => 'لاعب' + (i + 1));
  const s = Engine.createGame(names, seed || 1, 0);
  s.lastEventAtTurn = 1e9; // نعطّل الأحداث العشوائية في الاختبارات الموجّهة
  return s;
}
function holder(state) { return state.players.find((p) => p.id === state.bombHolderId); }
function startThrow(state, type, target, now) {
  return Engine.applyAction(state, state.bombHolderId, { type: A.START_THROW, throwType: type, targetId: target }, now);
}
function releaseCenter(state, now) {
  const a = state.aim;
  return Engine.applyAction(state, state.bombHolderId, { type: A.RELEASE, cursor: (a.zoneStart + a.zoneEnd) / 2 }, now);
}
function releaseMiss(state, now) {
  return Engine.applyAction(state, state.bombHolderId, { type: A.RELEASE, cursor: 0 }, now);
}
function otherThan(state, id) { return state.players.find((p) => p.id !== id && p.alive).id; }
/** يجهّز دورة "فكّ فتيل" فاشلة عند صاحب القنبلة الحالي ويعيد نتيجتها */
function forceExplosion(state, now) {
  state.danger = 90;
  state.phase = P.DEFUSE_READY;
  state.aim = null;
  Engine.applyAction(state, state.bombHolderId, { type: A.START_DEFUSE }, now);
  return releaseMiss(state, now + 1000);
}

const SKILL_MIX = ['good', 'poor', 'perfect', 'random', 'good', 'poor'];

// ---------------------------------------------------------------- الاختبارات
function testExactlyOneWinnerNoTies() {
  let games = 0;
  for (let n = 2; n <= 6; n++) {
    for (let s = 1; s <= 40; s++) {
      const { state } = runGame(n, s * 97 + n, SKILL_MIX);
      games++;
      const alive = Engine._internal.alivePlayers(state);
      assert(alive.length === 1, `يجب بقاء لاعب واحد بالضبط، وُجد ${alive.length} - n=${n}`);
      assert(state.winnerId === alive[0].id, 'winnerId يجب أن يطابق اللاعب الباقي');
      assert(alive[0].hearts >= 1, 'الفائز يجب أن يمتلك قلبًا واحدًا على الأقل');
      state.players.filter((p) => !p.alive).forEach((p) => assert(p.hearts === 0, 'اللاعب المُقصى يجب أن يكون بلا قلوب'));
    }
  }
  console.log(`✓ فائز واحد بالضبط وبدون تعادل في ${games} جولة (2-6 لاعبين، مهارات مختلطة)`);
}

function testRoundDurationBounds() {
  const durations = [];
  const byProfile = {};
  let hitSudden = 0;
  let total = 0;
  const profiles = [
    { name: 'مختلط', skills: SKILL_MIX, strategy: undefined },
    { name: 'جيدون', skills: ['good'], strategy: undefined },
    { name: 'مثاليون', skills: ['perfect'], strategy: undefined },
    { name: 'مثاليون يماطلون', skills: ['perfect'], strategy: 'stall' },
    { name: 'عشوائيون', skills: ['random'], strategy: undefined },
    { name: 'جيدون يماطلون', skills: ['good'], strategy: 'stall' },
  ];
  profiles.forEach((pr) => {
    byProfile[pr.name] = [];
    for (let n = 2; n <= 6; n++) {
      for (let s = 1; s <= 14; s++) {
        const r = runGame(n, s * 131 + n * 7, pr.skills, { strategy: pr.strategy });
        total++;
        durations.push(r.endWithAnim);
        byProfile[pr.name].push(r.endWithAnim);
        if (r.info.suddenDeath) hitSudden++;
        assert(r.endAt >= 30000, `[${pr.name}] جولة أقصر من 30 ثانية: ${(r.endAt / 1000).toFixed(1)}ث (n=${n})`);
        assert(r.endWithAnim <= 300000, `[${pr.name}] جولة أطول من 5 دقائق: ${(r.endWithAnim / 1000).toFixed(1)}ث (n=${n})`);
      }
    }
  });
  const stat = (arr) => { const a = arr.slice().sort((x, y) => x - y); return `${(a[0] / 1000).toFixed(0)} / ${(a[Math.floor(a.length / 2)] / 1000).toFixed(0)} / ${(a[a.length - 1] / 1000).toFixed(0)}`; };
  console.log(`  المدة (أدنى/وسيط/أقصى بالثواني) عبر ${total} جولة: ${stat(durations)} | وصلت لوضع الحسم: ${hitSudden}/${total}`);
  Object.keys(byProfile).forEach((k) => console.log(`    - ${k}: ${stat(byProfile[k])}`));
  const mixedMedian = byProfile['مختلط'].slice().sort((a, b) => a - b)[Math.floor(byProfile['مختلط'].length / 2)];
  assert(mixedMedian <= 200000, `وسيط مدة الجولة للاعبين المختلطين يجب ألا يتجاوز 200 ثانية - الفعلي ${(mixedMedian / 1000).toFixed(0)}`);
  console.log('✓ كل الجولات بين 30 ثانية و5 دقائق (بما فيها المثاليون والمماطلون والعشوائيون)، والوسيط معقول');
}

function testSuddenDeathIsTheExceptionNotTheRule() {
  let sd = 0;
  let total = 0;
  for (let n = 2; n <= 6; n++) {
    for (let s = 1; s <= 20; s++) {
      const r = runGame(n, 4000 + s * 17 + n, ['good', 'poor']);
      total++;
      if (r.info.suddenDeath) sd++;
    }
  }
  console.log(`  وضع الحسم ظهر في ${sd}/${total} جولة للاعبين واقعيين`);
  assert(sd / total < 0.3, `وضع الحسم يجب أن يكون استثناءً (أقل من 30%) وليس القاعدة - النسبة ${(sd / total * 100).toFixed(0)}%`);
  console.log('✓ نظام القلوب هو الذي يحسم معظم الجولات، ووضع الحسم شبكة أمان نادرة');
}

function testNoExplosionBeforeMinimumTime() {
  for (let n = 2; n <= 6; n++) {
    const r = runGame(n, 500 + n, ['perfect'], { instant: true });
    assert(r.firstDangerEvent == null || r.firstDangerEvent >= C.MIN_ROUND_MS,
      `دخول للأحمر/انفجار مبكر قبل الحد الأدنى: ${r.firstDangerEvent}ms (n=${n})`);
    assert(r.endAt >= 30000, `الجولة انتهت مبكرًا جدًا: ${r.endAt}ms (n=${n})`);
  }
  console.log('✓ لا دخول للمنطقة الحمراء ولا انفجار قبل الحد الأدنى الداخلي حتى مع لاعبين فوريين');
}

function testIllegalActionsRejected() {
  const s = freshState(5, 11);
  const h = s.bombHolderId;
  const other = otherThan(s, h);
  let r;

  r = Engine.applyAction(s, other, { type: A.START_THROW, throwType: 'accurate', targetId: h }, 1000);
  assert(!r.ok, 'يجب رفض فعل من لاعب ليس صاحب الدور');
  r = startThrow(s, 'accurate', h, 1000);
  assert(!r.ok, 'يجب رفض رمي القنبلة لنفس حاملها');
  r = startThrow(s, 'accurate', 'ghost', 1000);
  assert(!r.ok, 'يجب رفض هدف غير موجود');
  r = startThrow(s, 'teleport', other, 1000);
  assert(!r.ok, 'يجب رفض نوع رمية غير معروف');
  r = Engine.applyAction(s, h, { type: A.RELEASE, cursor: 0.5 }, 1000);
  assert(!r.ok, 'RELEASE بدون مؤشر نشط يجب أن يُرفض');
  r = Engine.applyAction(s, h, { type: A.START_DEFUSE }, 1000);
  assert(!r.ok, 'START_DEFUSE خارج المنطقة الحمراء يجب أن يُرفض');
  r = Engine.applyAction(s, h, { type: A.RESOLVE_EVENT, choiceId: 'x' }, 1000);
  assert(!r.ok, 'RESOLVE_EVENT بدون حدث يجب أن يُرفض');
  r = Engine.applyAction(s, h, { type: A.BUY_SHIELD }, 1000);
  assert(!r.ok, 'شراء درع بدون نقاط كافية يجب أن يُرفض');
  r = Engine.applyAction(s, h, null, 1000);
  assert(!r.ok, 'فعل فارغ يجب أن يُرفض');
  r = Engine.applyAction(s, h, { type: 'HACK' }, 1000);
  assert(!r.ok, 'فعل غير معروف يجب أن يُرفض');

  const tgt = Engine.getAvailableActions(s, h).find((a) => a.type === A.START_THROW).targetId;
  assert(startThrow(s, 'accurate', tgt, 1000).ok, 'بدء رمية شرعية يجب أن ينجح');
  r = startThrow(s, 'fast', tgt, 1100);
  assert(!r.ok, 'لا يجوز بدء رمية ثانية أثناء AIM');
  [NaN, Infinity, -0.1, 1.1, '0.5', undefined, null].forEach((bad) => {
    const rr = Engine.applyAction(s, h, { type: A.RELEASE, cursor: bad }, 1200);
    assert(!rr.ok, `موضع مؤشر غير صالح (${String(bad)}) يجب أن يُرفض`);
  });
  assert(s.phase === P.AIM && s.aim, 'الرفض يجب ألا يغيّر الحالة');
  assert(releaseCenter(s, 1300).ok, 'RELEASE صالح يجب أن يُقبل');
  const r2 = Engine.applyAction(s, h, { type: A.RELEASE, cursor: 0.5 }, 1400);
  assert(!r2.ok, 'لا يمكن إعادة تنفيذ فعل RELEASE بعد استهلاكه');

  const s2 = freshState(3, 22);
  const h2 = s2.bombHolderId;
  holder(s2).safeHandoffs = 0;
  const t2 = otherThan(s2, h2);
  assert(!startThrow(s2, 'safe', t2, 1000).ok, 'تسليم آمن بعد نفاد الرصيد يجب أن يُرفض');
  assert(!Engine.getAvailableActions(s2, h2).some((a) => a.throwType === 'safe'), 'لا تظهر أفعال تسليم آمن عند نفاد الرصيد');

  const s3 = freshState(2, 33);
  s3.phase = P.FINISHED;
  assert(!Engine.applyAction(s3, s3.bombHolderId, { type: A.START_THROW, throwType: 'accurate', targetId: otherThan(s3, s3.bombHolderId) }, 1000).ok, 'لا أفعال بعد انتهاء الجولة');

  // لاعب مُقصى لا يستطيع اللعب
  const s4 = freshState(3, 44);
  const dead = otherThan(s4, s4.bombHolderId);
  s4.players.find((p) => p.id === dead).alive = false;
  s4.bombHolderId = dead;
  assert(!Engine.applyAction(s4, dead, { type: A.START_THROW, throwType: 'accurate', targetId: s4.players[0].id }, 1000).ok, 'لاعب مُقصى لا يجوز له اللعب');
  console.log('✓ الأفعال غير القانونية كلها مرفوضة ولا تغيّر الحالة (دور/هدف/نوع/مرحلة/قيم مؤشر/رصيد/مُقصى/بعد النهاية)');
}

function testBackThrowRestriction() {
  const s4 = freshState(4, 5);
  const a = s4.bombHolderId;
  const b = otherThan(s4, a);
  s4.danger = 10;
  startThrow(s4, 'accurate', b, 1000);
  releaseCenter(s4, 1100);
  assert(s4.bombHolderId === b, 'يجب انتقال القنبلة للمستلم');
  const targets = Engine._internal.legalTargets(s4, b);
  assert(!targets.includes(a), 'مع 4 لاعبين: لا يجوز الرد مباشرة على من رماها لك');
  assert(targets.length === 2, 'يجب بقاء هدفين شرعيين مع 4 لاعبين');

  const s3 = freshState(3, 6);
  const a3 = s3.bombHolderId;
  const b3 = otherThan(s3, a3);
  startThrow(s3, 'accurate', b3, 1000);
  releaseCenter(s3, 1100);
  assert(Engine._internal.legalTargets(s3, s3.bombHolderId).includes(a3), 'مع 3 لاعبين: الرد مسموح (حرية اختيار حقيقية)');
  console.log('✓ قيد "لا رد مباشر" يعمل مع 4+ لاعبين ويُرفع مع 3 لاعبين');
}

function testZoneShrinkAndSafeImmunity() {
  const s = freshState(3, 7);
  const expect = {
    green: { danger: 10, fast: 14, accurate: 26, safe: 85 },
    yellow: { danger: 40, fast: 11.2, accurate: 20.8, safe: 85 },
    orange: { danger: 70, fast: 8.4, accurate: 15.6, safe: 85 },
  };
  Object.keys(expect).forEach((z) => {
    s.danger = expect[z].danger;
    s.phase = P.READY;
    const pv = Engine.getPublicView(s, s.bombHolderId).throwPreview;
    ['fast', 'accurate', 'safe'].forEach((t) => {
      assert(Math.abs(pv[t].widthPct - expect[z][t]) <= 0.51, `منطقة ${t} في ${z} يجب ${expect[z][t]}% - الفعلي ${pv[t].widthPct}%`);
    });
  });
  s.danger = 70; s.phase = P.READY;
  startThrow(s, 'accurate', otherThan(s, s.bombHolderId), 1000);
  const w = s.aim.zoneEnd - s.aim.zoneStart;
  assert(Math.abs(w - 0.156) < 1e-9, `عرض المنطقة الفعلي في البرتقالي يجب 0.156 - الفعلي ${w}`);
  assert(s.aim.zoneStart >= 0.04 && s.aim.zoneEnd <= 0.96, 'منطقة النجاح يجب أن تقع داخل حدود الشريط');
  console.log('✓ مستوى الخطر يضيّق مناطق الرمي فعليًا (أصفر −20%، برتقالي −40%) والتسليم الآمن لا يتأثر');
}

function testThrowTypesAreDistinct() {
  // الملاحظة الأساسية للمستخدم: "الأنواع التلاتة شبه بعض" - نقيس أن لكل نوع طابعًا مختلفًا فعليًا
  const rng = createRng(2468);
  const stats = {};
  ['fast', 'accurate', 'safe'].forEach((type) => {
    const st = { n: 0, ok: 0, dsum: 0, psum: 0 };
    for (let i = 0; i < 600; i++) {
      const s = freshState(3, 100 + i);
      s.danger = 30;
      s.startedAt = -20000; // بعد بداية الجولة بقليل، بدون تضاعف زمني
      const h = s.bombHolderId;
      startThrow(s, type, otherThan(s, h), 0);
      const cur = cursorFor(s.aim, 'good', rng);
      const before = s.danger;
      const r = Engine.applyAction(s, h, { type: A.RELEASE, cursor: cur }, 0);
      const thrown = r.effects.find((e) => e.type === 'THROW');
      st.n++;
      if (thrown) { st.ok++; st.dsum += thrown.dangerAfter - before; st.psum += thrown.points; }
    }
    stats[type] = { rate: st.ok / st.n, meanDanger: st.dsum / st.ok, meanPoints: st.psum / st.ok };
  });
  const f = (t) => `${(stats[t].rate * 100).toFixed(0)}% نجاح | خطر ${stats[t].meanDanger.toFixed(1)} | نقاط ${stats[t].meanPoints.toFixed(1)}`;
  console.log(`  ⚡ سريعة: ${f('fast')}\n  🎯 مضبوطة: ${f('accurate')}\n  🤝 آمن: ${f('safe')}`);
  assert(stats.safe.rate > 0.95, 'التسليم الآمن يجب أن يكون شبه مضمون');
  assert(stats.accurate.rate > 0.8 && stats.accurate.rate < 0.995, 'الرمية المضبوطة يجب أن تكون متوسطة الصعوبة');
  assert(stats.fast.rate > 0.3 && stats.fast.rate < 0.75, 'الرمية السريعة يجب أن تكون صعبة بوضوح');
  assert(stats.safe.rate > stats.accurate.rate && stats.accurate.rate > stats.fast.rate, 'ترتيب النجاح: آمن > مضبوطة > سريعة');
  assert(stats.safe.meanDanger < stats.fast.meanDanger && stats.fast.meanDanger < stats.accurate.meanDanger, 'ترتيب زيادة الخطر: آمن < سريعة < مضبوطة');
  assert(stats.fast.meanPoints > stats.accurate.meanPoints && stats.accurate.meanPoints > stats.safe.meanPoints, 'ترتيب النقاط: سريعة > مضبوطة > آمن');

  // الخطر يؤثر فعليًا على نسبة النجاح
  const rate = (danger) => {
    let ok = 0;
    const N = 800;
    for (let i = 0; i < N; i++) {
      const s = freshState(3, 5000 + i);
      s.danger = danger;
      s.startedAt = -20000;
      const h = s.bombHolderId;
      startThrow(s, 'accurate', otherThan(s, h), 0);
      const r = Engine.applyAction(s, h, { type: A.RELEASE, cursor: cursorFor(s.aim, 'good', rng) }, 0);
      if (r.effects.some((e) => e.type === 'THROW')) ok++;
    }
    return ok / N;
  };
  const rg = rate(10);
  const ro = rate(70);
  console.log(`  نسبة نجاح الرمية المضبوطة: آمن ${(rg * 100).toFixed(0)}% → خطر ${(ro * 100).toFixed(0)}%`);
  assert(rg - ro > 0.05, 'المنطقة البرتقالية يجب أن تخفض نسبة النجاح فعليًا مقارنة بالأخضر');
  console.log('✓ أنواع الرمي الثلاثة مختلفة إحصائيًا (صعوبة/خطر/نقاط) ومستوى الخطر يغيّر نسبة النجاح فعليًا');
}

function testConfusionAppliesOnceToReceiver() {
  const s = freshState(3, 8);
  s.danger = 10;
  const a = s.bombHolderId;
  const b = otherThan(s, a);
  startThrow(s, 'fast', b, 1000);
  assert(releaseCenter(s, 1100).ok, 'رمية سريعة بمنتصف المنطقة يجب أن تنجح');
  assert(s.bombHolderId === b && s.confusedId === b, 'الرمية السريعة الناجحة تُربك المستلم');
  const pv = Engine.getPublicView(s, b);
  assert(pv.confused === true, 'العرض يجب أن يعلن أن صاحب الدور مُربَك');
  const expected = C.THROWS.accurate.width * 100 * C.ZONE_SHRINK[Engine.zoneOf(s.danger)] * C.CONFUSED_FACTOR;
  assert(Math.abs(pv.throwPreview.accurate.widthPct - expected) <= 0.51, 'منطقة المُربَك يجب أن تكون أضيق 25% إضافيًا');
  assert(pv.throwPreview.safe.widthPct === 85, 'التسليم الآمن لا يتأثر بالإرباك');
  const c = s.players.find((p) => p.id !== a && p.id !== b).id;
  startThrow(s, 'accurate', c, 1200);
  assert(s.confusedId === null, 'الإرباك يُستهلك بأول رمية فقط');
  console.log('✓ الرمية السريعة تُربك المستلم: منطقة رميته الأولى أضيق 25% ثم يزول');
}

function testSlipKeepsBombAndRaisesDanger() {
  const s = freshState(3, 9);
  s.danger = 30;
  s.startedAt = -20000;
  const h = s.bombHolderId;
  startThrow(s, 'accurate', otherThan(s, h), 0);
  const before = s.danger;
  const r = releaseMiss(s, 100);
  assert(r.ok && r.effects.some((e) => e.type === 'SLIP'), 'الرمية الفاشلة يجب أن تنتج تأثير SLIP');
  assert(s.bombHolderId === h, 'عند الإفلات تبقى القنبلة مع نفس اللاعب');
  const jump = s.danger - before;
  assert(jump >= C.SLIP_DANGER[0] - 1e-9 && jump <= C.SLIP_DANGER[1] * 1.5, `قفزة الخطر عند الإفلات خارج النطاق: ${jump}`);
  assert(s.phase === P.READY || s.phase === P.DEFUSE_READY, 'بعد الإفلات يعود اللاعب لاختيار رمية جديدة (أو فكّ الفتيل إن وصل للأحمر)');
  assert(holder(s).score === 0, 'الإفلات لا يمنح نقاطًا');
  console.log('✓ الإفلات: القنبلة تبقى معك، الخطر يقفز، ولا نقاط');
}

function testRedZoneForcesDefuse() {
  const s = freshState(3, 10);
  s.danger = 70;
  const a = s.bombHolderId;
  const b = otherThan(s, a);
  startThrow(s, 'accurate', b, 40000);
  releaseCenter(s, 41000); // +15..22 → أحمر عند المستلم
  assert(s.danger >= C.ZONE_RED, `يجب الوصول للأحمر - الخطر ${s.danger}`);
  assert(s.phase === P.DEFUSE_READY && s.bombHolderId === b, 'المستلم في الأحمر يجب أن يكون في مرحلة فكّ الفتيل');
  const acts = Engine.getAvailableActions(s, b);
  assert(acts.some((x) => x.type === A.START_DEFUSE), 'يجب توفر START_DEFUSE');
  assert(!acts.some((x) => x.type === A.START_THROW), 'ممنوع الرمي في المنطقة الحمراء');
  assert(!startThrow(s, 'safe', otherThan(s, b), 41500).ok, 'محاولة الرمي في الأحمر يجب أن تُرفض');
  console.log('✓ المنطقة الحمراء تمنع الرمي وتفرض فكّ الفتيل');
}

function testDefuseSuccessAndFailure() {
  let s = freshState(2, 12);
  s.danger = 90; s.phase = P.DEFUSE_READY;
  const h = s.bombHolderId;
  assert(Engine.applyAction(s, h, { type: A.START_DEFUSE }, 50000).ok, 'بدء فكّ الفتيل');
  assert(s.phase === P.AIM && s.aim.kind === 'defuse', 'يجب الدخول لمرحلة AIM بنوع defuse');
  assert(Math.abs((s.aim.zoneEnd - s.aim.zoneStart) - C.DEFUSE.width) < 1e-9, 'عرض منطقة فكّ الفتيل ثابت');
  const r = releaseCenter(s, 51000);
  assert(r.ok && s.danger === C.AFTER_DEFUSE_DANGER && s.phase === P.READY && s.bombHolderId === h, 'نجاح الفكّ: يهبط الخطر وتبقى القنبلة معك');
  assert(holder(s).score === C.DEFUSE.points, `نجاح الفكّ يمنح ${C.DEFUSE.points} نقاط`);

  s = freshState(3, 13);
  const h2 = s.bombHolderId;
  const hp0 = holder(s).hearts;
  s.players.forEach((p) => { p.hearts = 3; p.maxHearts = 3; }); // نضمن عدم الإقصاء في هذا الاختبار
  const r2 = forceExplosion(s, 50000);
  assert(r2.ok && r2.effects.some((e) => e.type === 'EXPLODE'), 'فشل الفكّ يجب أن ينتج انفجارًا');
  const p = s.players.find((x) => x.id === h2);
  assert(p.hearts === 2 && p.alive, 'الانفجار يخسّر قلبًا واحدًا فقط دون إقصاء');
  assert(s.danger === C.NEW_BOMB_BASE, `القنبلة الجديدة الأولى تبدأ بخطر ${C.NEW_BOMB_BASE} - الفعلي ${s.danger}`);
  assert(s.phase === P.READY && s.bombHolderId !== h2, 'القنبلة الجديدة تذهب للاعب الأقل حملًا (ليس المنفجرة عنده)');
  assert(hp0 >= 1, 'sanity');
  console.log('✓ فكّ الفتيل: النجاح يخفض الخطر ويمنح نقاطًا، والفشل ينفجر ويخسّر قلبًا ثم تبدأ قنبلة جديدة');
}

function testDefuseOncePerBomb() {
  const s = freshState(3, 31);
  s.danger = 90; s.phase = P.DEFUSE_READY;
  Engine.applyAction(s, s.bombHolderId, { type: A.START_DEFUSE }, 50000);
  releaseCenter(s, 51000);
  assert(s.bombDefused === true, 'بعد أول فكّ ناجح تصبح القنبلة "منهكة"');
  const pv = Engine.getPublicView(s, s.bombHolderId);
  assert(pv.bombDefused === true, 'العرض يعلن أن القنبلة منهكة');
  // الآن أي دخول للأحمر = انفجار فوري بلا فرصة فكّ
  s.players.forEach((p) => { p.hearts = 3; p.maxHearts = 3; });
  s.danger = 72;
  const a = s.bombHolderId;
  const b = otherThan(s, a);
  startThrow(s, 'accurate', b, 52000);
  const rr = releaseCenter(s, 53000);
  assert(rr.effects.some((e) => e.type === 'EXPLODE'), 'القنبلة المنهكة: دخول الأحمر = انفجار فوري');
  assert(!rr.effects.some((e) => e.type === 'RED'), 'لا مرحلة فكّ فتيل ثانية لنفس القنبلة');
  assert(s.bombDefused === false, 'القنبلة الجديدة بعد الانفجار تعود قابلة للفكّ');
  console.log('✓ فكّ الفتيل ممكن مرة واحدة لكل قنبلة؛ بعدها الأحمر = انفجار فوري، والقنبلة الجديدة تعود طبيعية');
}

function testNewBombsGetHotter() {
  const s = freshState(3, 32);
  s.players.forEach((p) => { p.hearts = 9; p.maxHearts = 9; });
  const dangers = [];
  for (let k = 1; k <= 8; k++) {
    forceExplosion(s, 50000 + k * 5000);
    dangers.push(s.danger);
  }
  for (let k = 1; k <= 8; k++) {
    const expected = Math.min(C.NEW_BOMB_MAX, C.NEW_BOMB_BASE + C.NEW_BOMB_STEP * (k - 1));
    assert(Math.abs(dangers[k - 1] - expected) < 1e-9, `خطر القنبلة الجديدة رقم ${k}: متوقع ${expected} - الفعلي ${dangers[k - 1]}`);
  }
  assert(dangers[dangers.length - 1] <= C.NEW_BOMB_MAX, 'سقف حرارة القنبلة الجديدة');
  assert(dangers[3] > dangers[0], 'القنابل الجديدة تزداد سخونة مع تقدم الجولة');
  console.log(`✓ خط سير متصاعد: كل قنبلة جديدة أسخن (${dangers.join(' → ')}) حتى سقف ${C.NEW_BOMB_MAX}`);
}

function testHeartsEliminationAndWinner() {
  const s = freshState(2, 14);
  const h = s.bombHolderId;
  const other = otherThan(s, h);
  const hearts = s.players.find((p) => p.id === h).maxHearts;
  assert(hearts === C.HEARTS_BY_PLAYERS[2], 'عدد القلوب يطابق الجدول');
  for (let i = hearts; i >= 1; i--) {
    s.bombHolderId = h;
    const r = forceExplosion(s, 50000 + i * 4000);
    assert(r.ok, 'الانفجار يجب أن يُنفَّذ');
    const hp = s.players.find((p) => p.id === h);
    assert(hp.hearts === i - 1, `القلوب بعد الانفجار: متوقع ${i - 1} - الفعلي ${hp.hearts}`);
    if (i > 1) assert(hp.alive, 'لا إقصاء قبل نفاد القلوب');
  }
  const hp = s.players.find((p) => p.id === h);
  assert(!hp.alive && s.phase === P.FINISHED && s.winnerId === other, 'نفاد القلوب يقصي اللاعب ويفوز الأخير');
  assert(hp.hearts === 0, 'القلوب لا تكون سالبة');
  [2, 3, 4, 5, 6].forEach((n) => {
    const st = freshState(n, 15);
    assert(st.players.every((p) => p.hearts === C.HEARTS_BY_PLAYERS[n]), `عدد القلوب لـ${n} لاعبين`);
  });
  console.log('✓ القلوب: كل انفجار يخسّر قلبًا، والإقصاء عند الصفر فقط، والفائز هو الباقي، وعدد القلوب حسب عدد اللاعبين');
}

function testShieldPurchaseAndAbsorb() {
  const s = freshState(3, 15);
  const h = s.bombHolderId;
  const p = holder(s);
  p.score = 25;
  let r = Engine.applyAction(s, h, { type: A.BUY_SHIELD }, 1000);
  assert(r.ok && p.shield && p.score === 25 - C.SHIELD_COST, 'شراء الدرع يخصم 20 نقطة');
  assert(!Engine.applyAction(s, h, { type: A.BUY_SHIELD }, 1100).ok, 'لا يجوز شراء درع ثانٍ وهو يملك واحدًا');
  r = forceExplosion(s, 50000);
  assert(r.effects.some((e) => e.type === 'EXPLODE' && e.shieldUsed), 'الدرع يمتص الانفجار');
  assert(p.hearts === p.maxHearts && !p.shield, 'الدرع يُستهلك والقلوب كما هي');
  p.score = 100;
  s.bombHolderId = h; s.phase = P.READY;
  assert(!Engine.applyAction(s, h, { type: A.BUY_SHIELD }, 52000).ok, 'سقف الشراء: درع واحد فقط لكل لاعب في الجولة');
  // الشراء ممكن أيضًا وأنت في المنطقة الحمراء (قرار تكتيكي)
  const s2 = freshState(3, 16);
  holder(s2).score = 30; s2.danger = 90; s2.phase = P.DEFUSE_READY;
  assert(Engine.getAvailableActions(s2, s2.bombHolderId).some((a) => a.type === A.BUY_SHIELD), 'شراء الدرع متاح في المنطقة الحمراء');
  console.log('✓ الدرع: يُشترى بـ20 نقطة (حتى في الأحمر)، يمتص انفجارًا واحدًا، ودرع واحد لكل لاعب في الجولة');
}

function testPointsAwarded() {
  const cases = [
    { type: 'accurate', danger: 10, expect: 2 + 1 },
    { type: 'fast', danger: 10, expect: 2 + 3 },
    { type: 'safe', danger: 10, expect: 2 + 0 },
    { type: 'accurate', danger: 40, expect: 4 + 1 },
    { type: 'fast', danger: 70, expect: 6 + 3 },
  ];
  cases.forEach((c) => {
    const s = freshState(3, 16);
    s.danger = c.danger;
    const h = s.bombHolderId;
    startThrow(s, c.type, otherThan(s, h), 1000);
    releaseCenter(s, 1100);
    const got = s.players.find((p) => p.id === h).score;
    assert(got === c.expect, `نقاط رمية ${c.type} عند خطر ${c.danger}: متوقع ${c.expect} - الفعلي ${got}`);
  });
  const s = freshState(3, 17);
  s.danger = 10; s.doublePoints = true;
  const h = s.bombHolderId;
  startThrow(s, 'accurate', otherThan(s, h), 1000);
  releaseCenter(s, 1100);
  assert(s.players.find((p) => p.id === h).score === 6, 'نقاط الرمية بعد "الانحشار" تتضاعف');
  console.log('✓ النقاط: القيمة الصحيحة بالضبط لكل نوع رمية ومنطقة، وتتضاعف بعد حدث الانحشار');
}

function testEventsAreExplainableAndImpactful() {
  const mk = (type) => {
    const s = freshState(3, 18);
    s.danger = 40;
    const h = s.bombHolderId;
    if (type === 'SURGE') s.pendingEvent = { type, title: 't', options: [
      { id: 'brave', label: 'a', dangerDelta: C.SURGE_DANGER, points: C.POINTS_SURGE_BRAVE },
      { id: 'cool', label: 'b', dangerDelta: C.COOL_DANGER, points: C.POINTS_SURGE_COOL, confuse: true }] };
    if (type === 'MALFUNCTION') s.pendingEvent = { type, title: 't', options: [
      { id: 'ok', label: 'a', forcedTargetId: otherThan(s, h), doublePoints: true }] };
    if (type === 'BOLD_MOMENT') s.pendingEvent = { type, title: 't', options: [
      { id: 'safe', label: 'a', dangerDelta: 0, points: C.POINTS_BOLD_SAFE },
      { id: 'gamble', label: 'b', dangerDelta: C.BOLD_GAMBLE_DANGER, pointsRange: C.POINTS_BOLD_GAMBLE_RANGE }] };
    s.phase = P.EVENT_PENDING;
    return s;
  };
  let s = mk('SURGE');
  let d0 = s.danger;
  Engine.applyAction(s, s.bombHolderId, { type: A.RESOLVE_EVENT, choiceId: 'brave' }, 40000);
  assert(Math.abs(s.danger - (d0 + 10)) < 1e-9 && holder(s).score === 4 && s.phase === P.READY, 'SURGE-تحمّل: خطر +10 ونقاط +4');
  s = mk('SURGE'); d0 = s.danger;
  Engine.applyAction(s, s.bombHolderId, { type: A.RESOLVE_EVENT, choiceId: 'cool' }, 40000);
  assert(Math.abs(s.danger - (d0 - 8)) < 1e-9 && s.confusedId === s.bombHolderId, 'SURGE-تبريد: خطر −8 ورميتك القادمة أضيق');
  s = mk('MALFUNCTION');
  const forced = s.pendingEvent.options[0].forcedTargetId;
  Engine.applyAction(s, s.bombHolderId, { type: A.RESOLVE_EVENT, choiceId: 'ok' }, 40000);
  const targets = Engine._internal.legalTargets(s, s.bombHolderId);
  assert(targets.length === 1 && targets[0] === forced, 'MALFUNCTION: الهدف مفروض فعليًا');
  assert(s.doublePoints === true, 'MALFUNCTION: نقاط مضاعفة');
  for (let t = 0; t < 40; t++) {
    s = mk('BOLD_MOMENT');
    d0 = s.danger;
    Engine.applyAction(s, s.bombHolderId, { type: A.RESOLVE_EVENT, choiceId: 'gamble' }, 40000 + t);
    const gained = holder(s).score;
    assert(gained >= C.POINTS_BOLD_GAMBLE_RANGE[0] && gained <= C.POINTS_BOLD_GAMBLE_RANGE[1], `نقاط المجازفة خارج النطاق المعلن: ${gained}`);
    assert(Math.abs(s.danger - (d0 + 10)) < 1e-9, 'المجازفة ترفع الخطر +10 فعليًا');
  }
  s = mk('BOLD_MOMENT');
  Engine.applyAction(s, s.bombHolderId, { type: A.RESOLVE_EVENT, choiceId: 'safe' }, 40000);
  assert(holder(s).score === 4 && s.danger === 40, 'أمّن نقاطك: +4 بدون تغيير الخطر');
  s = mk('SURGE'); s.danger = 75;
  Engine.applyAction(s, s.bombHolderId, { type: A.RESOLVE_EVENT, choiceId: 'brave' }, 50000);
  assert(s.phase === P.DEFUSE_READY, 'حدث يدفع الخطر للأحمر يجب أن يُدخل صاحبه مرحلة فكّ الفتيل');
  console.log('✓ الأحداث: لكل حدث أثر فعلي ومعلن (خطر/نقاط/إرباك/هدف مفروض) ولا تقرر الفائز');
}

function testEventsAppearInNaturalPlay() {
  const seen = { SURGE: 0, MALFUNCTION: 0, BOLD_MOMENT: 0 };
  let games = 0;
  for (let n = 3; n <= 6; n++) {
    for (let s = 1; s <= 25; s++) {
      const rng = createRng(777 + s * 3 + n);
      const state = Engine.createGame(Array.from({ length: n }, (_, i) => 'p' + i), 6000 + s * 13 + n, 0);
      let clock = 0;
      let steps = 0;
      while (state.phase !== P.FINISHED && steps++ < 5000) {
        const pid = state.bombHolderId;
        const act = chooseAction(state, pid, 'good', rng);
        clock += decisionTime(act, rng);
        const res = Engine.applyAction(state, pid, act, clock);
        if (!res.ok) break;
        res.effects.forEach((e) => { if (e.type === 'EVENT') seen[e.eventType]++; });
        clock += animationTime(res.effects);
      }
      games++;
    }
  }
  const total = seen.SURGE + seen.MALFUNCTION + seen.BOLD_MOMENT;
  console.log(`  أحداث لكل جولة: ${(total / games).toFixed(2)} (ارتفاع ${seen.SURGE} | انحشار ${seen.MALFUNCTION} | جرأة ${seen.BOLD_MOMENT})`);
  assert(seen.SURGE > 0 && seen.MALFUNCTION > 0 && seen.BOLD_MOMENT > 0, 'كل أنواع الأحداث الثلاثة يجب أن تظهر في اللعب الطبيعي');
  assert(total / games >= 0.5, 'الأحداث يجب أن تظهر بما يكفي ليشعر بها اللاعبون (نصف حدث لكل جولة على الأقل)');
  console.log('✓ الأحداث المفاجئة تظهر فعليًا في اللعب الطبيعي بأنواعها الثلاثة');
}

function testSuddenDeath() {
  const s = freshState(4, 19);
  s.players.forEach((p) => { p.hearts = 3; p.shield = true; });
  s.danger = 10;
  const h = s.bombHolderId;
  startThrow(s, 'accurate', otherThan(s, h), 200000);
  const r = releaseCenter(s, 201000);
  assert(r.effects.some((e) => e.type === 'SUDDEN_DEATH') || s.suddenDeath, 'يجب إعلان وضع الحسم بعد المدة الداخلية');
  Engine._internal.alivePlayers(s).forEach((p) => assert(p.hearts === 1 && !p.shield, 'وضع الحسم: قلب واحد وبلا دروع'));
  assert(s.danger >= C.SUDDEN_START_DANGER, 'وضع الحسم يرفع الخطر للحد الأدنى');
  const s2 = freshState(3, 20);
  s2.suddenDeath = true;
  s2.players.forEach((p) => { p.hearts = 1; });
  s2.danger = 78;
  const a = s2.bombHolderId;
  startThrow(s2, 'accurate', otherThan(s2, a), 200000);
  const rr = releaseCenter(s2, 201000);
  assert(rr.effects.some((e) => e.type === 'EXPLODE' && e.eliminated), 'في الحسم: دخول الأحمر ينفجر فورًا ويُقصي الحامل');
  assert(!rr.effects.some((e) => e.type === 'RED'), 'لا مرحلة فكّ فتيل في وضع الحسم');
  const s3 = freshState(3, 21);
  s3.suddenDeath = true; holder(s3).score = 100;
  assert(!Engine.applyAction(s3, s3.bombHolderId, { type: A.BUY_SHIELD }, 1000).ok, 'ممنوع شراء الدروع في وضع الحسم');
  console.log('✓ وضع الحسم: قلب واحد للجميع، لا دروع، والأحمر = انفجار فوري');
}

function testPauseFreezesEverything() {
  const s = freshState(3, 23);
  const h = s.bombHolderId;
  startThrow(s, 'accurate', otherThan(s, h), 10000);
  const cursorAtPause = Engine.cursorAt(s.aim, 10700);
  Engine.pauseGame(s, 10700);
  const zone0 = s.aim.zoneStart;
  assert(!Engine.applyAction(s, h, { type: A.RELEASE, cursor: 0.5 }, 11000).ok, 'لا أفعال أثناء Pause');
  assert(Engine.getAvailableActions(s, h).length === 0, 'لا أفعال متاحة أثناء Pause');
  Engine.resumeGame(s, 70700);
  assert(s.totalPausedMs === 60000, `وقت Pause يجب أن يُحتسب بدقة - ${s.totalPausedMs}`);
  assert(Math.abs(Engine.cursorAt(s.aim, 70700) - cursorAtPause) < 1e-9, 'المؤشر يستأنف من نفس موضعه تمامًا بعد Resume');
  assert(s.aim.zoneStart === zone0, 'منطقة النجاح لا تتغير بعد Resume');
  assert(Engine._internal.effectiveElapsed(s, 70700) === 10700, 'وقت الـPause لا يدخل في مدة الجولة');
  console.log('✓ Pause: يجمّد الأفعال والمؤشر والزمن الداخلي، والاستئناف يكمل من نفس اللحظة بالضبط');
}

function testRefreshRestoresExactState() {
  const checks = [];
  let s = freshState(4, 24); checks.push(['READY', s]);
  s = freshState(4, 25); startThrow(s, 'fast', otherThan(s, s.bombHolderId), 5000); checks.push(['AIM-throw', s]);
  s = freshState(3, 26); s.danger = 90; s.phase = P.DEFUSE_READY; checks.push(['DEFUSE_READY', s]);
  s = freshState(3, 27); s.danger = 90; s.phase = P.DEFUSE_READY; Engine.applyAction(s, s.bombHolderId, { type: A.START_DEFUSE }, 5000); checks.push(['AIM-defuse', s]);
  s = freshState(3, 28); s.pendingEvent = { type: 'BOLD_MOMENT', title: 't', options: [{ id: 'safe', label: 'a', desc: 'd', points: 4 }] }; s.phase = P.EVENT_PENDING; checks.push(['EVENT', s]);
  s = freshState(3, 29); s.confusedId = s.bombHolderId; s.forcedTargetId = otherThan(s, s.bombHolderId); s.doublePoints = true; s.bombDefused = true; checks.push(['flags', s]);
  checks.forEach(([name, st]) => {
    const before = JSON.stringify(Engine.getPublicView(st, st.bombHolderId));
    const restored = Engine.deserialize(Engine.serialize(st));
    const after = JSON.stringify(Engine.getPublicView(restored, restored.bombHolderId));
    assert(before === after, `Refresh أثناء ${name} غيّر الحالة المعروضة`);
    assert(Engine.serialize(restored) === Engine.serialize(st), `التسلسل بعد الاستعادة يجب أن يطابق الأصل (${name})`);
    if (st.aim) assert(JSON.stringify(restored.aim) === JSON.stringify(st.aim), `منطقة النجاح/المؤشر تغيّرا بعد Refresh (${name})`);
  });
  console.log('✓ Refresh في كل المراحل (قرار/تصويب رمية/تصويب فكّ/فكّ جاهز/حدث/أعلام) يعيد نفس الحالة تمامًا بما فيها منطقة النجاح');
}

function testFairnessAcrossSeats() {
  const N = 600;
  const wins = [0, 0, 0, 0];
  const first = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) {
    const st = Engine.createGame(['a', 'b', 'c', 'd'], i * 31 + 5, 0);
    first[Number(st.bombHolderId.slice(1))]++;
    const { state } = runGame(4, i * 31 + 5, ['good']);
    wins[Number(state.winnerId.slice(1))]++;
  }
  const expected = N / 4;
  console.log(`  توزيع الفوز حسب الترتيب (4 لاعبين متساوين، ${N} جولة): ${wins.map((w) => (w / N * 100).toFixed(1) + '%').join(' | ')}`);
  console.log(`  توزيع أول حامل للقنبلة: ${first.map((w) => (w / N * 100).toFixed(1) + '%').join(' | ')}`);
  wins.forEach((w, i) => assert(Math.abs(w - expected) / expected < 0.3, `انحراف كبير في فوز المقعد ${i}: ${w}`));
  first.forEach((w, i) => assert(Math.abs(w - expected) / expected < 0.3, `انحراف كبير في أول حامل المقعد ${i}: ${w}`));
  console.log('✓ لا أفضلية لأول/آخر لاعب في الترتيب ولا لأول حامل للقنبلة (لاعبون متساوون)');
}

function testSkillMattersButDoesNotGuarantee() {
  let skilledWins = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    const { state } = runGame(4, 9000 + i, ['perfect', 'random', 'random', 'random']);
    if (state.winnerId === 'p0') skilledWins++;
  }
  const rate = skilledWins / N;
  console.log(`  نسبة فوز لاعب ماهر جدًا ضد 3 عشوائيين: ${(rate * 100).toFixed(1)}% (العادل 25%)`);
  assert(rate > 0.35, `المهارة يجب أن تؤثر على الفوز - النسبة ${rate}`);
  assert(rate < 1, 'الفوز لا يجب أن يكون حتميًا بالمهارة وحدها');

  let goodWins = 0;
  for (let i = 0; i < N; i++) {
    const { state } = runGame(4, 9500 + i, ['good', 'poor', 'poor', 'poor']);
    if (state.winnerId === 'p0') goodWins++;
  }
  console.log(`  نسبة فوز لاعب جيد ضد 3 ضعاف: ${(goodWins / N * 100).toFixed(1)}%`);
  assert(goodWins / N > 0.27, 'اللاعب الجيد يجب أن يتفوق على الضعيف إحصائيًا');
  console.log('✓ المهارة تزيد فرص الفوز بوضوح دون أن تجعله حتميًا');
}

function testIndependentSessions() {
  const a = Engine.createGame(['A1', 'A2'], 1, 0);
  const b = Engine.createGame(['B1', 'B2', 'B3'], 2, 0);
  a.danger = 10; b.danger = 10;
  startThrow(a, 'accurate', otherThan(a, a.bombHolderId), 1000);
  Engine.pauseGame(a, 1100);
  assert(b.phase === P.READY && b.aim === null, 'Pause/رمية في الجلسة A لا تؤثر على B');
  assert(a.players.length === 2 && b.players.length === 3, 'كل جلسة تحتفظ بلاعبيها فقط');
  console.log('✓ عزل تام بين جلستين (لا تسرب حالة)');
}

function testScoresNonNegativeAndNames() {
  for (let n = 2; n <= 6; n++) {
    const { state } = runGame(n, 777 + n, SKILL_MIX);
    state.players.forEach((p) => {
      assert(Number.isFinite(p.score) && p.score >= 0, `نقاط سالبة/غير صالحة: ${p.score}`);
      assert(p.hearts >= 0 && p.hearts <= p.maxHearts, `قلوب خارج النطاق: ${p.hearts}`);
    });
  }
  const s = Engine.createGame(['أحمد', 'Mohamed', 'سارة بنت علي الطويلة جدًا جدًا'], 3, 0);
  assert(s.players[0].name === 'أحمد' && s.players[1].name === 'Mohamed', 'الأسماء العربية والإنجليزية تُحفظ كما هي');
  console.log('✓ النقاط والقلوب ضمن نطاقاتها دائمًا، والأسماء العربية/الإنجليزية/الطويلة مدعومة');
}

console.log('=== بدء الاختبارات الآلية لمحرك "رمية القنبلة" ===\n');
const tests = [
  testExactlyOneWinnerNoTies,
  testRoundDurationBounds,
  testSuddenDeathIsTheExceptionNotTheRule,
  testNoExplosionBeforeMinimumTime,
  testIllegalActionsRejected,
  testBackThrowRestriction,
  testZoneShrinkAndSafeImmunity,
  testThrowTypesAreDistinct,
  testConfusionAppliesOnceToReceiver,
  testSlipKeepsBombAndRaisesDanger,
  testRedZoneForcesDefuse,
  testDefuseSuccessAndFailure,
  testDefuseOncePerBomb,
  testNewBombsGetHotter,
  testHeartsEliminationAndWinner,
  testShieldPurchaseAndAbsorb,
  testPointsAwarded,
  testEventsAreExplainableAndImpactful,
  testEventsAppearInNaturalPlay,
  testSuddenDeath,
  testPauseFreezesEverything,
  testRefreshRestoresExactState,
  testFairnessAcrossSeats,
  testSkillMattersButDoesNotGuarantee,
  testIndependentSessions,
  testScoresNonNegativeAndNames,
];
tests.forEach((t) => {
  try { t(); } catch (e) { failures.push(`${t.name} تعطل: ${e.stack}`); }
});

console.log('\n=== النتيجة ===');
if (failures.length === 0) {
  console.log(`✅ نجحت جميع الاختبارات (${tests.length} مجموعات اختبار)`);
  process.exit(0);
} else {
  console.log(`❌ فشل ${failures.length} تحقق:`);
  failures.slice(0, 25).forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
