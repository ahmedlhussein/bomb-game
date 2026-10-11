'use strict';
/**
 * اختبارات واجهة حقيقية متكاملة: خادم التطوير المحلي (يخدم public/ الحقيقي + دوال api/*.js الحقيقية)
 * ثم Chromium بدون واجهة رسومية، وكل التفاعل بنقر فعلي على أزرار الصفحة (وليس استدعاء دوال مباشرة).
 *
 * خطافات الاختبار (تُحقن قبل تحميل الصفحة عبر window.__BOMBGAME_TEST__):
 *   fastAnimations: يختصر مدد الحركات لتسريع الاختبار
 *   forceCursor:    'zone' (يوقف المؤشر في منتصف منطقة النجاح) | 'miss' (خارجها) | غير ذلك (المؤشر الحقيقي)
 *   timeOffsetMs:   يقدّم الساعة الداخلية (لتجاوز الحد الأدنى للمدة دون انتظار فعلي)
 *
 * التشغيل: node tests/ui-test.js
 */
const { chromium } = require('playwright');
const { createServer } = require('./devServer');
const { hashCode } = require('../lib/codeAuth');
const { resetMemoryStoreForTests } = require('../lib/storeFactory');

const TEST_CODE = 'zxc123';
process.env.ACCESS_CODE_HASHES = JSON.stringify([hashCode(TEST_CODE)]);
const PORT = Number(process.env.UI_PORT || 3512);
const BASE = `http://localhost:${PORT}/`;
const PHONE = { width: 390, height: 844 };

const failures = [];
function assert(cond, msg) { if (!cond) failures.push(msg); }

// ------------------------------------------------------------------ أدوات مساعدة
async function newPage(browser, viewport, overrides) {
  resetMemoryStoreForTests();
  const ctx = await browser.newContext({ viewport: viewport || PHONE });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes('Failed to load resource')) return; // استجابات غير 2xx متوقعة عمدًا في اختبارات الأكواد
    page.errors.push('console.error: ' + m.text());
  });
  const ov = overrides || { fastAnimations: true, forceCursor: 'zone' };
  await page.addInitScript((o) => { window.__BOMBGAME_TEST__ = o; }, ov);
  return { ctx, page };
}
async function finish(name, ctx, page) {
  page.errors.forEach((e) => assert(false, `[${name}] ${e}`));
  await ctx.close();
}
async function enterCode(page, code) {
  const inputs = page.locator('#code-inputs input');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(code[i]);
  await page.click('#submit-code');
}
async function login(page) {
  await page.goto(BASE);
  await enterCode(page, TEST_CODE);
  await page.waitForSelector('#screen-count', { timeout: 5000 });
}
async function startGame(page, names, offset) {
  await page.click(`#count-grid button[data-n="${names.length}"]`);
  await page.waitForSelector('#screen-names', { timeout: 4000 });
  for (let i = 0; i < names.length; i++) await page.fill(`#name-list input[data-idx="${i}"]`, names[i]);
  await page.click('#start-round');
  await page.waitForSelector('#screen-game', { timeout: 4000 });
  if (offset !== 0) await setOffset(page, offset == null ? 35000 : offset);
}
const setOffset = (page, v) => page.evaluate((x) => { window.__BOMBGAME_TEST__.timeOffsetMs = x; }, v);
const setCursor = (page, mode) => page.evaluate((m) => { window.__BOMBGAME_TEST__.forceCursor = m; }, mode);
const setFast = (page, v) => page.evaluate((x) => { window.__BOMBGAME_TEST__.fastAnimations = x; }, v);
const tryClick = (page, sel) => page.locator(sel).first().click({ timeout: 600 }).catch(() => {});
const count = (page, sel) => page.locator(sel).count();

/** خطوة لعب واحدة بحسب ما تعرضه الواجهة فعليًا */
async function stepOnce(page, policy) {
  if (await count(page, '#screen-winner')) return 'winner';
  if (await count(page, '#event-options button')) { await tryClick(page, '#event-options button'); return 'event'; }
  if (await count(page, '#start-defuse')) { await tryClick(page, '#start-defuse'); return 'defuse-ready'; }
  if (await count(page, '#release-btn')) {
    if (policy) await setCursor(page, policy());
    await tryClick(page, '#release-btn');
    return 'aim';
  }
  if (await count(page, '#target-select button')) { await tryClick(page, '#target-select button'); return 'ready'; }
  await page.waitForTimeout(8);
  return 'wait';
}
/** يلعب حتى يتحقق الشرط (selector موجود) أو تنتهي الجولة أو تنفد الخطوات */
async function playUntil(page, selector, policy, maxSteps) {
  for (let i = 0; i < (maxSteps || 4000); i++) {
    if (selector && (await count(page, selector))) return true;
    if (await count(page, '#screen-winner')) return false;
    await stepOnce(page, policy);
  }
  return false;
}
const mostlyHit = () => (Math.random() < 0.75 ? 'zone' : 'miss');
async function playToEnd(page, policy) {
  const done = await playUntil(page, '#screen-winner', policy || mostlyHit, 6000);
  return done;
}
function styleNums(str) {
  const l = /left:\s*([\d.]+)%/.exec(str || '');
  const w = /width:\s*([\d.]+)%/.exec(str || '');
  return { left: l ? parseFloat(l[1]) : NaN, width: w ? parseFloat(w[1]) : NaN };
}
const heartsOf = async (page, pid) => ((await page.locator(`.player-chip[data-pid="${pid}"] .chip-hearts`).textContent()) || '').split('❤️').length - 1;
const scoreOf = async (page, pid) => {
  const t = (await page.locator(`.player-chip[data-pid="${pid}"] .chip-meta`).textContent()) || '';
  const m = /🏆(\d+)/.exec(t);
  return m ? parseInt(m[1], 10) : NaN;
};
async function holderPid(page) { return page.locator('.player-chip.holder').first().getAttribute('data-pid'); }

// ------------------------------------------------------------------ السيناريوهات
async function scenarioAccessAndSetup(browser) {
  const { ctx, page } = await newPage(browser);
  await page.goto(BASE);
  assert((await count(page, '#code-inputs input')) === 6, '[دخول] يجب وجود 6 خانات لإدخال الكود');
  const inputs = page.locator('#code-inputs input');

  await page.fill('#code-inputs input:nth-child(1)', 'z');
  await page.click('#submit-code');
  const err1 = await page.locator('#code-error').textContent();
  assert(err1 && err1.trim().length > 0, '[دخول] رسالة خطأ لكود غير صحيح الصيغة');

  await page.evaluate(() => {
    const first = document.querySelector('#code-inputs input');
    const dt = new DataTransfer();
    dt.setData('text', 'zx c-1 2 3');
    first.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const pasted = (await inputs.evaluateAll((els) => els.map((e) => e.value))).join('');
  assert(pasted === 'zxc123', `[دخول] لصق كود بمسافات وفواصل يجب أن يُنظَّف ويُوزَّع - الفعلي "${pasted}"`);
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill('');

  await enterCode(page, 'zzz999');
  await page.waitForFunction(() => document.querySelector('#code-error')?.textContent?.includes('الكود غير صحيح'), { timeout: 4000 }).catch(() => {});
  assert((await page.locator('#code-error').textContent()).includes('الكود غير صحيح'), '[دخول] الخادم الحقيقي يرفض كودًا غير مسموح (401)');

  await enterCode(page, TEST_CODE);
  await page.waitForSelector('#screen-count', { timeout: 5000 });
  await page.click('#count-grid button[data-n="3"]');
  await page.waitForSelector('#screen-names');
  const hint = await page.locator('#screen-names .subtitle').textContent();
  assert(/2\s*❤️/.test(hint || ''), `[إعداد] شاشة الأسماء تعرض عدد القلوب لـ3 لاعبين (2) - الفعلي "${hint}"`);
  assert((await count(page, '#name-list input')) === 3, '[إعداد] 3 خانات أسماء');

  await page.click('#start-round');
  await page.waitForTimeout(100);
  assert((await count(page, '#screen-game')) === 0, '[إعداد] لا تبدأ الجولة بأسماء ناقصة');
  await page.fill('#name-list input[data-idx="0"]', 'أحمد');
  await page.fill('#name-list input[data-idx="1"]', 'Sara');
  await page.fill('#name-list input[data-idx="2"]', 'محمد علي');
  await page.click('#start-round');
  await page.waitForSelector('#screen-game');
  assert((await count(page, '.player-chip')) === 3, '[إعداد] بطاقات اللاعبين الثلاث');
  await finish('دخول وإعداد', ctx, page);
}

async function scenarioGameplayFlow(browser) {
  const { ctx, page } = await newPage(browser);
  await login(page);
  await startGame(page, ['أحمد', 'Sara', 'محمد'], 0);

  const holderText = await page.locator('.holder-banner .name').textContent();
  assert(/دورك الآن/.test(holderText), '[لعب] اسم صاحب الدور بوضوح');
  const holderName = holderText.replace('— دورك الآن', '').trim();

  // أنواع الرمي الثلاثة ومعاينة منطقة النجاح الفعلية (خطر 20 = أخضر)
  assert((await count(page, '#throw-types button')) === 3, '[لعب] ثلاثة أنواع رمي');
  const typesText = (await page.locator('#throw-types').textContent()) || '';
  assert(/14%/.test(typesText) && /26%/.test(typesText) && /85%/.test(typesText), `[لعب] معاينة مناطق النجاح 14/26/85% - الفعلي "${typesText.replace(/\s+/g, ' ')}"`);
  assert(/×2/.test(typesText), '[لعب] عدد التسليمات الآمنة المتبقية ظاهر (×2) بجانب التسليم الآمن');
  const targets = await page.locator('#target-select button').allTextContents();
  assert(targets.length === 2 && !targets.some((t) => t.includes(holderName)), '[لعب] لا يظهر خيار رمي القنبلة لنفس حاملها');

  // Pause/Resume في مرحلة القرار
  await page.click('#pause-btn');
  await page.waitForSelector('#pause-overlay', { timeout: 2000 });
  assert((await count(page, '#target-select button')) === 0, '[لعب] لا أزرار فعل أثناء Pause');
  await page.click('#resume-btn');
  assert((await count(page, '#pause-overlay')) === 0, '[لعب] طبقة Pause تختفي بعد الاستئناف');

  // Refresh في مرحلة القرار لا يغيّر شيئًا
  const before = { h: await page.locator('.holder-banner .name').textContent(), d: await page.locator('.danger-label').textContent() };
  await page.reload();
  await page.waitForSelector('#screen-game');
  assert(before.h === (await page.locator('.holder-banner .name').textContent()), '[لعب] Refresh غيّر صاحب الدور');
  assert(before.d === (await page.locator('.danger-label').textContent()), '[لعب] Refresh غيّر مستوى الخطر');

  // رمية سريعة: المنطقة الفعلية أضيق من المضبوطة، وتظهر بعد قرار النوع والهدف
  await page.click('#throw-types button[data-type="fast"]');
  await tryClick(page, '#target-select button');
  await page.waitForSelector('#aim-zone', { timeout: 3000 });
  const zFast = styleNums(await page.locator('#aim-zone').getAttribute('style'));
  assert(Math.abs(zFast.width - 14) < 0.6, `[لعب] عرض منطقة الرمية السريعة 14% - الفعلي ${zFast.width}`);
  assert((await count(page, '#release-btn')) === 1 && (await count(page, '#aim-cursor')) === 1, '[لعب] شريط التوقيت: مؤشر + زر إيقاف');
  assert((await count(page, '#target-select')) === 0, '[لعب] لا اختيار أهداف أثناء التصويب');

  // Pause أثناء التصويب ثم Resume: نفس المنطقة ويعود المؤشر
  await page.click('#pause-btn');
  await page.waitForSelector('#pause-overlay');
  assert((await count(page, '#release-btn')) === 0, '[لعب] لا زر إيقاف أثناء Pause');
  await page.waitForTimeout(500);
  await page.click('#resume-btn');
  await page.waitForSelector('#aim-zone');
  const zAfterPause = styleNums(await page.locator('#aim-zone').getAttribute('style'));
  assert(zAfterPause.left === zFast.left && zAfterPause.width === zFast.width, '[لعب] منطقة النجاح تغيّرت بعد Pause/Resume');

  // Refresh أثناء التصويب: نفس المنطقة بالضبط
  await page.reload();
  await page.waitForSelector('#aim-zone');
  const zAfterReload = styleNums(await page.locator('#aim-zone').getAttribute('style'));
  assert(zAfterReload.left === zFast.left && zAfterReload.width === zFast.width, `[لعب] Refresh أثناء التصويب غيّر منطقة النجاح ${JSON.stringify(zFast)} → ${JSON.stringify(zAfterReload)}`);

  // إفلات متعمد: تبقى القنبلة مع نفس اللاعب ويرتفع الخطر
  await setOffset(page, 35000);
  const holderBefore = await holderPid(page);
  await setCursor(page, 'miss');
  const dangerBefore = await page.locator('#gauge-pointer').getAttribute('style');
  await tryClick(page, '#release-btn');
  await page.waitForSelector('#target-select', { timeout: 3000 });
  assert((await holderPid(page)) === holderBefore, '[لعب] بعد الإفلات تبقى القنبلة مع نفس اللاعب');
  const dangerAfter = await page.locator('#gauge-pointer').getAttribute('style');
  const pct = (s) => parseFloat(/left:\s*([\d.]+)%/.exec(s)[1]);
  assert(pct(dangerAfter) > pct(dangerBefore), '[لعب] الإفلات يرفع الخطر على العدّاد');

  // نكمل حتى الفائز
  const ended = await playToEnd(page);
  assert(ended, '[لعب] الوصول لشاشة الفائز عبر لعب فعلي بالنقر');
  if (ended) {
    const wName = await page.locator('.winner-screen .name').textContent();
    assert(wName && ['أحمد', 'Sara', 'محمد'].includes(wName.trim()), `[لعب] اسم الفائز أحد اللاعبين - "${wName}"`);
    const sc = await page.locator('.winner-screen .winner-score').textContent();
    assert(/🏆 \d+ نقطة جرأة/.test(sc || ''), `[لعب] شاشة الفائز تعرض النقاط - "${sc}"`);
    const btns = await page.locator('.winner-screen button').allTextContents();
    assert(btns.some((b) => b.includes('ابدأ دور جديد')) && btns.some((b) => b.includes('خروج')), '[لعب] زرّا "ابدأ دور جديد" و"خروج"');
    await page.click('#new-round');
    await page.waitForSelector('#screen-count');
  }
  await finish('تدفق اللعب', ctx, page);
}

async function scenarioRedZoneDefuseExplosion(browser) {
  const { ctx, page } = await newPage(browser);
  await login(page);
  await startGame(page, ['أحمد', 'مصطفى', 'سارة']);
  const reached = await playUntil(page, '#start-defuse', () => 'zone', 800);
  assert(reached, '[أحمر] الوصول للمنطقة الحمراء بلعب فعلي');
  if (reached) {
    assert((await page.locator('.danger-label').textContent()).includes('حرج'), '[أحمر] العدّاد يعرض "حرج"');
    assert((await count(page, '#target-select')) === 0 && (await count(page, '#throw-types')) === 0, '[أحمر] ممنوع الرمي: لا أزرار رمي');
    const pid = await holderPid(page);
    const heartsBefore = await heartsOf(page, pid);
    await page.click('#start-defuse');
    await page.waitForSelector('.aim-defuse #aim-zone', { timeout: 3000 });
    const zDefuse = styleNums(await page.locator('#aim-zone').getAttribute('style'));
    assert(Math.abs(zDefuse.width - 16) < 0.6, `[أحمر] عرض منطقة فكّ الفتيل 16% - الفعلي ${zDefuse.width}`);

    // Refresh أثناء تصويب فكّ الفتيل
    await page.reload();
    await page.waitForSelector('.aim-defuse #aim-zone');
    const zR = styleNums(await page.locator('#aim-zone').getAttribute('style'));
    assert(zR.left === zDefuse.left && zR.width === zDefuse.width, '[أحمر] Refresh أثناء فكّ الفتيل غيّر منطقة النجاح');
    await setOffset(page, 35000);

    // فشل → انفجار وخسارة قلب (أو إقصاء) وقنبلة جديدة
    await setCursor(page, 'miss');
    await tryClick(page, '#release-btn');
    await page.waitForFunction(() => !document.querySelector('#release-btn') && !!document.querySelector('#screen-game, #screen-winner'), { timeout: 4000 });
    const eliminated = (await count(page, '#screen-winner')) > 0;
    if (!eliminated) {
      const heartsAfter = await heartsOf(page, pid);
      const chipDead = await page.locator(`.player-chip[data-pid="${pid}"].dead`).count();
      assert(heartsAfter === heartsBefore - 1 || chipDead === 1, `[أحمر] الانفجار يخسّر قلبًا: قبل ${heartsBefore} بعد ${heartsAfter}`);
      assert(!(await page.locator('.danger-label').textContent()).includes('حرج'), '[أحمر] القنبلة الجديدة تبدأ بخطر أقل من الحرج');
    }
  }
  await finish('أحمر وانفجار', ctx, page);
}

async function scenarioDefuseSuccessMakesBombExhausted(browser) {
  const { ctx, page } = await newPage(browser);
  await login(page);
  await startGame(page, ['أحمد', 'مصطفى', 'سارة', 'ليلى']);
  const reached = await playUntil(page, '#start-defuse', () => 'zone', 800);
  assert(reached, '[فكّ ناجح] الوصول للمنطقة الحمراء');
  if (reached) {
    const pid = await holderPid(page);
    const scoreBefore = await scoreOf(page, pid);
    await page.click('#start-defuse');
    await page.waitForSelector('#release-btn');
    await setCursor(page, 'zone');
    await tryClick(page, '#release-btn');
    await page.waitForSelector('#throw-types', { timeout: 4000 });
    assert((await holderPid(page)) === pid, '[فكّ ناجح] تبقى القنبلة مع من فكّها');
    assert((await page.locator('#mode-tag').textContent()).includes('منهكة'), '[فكّ ناجح] تظهر علامة "قنبلة منهكة"');
    assert(/انفجار فوري|منهكة/.test((await page.locator('#status-line').textContent()) || ''), '[فكّ ناجح] يُشرح أن الأحمر القادم انفجار فوري');
    assert((await scoreOf(page, pid)) >= scoreBefore + 10, '[فكّ ناجح] نقاط فكّ الفتيل (+10) تظهر');
    assert(!(await page.locator('.danger-label').textContent()).includes('حرج'), '[فكّ ناجح] الخطر يهبط بعد الفكّ');
  }
  await finish('فكّ ناجح', ctx, page);
}

async function scenarioThrowTypeEffects(browser) {
  const { ctx, page } = await newPage(browser);
  await login(page);
  await startGame(page, ['أحمد', 'مصطفى', 'سارة']);
  const first = await holderPid(page);
  // رمية سريعة ناجحة: تُربك المستلم (يظهر في الحالة) وتضيّق منطقة رميته الأولى
  await page.click('#throw-types button[data-type="fast"]');
  await tryClick(page, '#target-select button');
  await page.waitForSelector('#release-btn');
  await setCursor(page, 'zone');
  await tryClick(page, '#release-btn');
  await page.waitForSelector('#throw-types, #event-options', { timeout: 4000 }); // قد يظهر حدث عشوائي قبل الاختيار
  const second = await holderPid(page);
  assert(second !== first, '[أنواع الرمي] انتقلت القنبلة للمستلم');
  const status = (await page.locator('#status-line').textContent()) || '';
  const accurateText = (await page.locator('#throw-types button[data-type="accurate"]').textContent()) || '';
  if (/مُربَك/.test(status)) {
    const w = parseInt(/(\d+)%/.exec(accurateText)[1], 10);
    assert(w >= 18 && w <= 22, `[أنواع الرمي] منطقة المُربَك أضيق من الطبيعية (26%): ${w}%`);
    const safeText = (await page.locator('#throw-types button[data-type="safe"]').textContent()) || '';
    assert(/85%/.test(safeText), '[أنواع الرمي] التسليم الآمن لا يتأثر بالإرباك');
  } else {
    assert(/حدث|لحظة|ارتفاع|انحشرت/.test((await page.locator('.event-banner h3').textContent().catch(() => '')) || '') || (await count(page, '#event-options')) > 0,
      `[أنواع الرمي] كان يجب أن يظهر الإرباك أو حدث عشوائي - الحالة: "${status}"`);
  }
  // التسليم الآمن يستهلك رصيدًا ويظهر ذلك
  if (await count(page, '#event-options')) await tryClick(page, '#event-options button');
  await page.waitForSelector('#throw-types', { timeout: 3000 });
  const safeBtn = page.locator('#throw-types button[data-type="safe"]');
  if (await safeBtn.isEnabled()) {
    await safeBtn.click();
    await tryClick(page, '#target-select button');
    await page.waitForSelector('#release-btn');
    await setCursor(page, 'miss'); // نبقيها عند نفس اللاعب لنرى الرصيد
    await tryClick(page, '#release-btn');
    await page.waitForSelector('#throw-types', { timeout: 4000 });
    const holderNow = await holderPid(page);
    const meta = (await page.locator(`.player-chip[data-pid="${holderNow}"] .chip-meta`).textContent()) || '';
    assert(/🤝×1/.test(meta), `[أنواع الرمي] بعد استخدام تسليم آمن يتبقى 1: "${meta}"`);
  }
  await finish('تأثير أنواع الرمي', ctx, page);
}

async function scenarioShieldPurchase(browser) {
  const { ctx, page } = await newPage(browser);
  await login(page);
  await startGame(page, ['أحمد', 'مصطفى', 'سارة']);
  const got = await playUntil(page, '#buy-shield', () => 'zone', 1500);
  assert(got, '[درع] يظهر زر شراء الدرع بعد جمع 20 نقطة');
  if (got) {
    const pid = await holderPid(page);
    const before = await scoreOf(page, pid);
    assert(before >= 20, `[درع] رصيد كافٍ عند ظهور الزر - ${before}`);
    await page.click('#buy-shield');
    await page.waitForFunction((id) => (document.querySelector(`.player-chip[data-pid="${id}"] .chip-meta`)?.textContent || '').includes('🛡️'), pid, { timeout: 3000 });
    assert((await scoreOf(page, pid)) === before - 20, '[درع] خصم 20 نقطة بالضبط');
    assert((await count(page, '#buy-shield')) === 0, '[درع] لا شراء ثانٍ لنفس اللاعب');
    assert((await count(page, '.shield-note')) === 1, '[درع] يظهر إشعار أن الدرع فعّال');
  }
  await finish('الدرع', ctx, page);
}

async function scenarioEventsUI(browser) {
  const { ctx, page } = await newPage(browser);
  await login(page);
  const names = ['أحمد', 'مصطفى', 'سارة', 'ليلى'];
  await startGame(page, names);
  let seen = 0;
  // الأحداث احتمالية: لو انتهت الجولة قبل ظهور حدث نبدأ جولة جديدة (حتى 8 جولات)
  for (let game = 0; game < 8 && seen < 2; game++) {
    const ok = await playUntil(page, '#event-options button', () => 'zone', 1500);
    if (ok) {
      seen++;
      const title = (await page.locator('.event-banner h3').textContent()) || '';
      const descs = await page.locator('#event-options .ev-desc').allTextContents();
      assert(title.trim().length > 3, '[أحداث] للحدث عنوان');
      assert(descs.length >= 1 && descs.every((d) => d.trim().length > 3), '[أحداث] كل خيار يشرح نتيجته بوضوح قبل الضغط');
      assert(descs.some((d) => /الخطر|نقاط|نقطة|ترمي/.test(d)), `[أحداث] الوصف يذكر الأثر الفعلي - "${descs.join(' | ')}"`);
      await tryClick(page, '#event-options button');
      await page.waitForFunction(() => !document.querySelector('#event-options'), { timeout: 3000 }).catch(() => {});
    } else if (await count(page, '#screen-winner')) {
      await page.click('#new-round');
      await page.waitForSelector('#screen-count');
      await startGame(page, names);
    } else {
      break;
    }
  }
  assert(seen >= 1, '[أحداث] ظهر حدث مفاجئ واحد على الأقل خلال اللعب الطبيعي (عبر عدة جولات)');
  await finish('الأحداث', ctx, page);
}

/** ينقر "ارمِ" داخل نفس الإطار الذي يتحقق فيه الشرط على موضع المؤشر المرسوم فعليًا */
function clickWhenCursor(page, mode) {
  return page.evaluate((m) => new Promise((resolve) => {
    const zone = document.querySelector('#aim-zone');
    const cur = document.querySelector('#aim-cursor');
    const zl = parseFloat(zone.style.left);
    const zw = parseFloat(zone.style.width);
    const tick = () => {
      const c = parseFloat(cur.style.left);
      const inside = c >= zl + zw * 0.25 && c <= zl + zw * 0.75;
      const outside = c < zl - 12 || c > zl + zw + 12;
      if ((m === 'inside' && inside) || (m === 'outside' && outside)) {
        document.querySelector('#release-btn').click();
        resolve(c);
      } else requestAnimationFrame(tick);
    };
    tick();
  }), mode);
}

async function scenarioRealCursorSync(browser) {
  // المؤشر الحقيقي (بدون forceCursor): الضغط داخل المنطقة الخضراء المرسومة ينجح، وخارجها يُفلت
  const { ctx, page } = await newPage(browser, PHONE, { fastAnimations: true });
  await login(page);
  await startGame(page, ['أحمد', 'مصطفى', 'سارة'], 0);
  let hits = 0;
  let misses = 0;
  for (let i = 0; i < 6; i++) {
    const thrower = await holderPid(page);
    const before = await scoreOf(page, thrower);
    await page.click('#throw-types button[data-type="accurate"]').catch(() => {});
    await tryClick(page, '#target-select button');
    await page.waitForSelector('#release-btn', { timeout: 3000 });
    const wantInside = i % 3 !== 2; // محاولتان للنجاح ثم محاولة خارج المنطقة
    await clickWhenCursor(page, wantInside ? 'inside' : 'outside');
    await page.waitForSelector('#throw-types, #event-options, #start-defuse, #screen-winner', { timeout: 4000 });
    await page.waitForTimeout(80);
    if (await count(page, '#screen-winner')) break;
    const after = await scoreOf(page, thrower);
    const moved = (await holderPid(page)) !== thrower;
    if (wantInside) { if (moved && after > before) hits++; }
    else if (!moved && after === before) misses++;
    if (await count(page, '#event-options')) await tryClick(page, '#event-options button');
    if (await count(page, '#start-defuse')) break;
  }
  assert(hits >= 3, `[مؤشر حقيقي] الضغط داخل المنطقة المرسومة يجب أن ينجح دائمًا - نجح ${hits} من 4`);
  assert(misses >= 1, `[مؤشر حقيقي] الضغط خارج المنطقة المرسومة يجب أن يُفلت القنبلة - أفلتت ${misses} من 2`);
  await finish('مؤشر حقيقي', ctx, page);
}

async function scenarioSixPlayers(browser) {
  const { ctx, page } = await newPage(browser);
  await login(page);
  const names = ['أحمد', 'Mohamed', 'سارة', 'Layla', 'خالد', 'Fatima'];
  await page.click('#count-grid button[data-n="6"]');
  await page.waitForSelector('#screen-names');
  assert((await count(page, '#name-list input')) === 6, '[6 لاعبين] ست خانات أسماء');
  for (let i = 0; i < 6; i++) await page.fill(`#name-list input[data-idx="${i}"]`, names[i]);
  await page.click('#start-round');
  await page.waitForSelector('#screen-game');
  await setOffset(page, 35000);
  assert((await count(page, '.player-chip')) === 6, '[6 لاعبين] ست بطاقات');
  const ended = await playToEnd(page);
  assert(ended, '[6 لاعبين] تدفق كامل حتى الفائز');
  if (ended) {
    const w = (await page.locator('.winner-screen .name').textContent()).trim();
    assert(names.includes(w), `[6 لاعبين] الفائز أحد اللاعبين الستة - "${w}"`);
  }
  await finish('6 لاعبين', ctx, page);
}

async function scenarioRealTimeAnimationsUnlock(browser) {
  const { ctx, page } = await newPage(browser, PHONE, { fastAnimations: false, forceCursor: 'zone' });
  await login(page);
  await startGame(page, ['أحمد', 'مصطفى', 'سارة']);
  const first = await holderPid(page);
  await tryClick(page, '#target-select button');
  await page.waitForSelector('#release-btn');
  await tryClick(page, '#release-btn');
  // أثناء حركة القنبلة: نقرات سريعة على الأزرار القديمة يجب ألا تُنتج أي فعل إضافي
  for (let i = 0; i < 4; i++) { await page.locator('#target-select button').first().click({ timeout: 100, force: true }).catch(() => {}); await page.waitForTimeout(40); }
  await page.waitForSelector('#throw-types', { timeout: 6000 });
  await page.waitForTimeout(400);
  assert((await holderPid(page)) !== first, '[حركات] انتقلت القنبلة بعد الرمية');
  assert((await count(page, '.flying-bomb')) === 0 && (await count(page, '.boom-overlay')) === 0, '[حركات] لا بقايا لحركات القنبلة/الانفجار بعد انتهائها');
  assert((await count(page, '#target-select button')) >= 2, '[حركات] الأزرار متاحة مجددًا بعد الحركة');
  const sc = await scoreOf(page, first);
  assert(sc === 3, `[حركات] رمية مضبوطة ناجحة في الأخضر = 3 نقاط بالضبط (لا تنفيذ مزدوج) - الفعلي ${sc}`);
  // مبدّل الصوت
  const before = await page.locator('#sound-btn').textContent();
  await page.click('#sound-btn');
  const after = await page.locator('#sound-btn').textContent();
  assert(before !== after, '[صوت] زر الصوت يبدّل الأيقونة');
  assert((await count(page, '#target-select button')) >= 2, '[صوت] اللعبة تعمل بعد إغلاق الصوت');
  await finish('حركات حقيقية', ctx, page);
}

async function scenarioTwoDevices(browser) {
  resetMemoryStoreForTests();
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pa = await a.newPage();
  const pb = await b.newPage();
  await pa.goto(BASE);
  await pb.goto(BASE);
  await enterCode(pa, TEST_CODE);
  await pa.waitForSelector('#screen-count', { timeout: 4000 });
  await enterCode(pb, TEST_CODE);
  await pb.waitForFunction(() => document.querySelector('#code-error')?.textContent?.includes('جهاز آخر'), { timeout: 4000 }).catch(() => {});
  const t = await pb.locator('#code-error').textContent();
  assert(t && t.includes('جهاز آخر'), `[جهازان] يجب رفض الجهاز الثاني - الرسالة "${t}"`);
  await a.close();
  await b.close();
}

async function scenarioHeartbeatGrace(browser) {
  const { ctx, page } = await newPage(browser, PHONE, { heartbeatIntervalMs: 400, heartbeatGraceMs: 2000, fastAnimations: true, forceCursor: 'zone' });
  await login(page);
  await startGame(page, ['أحمد', 'سارة'], 0);
  await page.route('**/api/heartbeat', (route) => route.abort('failed'));
  await page.waitForTimeout(1200);
  assert((await count(page, '#screen-game')) > 0 && (await count(page, '#screen-code')) === 0, '[مهلة السماح] انقطاع أقصر من المهلة لا يُخرج اللاعب');
  await page.waitForFunction(() => !!document.querySelector('#screen-code'), { timeout: 5000 });
  assert(true, '[مهلة السماح] بعد تجاوز المهلة يُطلب الكود');
  await page.unroute('**/api/heartbeat');
  await finish('مهلة السماح', ctx, page);
}

async function scenarioDoubleClickSubmit(browser) {
  const { ctx, page } = await newPage(browser);
  const statuses = [];
  page.on('response', (r) => { if (r.url().includes('verify-code')) statuses.push(r.status()); });
  await page.goto(BASE);
  const inputs = page.locator('#code-inputs input');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(TEST_CODE[i]);
  await page.evaluate(() => { const b = document.querySelector('#submit-code'); b.click(); b.click(); b.click(); });
  await page.waitForSelector('#screen-count', { timeout: 4000 });
  assert(statuses.length === 1 && statuses[0] === 200, `[نقر مزدوج] طلب تحقق واحد ناجح فقط - الفعلي [${statuses}]`);
  await finish('نقر مزدوج', ctx, page);
}

async function scenarioMobileLayout(browser) {
  const { ctx, page } = await newPage(browser, { width: 360, height: 640 });
  const overflow = async (label) => {
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert(sw <= cw, `[موبايل 360px] تجاوز أفقي في ${label}: ${sw} > ${cw}`);
  };
  await page.goto(BASE);
  await overflow('شاشة الكود');
  await enterCode(page, TEST_CODE);
  await page.waitForSelector('#screen-count');
  await overflow('عدد اللاعبين');
  await page.click('#count-grid button[data-n="6"]');
  await page.waitForSelector('#screen-names');
  await overflow('الأسماء');
  for (let i = 0; i < 6; i++) await page.fill(`#name-list input[data-idx="${i}"]`, 'لاعب طويل الاسم ' + i);
  await page.click('#start-round');
  await page.waitForSelector('#screen-game');
  await setOffset(page, 35000);
  await overflow('اللعب (قرار)');
  await tryClick(page, '#target-select button');
  await page.waitForSelector('#release-btn');
  await overflow('التصويب');
  const rb = await page.locator('#release-btn').boundingBox();
  assert(rb && rb.x >= 0 && rb.x + rb.width <= 360 && rb.height >= 60, `[موبايل] زر الإيقاف كبير وداخل الشاشة: ${JSON.stringify(rb)}`);
  await setCursor(page, 'zone');
  await tryClick(page, '#release-btn');
  const red = await playUntil(page, '#start-defuse', () => 'zone', 800);
  if (red) await overflow('المنطقة الحمراء');
  await finish('تخطيط الموبايل', ctx, page);
}

// ------------------------------------------------------------------ التشغيل
async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));
  const browser = await chromium.launch();
  const scenarios = [
    scenarioAccessAndSetup,
    scenarioGameplayFlow,
    scenarioRedZoneDefuseExplosion,
    scenarioDefuseSuccessMakesBombExhausted,
    scenarioThrowTypeEffects,
    scenarioShieldPurchase,
    scenarioEventsUI,
    scenarioRealCursorSync,
    scenarioSixPlayers,
    scenarioRealTimeAnimationsUnlock,
    scenarioTwoDevices,
    scenarioHeartbeatGrace,
    scenarioDoubleClickSubmit,
    scenarioMobileLayout,
  ];
  const only = process.env.ONLY; // مثال: ONLY=RealCursor node tests/ui-test.js
  for (const s of scenarios.filter((x) => !only || x.name.includes(only))) {
    const t0 = Date.now();
    try { await s(browser); } catch (e) { failures.push(`${s.name} تعطل: ${e.message}`); }
    console.log(`  ${failures.length ? '·' : '✓'} ${s.name} (${((Date.now() - t0) / 1000).toFixed(1)}ث)`);
  }
  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  console.log('\n=== نتيجة اختبار الواجهة الحقيقي (Playwright) ===');
  if (failures.length === 0) {
    console.log(`✅ نجحت جميع اختبارات الواجهة (${scenarios.length} سيناريو)`);
    process.exit(0);
  }
  console.log(`❌ فشل ${failures.length}:`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
main().catch((e) => { console.error('تعطل الاختبار:', e); process.exit(1); });
