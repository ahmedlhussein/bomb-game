'use strict';
/**
 * اختبار واجهة حقيقي متكامل: يشغّل خادم التطوير المحلي (يخدم public/ الحقيقي + دوال
 * api/*.js الحقيقية) ثم يفتح Chromium بدون واجهة رسومية وينقر فعليًا على الأزرار،
 * بما في ذلك التحقق الحقيقي من كود الدخول عبر الشبكة (وليس أي محاكاة داخل المتصفح).
 *
 * التشغيل: node tests/ui-test.js
 */
const { chromium } = require('playwright');
const { createServer } = require('./devServer');
const { hashCode } = require('../lib/codeAuth');

const TEST_CODE = 'zxc123';
process.env.ACCESS_CODE_HASHES = JSON.stringify([hashCode(TEST_CODE)]);
const PORT = 3512;
const INDEX = `http://localhost:${PORT}/`;

let failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

async function run() {
  const server = createServer();
  await new Promise((resolve) => server.listen(PORT, resolve));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } }); // محاكاة شاشة هاتف
  const page = await context.newPage();

  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (text.includes('Failed to load resource')) return; // سلوك متصفح طبيعي لأي استجابة غير 2xx (متوقع هنا عمدًا لاختبار الأكواد الخاطئة)
    consoleErrors.push('console.error: ' + text);
  });

  await page.goto(INDEX);

  // -------- شاشة الكود --------
  const codeInputsCount = await page.locator('#code-inputs input').count();
  assert(codeInputsCount === 6, `يجب وجود 6 خانات لإدخال الكود، وُجد ${codeInputsCount}`);
  const inputs = page.locator('#code-inputs input');

  // كود بصيغة خاطئة
  await page.fill('#code-inputs input:nth-child(1)', 'z');
  await page.click('#submit-code');
  const errText = await page.locator('#code-error').textContent();
  assert(errText && errText.trim().length > 0, 'يجب ظهور رسالة خطأ عند كود غير صحيح الصيغة');

  // -------- لصق كود يحتوي على فواصل/مسافات يجب أن يوزَّع وينظَّف تلقائيًا على الخانات الـ6 --------
  await page.evaluate(() => {
    const first = document.querySelector('#code-inputs input');
    const dt = new DataTransfer();
    dt.setData('text', 'zx c-1 2 3'); // نفس القيمة "zxc123" لكن مع مسافات وفواصل متفرقة كما قد يحدث فعليًا
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    first.dispatchEvent(ev);
  });
  const pastedValues = await inputs.evaluateAll((els) => els.map((e) => e.value));
  assert(pastedValues.join('') === 'zxc123', `[لصق مع فواصل/مسافات] يجب تنظيف الكود المُلصق وتوزيعه بشكل صحيح على الخانات - النتيجة الفعلية: "${pastedValues.join('')}"`);
  // نمسح الخانات قبل متابعة سيناريوهات الدخول التالية حتى لا تتداخل معها
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill('');

  // كود بصيغة صحيحة شكليًا لكنه غير مسموح به (اختبار تكامل حقيقي مع الخادم: 401)
  const wrongChars = 'zzz999'.split('');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(wrongChars[i]);
  await page.click('#submit-code');
  await page.waitForFunction(() => document.querySelector('#code-error')?.textContent?.includes('الكود غير صحيح'), { timeout: 4000 });
  assert(true, 'الخادم الحقيقي رفض كودًا غير مسموح به برسالة صحيحة (401)');

  // كود صحيح فعليًا وموجود في القائمة المسموحة (تحقق حقيقي عبر الشبكة من خادم التطوير)
  const chars = TEST_CODE.split('');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(chars[i]);
  await page.click('#submit-code');
  await page.waitForSelector('#screen-count', { timeout: 4000 });
  assert(true, 'الانتقال لشاشة عدد اللاعبين بعد تحقق حقيقي وناجح من الخادم');

  // -------- شاشة عدد اللاعبين --------
  await page.click('#count-grid button[data-n="3"]');
  await page.waitForSelector('#screen-names', { timeout: 3000 });
  const nameInputsCount = await page.locator('#name-list input').count();
  assert(nameInputsCount === 3, `يجب 3 خانات أسماء لـ3 لاعبين، وُجد ${nameInputsCount}`);

  // -------- شاشة الأسماء (عربي + إنجليزي) --------
  await page.fill('#name-list input[data-idx="0"]', 'أحمد');
  await page.fill('#name-list input[data-idx="1"]', 'Sara');
  await page.fill('#name-list input[data-idx="2"]', 'محمد');
  await page.click('#start-round');
  await page.waitForSelector('#screen-game', { timeout: 3000 });
  assert(true, 'بدء الجولة بعد إدخال الأسماء (عربي/إنجليزي)');

  const holderText1 = await page.locator('.holder-banner .name').textContent();
  assert(/دورك الآن/.test(holderText1), 'يجب ظهور اسم صاحب الدور بوضوح');

  // -------- اختبار Pause/Resume الفعلي عبر النقر --------
  await page.click('#pause-btn');
  await page.waitForSelector('#pause-overlay', { timeout: 2000 });
  const actionsHiddenDuringPause = await page.locator('#target-select button').count();
  assert(actionsHiddenDuringPause === 0, 'يجب عدم إتاحة أي زر فعل أثناء Pause');
  const dangerLabelBeforeResume = await page.locator('.danger-label').textContent().catch(() => null);
  await page.click('#resume-btn');
  await page.waitForSelector('#screen-game .target-select, #screen-game .wire-btn, #screen-game #event-options', { timeout: 3000 }).catch(() => {});
  const pauseOverlayGone = await page.locator('#pause-overlay').count();
  assert(pauseOverlayGone === 0, 'يجب اختفاء طبقة Pause بعد الاستئناف');
  assert(true, `Pause/Resume تم فعليًا عبر النقر (مستوى الخطر عند الإيقاف: ${dangerLabelBeforeResume || 'غير متاح'})`);

  // -------- اختبار Refresh: يجب ألا يتغير أي شيء في الحالة --------
  const holderBeforeRefresh = await page.locator('.holder-banner .name').textContent();
  const dangerBeforeRefresh = await page.locator('.danger-label').textContent().catch(() => null);
  await page.reload();
  await page.waitForSelector('#screen-game', { timeout: 3000 });
  const holderAfterRefresh = await page.locator('.holder-banner .name').textContent();
  const dangerAfterRefresh = await page.locator('.danger-label').textContent().catch(() => null);
  assert(holderBeforeRefresh === holderAfterRefresh, `Refresh غيّر صاحب الدور! قبل: ${holderBeforeRefresh} بعد: ${holderAfterRefresh}`);
  assert(dangerBeforeRefresh === dangerAfterRefresh, `Refresh غيّر مستوى الخطر! قبل: ${dangerBeforeRefresh} بعد: ${dangerAfterRefresh}`);

  // -------- التحقق من عدم قبول فعل غير قانوني (لا يوجد زر لتمرير القنبلة لنفس الحامل) --------
  const targetButtons = await page.locator('#target-select button').allTextContents();
  const holderNameOnly = holderText1.replace(' — دورك الآن', '').trim();
  const selfTargetExists = targetButtons.some((t) => t.includes(holderNameOnly));
  assert(!selfTargetExists, 'يجب ألا يظهر خيار تمرير القنبلة لنفس حاملها الحالي');

  // -------- تشغيل عدة جولات حتى الوصول لشاشة الفائز (محاكاة لعب حقيقي بالنقر) --------
  let reachedWinner = false;
  for (let step = 0; step < 400 && !reachedWinner; step++) {
    const onWinner = await page.locator('#screen-winner').count();
    if (onWinner > 0) { reachedWinner = true; break; }

    const onWires = await page.locator('.wire-btn').count();
    if (onWires > 0) {
      await page.locator('.wire-btn').first().click();
      continue;
    }
    const onEvent = await page.locator('#event-options button').count();
    if (onEvent > 0) {
      await page.locator('#event-options button').first().click();
      continue;
    }
    const onTarget = await page.locator('#target-select button').count();
    if (onTarget > 0) {
      await page.locator('#target-select button').first().click();
      continue;
    }
    // لا يوجد شيء قابل للنقر - ننتظر قليلًا فقط للتأكد
    await page.waitForTimeout(20);
  }
  assert(reachedWinner, 'يجب الوصول لشاشة الفائز عبر النقر الفعلي على أزرار الواجهة خلال عدد معقول من الخطوات');

  if (reachedWinner) {
    const winnerName = await page.locator('.winner-screen .name').textContent();
    assert(winnerName && winnerName.trim().length > 0, 'يجب عرض اسم الفائز بوضوح');
    const buttons = await page.locator('.winner-screen button').allTextContents();
    assert(buttons.some((b) => b.includes('ابدأ دور جديد')), 'يجب وجود زر "ابدأ دور جديد"');
    assert(buttons.some((b) => b.includes('خروج')), 'يجب وجود زر "خروج"');

    // -------- اختبار "ابدأ دور جديد" يعيد الإعداد من الصفر --------
    await page.click('#new-round');
    await page.waitForSelector('#screen-count', { timeout: 3000 });
    assert(true, '"ابدأ دور جديد" يعيد شاشة اختيار عدد اللاعبين');
  }

  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  // -------- اختبار تكامل حقيقي: نفس الكود من "جهازين" (سياقي متصفح منفصلين) في نفس الوقت --------
  await run2Device();

  // -------- اختبار تكامل حقيقي: مهلة السماح عند انقطاع شبكي فعلي أثناء اللعب --------
  await runHeartbeatGraceTest();

  // -------- اختبار تكامل حقيقي: Refresh أثناء "اللحظة الحرجة" لا يغيّر اللغز --------
  await runRefreshDuringCriticalTest();

  // -------- اختبار تكامل حقيقي: نقر مزدوج سريع على "دخول" لا يُنتج طلبًا مزدوجًا/رفضًا زائفًا --------
  await runDoubleClickSubmitCodeTest();

  // -------- اختبار تكامل حقيقي: تدفق كامل بـ6 لاعبين (الحد الأقصى) حتى الفائز --------
  await runSixPlayersRealFlowTest();


  console.log('\n=== نتيجة اختبار الواجهة الحقيقي (Playwright) ===');
  if (consoleErrors.length) {
    console.log('⚠️ أخطاء JS ظهرت أثناء التشغيل:');
    consoleErrors.forEach((e) => console.log('  - ' + e));
    failures.push(...consoleErrors.map((e) => 'خطأ JS: ' + e));
  }
  if (failures.length === 0) {
    console.log('✅ نجحت جميع اختبارات الواجهة');
    process.exit(0);
  } else {
    console.log(`❌ فشل ${failures.length}:`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

async function run2Device() {
  require('../lib/storeFactory').resetMemoryStoreForTests(); // عزل هذا السيناريو عن أي جلسة سابقة في نفس عملية الاختبار
  const port = PORT + 1;
  const server = createServer();
  await new Promise((resolve) => server.listen(port, resolve));
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto(base);
  await pageB.goto(base);

  async function enterCode(page, code) {
    const inputs = page.locator('#code-inputs input');
    for (let i = 0; i < 6; i++) await inputs.nth(i).fill(code[i]);
    await page.click('#submit-code');
  }

  await enterCode(pageA, TEST_CODE);
  await pageA.waitForSelector('#screen-count', { timeout: 4000 });
  assert(true, '[جهازان] الجهاز الأول دخل بنجاح بالكود');

  await enterCode(pageB, TEST_CODE);
  await pageB.waitForFunction(() => document.querySelector('#code-error')?.textContent?.includes('جهاز آخر'), { timeout: 4000 }).catch(() => {});
  const errTextB = await pageB.locator('#code-error').textContent();
  assert(errTextB && errTextB.includes('جهاز آخر'), `[جهازان] يجب رفض الجهاز الثاني بنفس الكود أثناء نشاط الجهاز الأول - الرسالة الفعلية: "${errTextB}"`);

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function runHeartbeatGraceTest() {
  require('../lib/storeFactory').resetMemoryStoreForTests();
  const port = PORT + 2;
  const server = createServer();
  await new Promise((resolve) => server.listen(port, resolve));
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // نُقلّص المهلات كثيرًا هنا فقط لأغراض سرعة الاختبار الآلي (الإنتاج يستخدم القيم الافتراضية الحقيقية: 25 ثانية / دقيقة)
  await page.addInitScript(() => {
    window.__BOMBGAME_TEST__ = { heartbeatIntervalMs: 400, heartbeatGraceMs: 2000 };
  });
  await page.goto(base);

  const inputs = page.locator('#code-inputs input');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(TEST_CODE[i]);
  await page.click('#submit-code');
  await page.waitForSelector('#screen-count', { timeout: 4000 });
  await page.click('#count-grid button[data-n="2"]');
  await page.fill('#name-list input[data-idx="0"]', 'أحمد');
  await page.fill('#name-list input[data-idx="1"]', 'سارة');
  await page.click('#start-round');
  await page.waitForSelector('#screen-game', { timeout: 3000 });

  // -------- محاكاة انقطاع شبكي عابر أقصر من مهلة السماح (2 ثانية) --------
  await page.route('**/api/heartbeat', (route) => route.abort('failed'));
  await page.waitForTimeout(1200); // أقل من مهلة السماح (2000ms)
  const stillOnGame = await page.locator('#screen-game').count();
  assert(stillOnGame > 0, '[مهلة السماح] انقطاع شبكي أقصر من المهلة يجب ألا يُخرج اللاعب من شاشة اللعب');
  const stillNoCodeScreen = await page.locator('#screen-code').count();
  assert(stillNoCodeScreen === 0, '[مهلة السماح] يجب ألا تظهر شاشة الكود مبكرًا أثناء انقطاع قصير');

  // -------- تجاوز مهلة السماح بالكامل مع استمرار الانقطاع --------
  await page.waitForFunction(() => !!document.querySelector('#screen-code'), { timeout: 5000 });
  assert(true, '[مهلة السماح] بعد تجاوز المهلة مع استمرار الانقطاع، يُطلب إدخال الكود من جديد كما هو مطلوب');

  await page.unroute('**/api/heartbeat');
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function runRefreshDuringCriticalTest() {
  require('../lib/storeFactory').resetMemoryStoreForTests();
  const port = PORT + 3;
  const server = createServer();
  await new Promise((resolve) => server.listen(port, resolve));
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base);

  const inputs = page.locator('#code-inputs input');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(TEST_CODE[i]);
  await page.click('#submit-code');
  await page.waitForSelector('#screen-count', { timeout: 4000 });
  await page.click('#count-grid button[data-n="2"]');
  await page.fill('#name-list input[data-idx="0"]', 'أحمد');
  await page.fill('#name-list input[data-idx="1"]', 'سارة');
  await page.click('#start-round');
  await page.waitForSelector('#screen-game', { timeout: 3000 });

  let reachedCritical = false;
  for (let step = 0; step < 500 && !reachedCritical; step++) {
    if ((await page.locator('.wire-btn').count()) > 0) { reachedCritical = true; break; }
    const onEvent = await page.locator('#event-options button').count();
    if (onEvent > 0) { await page.locator('#event-options button').first().click(); continue; }
    const onTarget = await page.locator('#target-select button').count();
    if (onTarget > 0) {
      // نُفضّل "تمرير جريء" للوصول أسرع للحظة الحرجة (تسريع الاختبار فقط)
      const boldTab = page.locator('#type-tabs button', { hasText: 'جريء' });
      if (await boldTab.count()) await boldTab.first().click();
      await page.locator('#target-select button').first().click();
      continue;
    }
    await page.waitForTimeout(10);
  }
  assert(reachedCritical, '[Refresh أثناء الحرج] يجب الوصول إلى "اللحظة الحرجة" عبر لعب فعلي');

  if (reachedCritical) {
    const colorsBefore = await page.locator('.wire-btn').evaluateAll((els) => els.map((e) => e.className));
    const dangerBefore = await page.locator('.danger-label').textContent();
    await page.reload();
    await page.waitForSelector('.wire-btn', { timeout: 3000 });
    const colorsAfter = await page.locator('.wire-btn').evaluateAll((els) => els.map((e) => e.className));
    const dangerAfter = await page.locator('.danger-label').textContent();
    assert(JSON.stringify(colorsBefore) === JSON.stringify(colorsAfter),
      `[Refresh أثناء الحرج] ألوان/ترتيب الأسلاك يجب ألا تتغير - قبل: ${colorsBefore} بعد: ${colorsAfter}`);
    assert(dangerBefore === dangerAfter, '[Refresh أثناء الحرج] مستوى الخطر المعروض يجب ألا يتغير');
  }

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function runDoubleClickSubmitCodeTest() {
  require('../lib/storeFactory').resetMemoryStoreForTests();
  const port = PORT + 4;
  const server = createServer();
  await new Promise((resolve) => server.listen(port, resolve));
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const verifyStatuses = [];
  page.on('response', (r) => { if (r.url().includes('verify-code')) verifyStatuses.push(r.status()); });
  await page.goto(base);

  const inputs = page.locator('#code-inputs input');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(TEST_CODE[i]);
  await page.evaluate(() => {
    const btn = document.querySelector('#submit-code');
    btn.click();
    btn.click();
    btn.click();
  });
  await page.waitForSelector('#screen-count', { timeout: 4000 });
  assert(verifyStatuses.length === 1, `[نقر مزدوج] يجب إرسال طلب تحقق واحد فقط بغض النظر عن عدد النقرات السريعة - أُرسل فعليًا: ${verifyStatuses.length} (${verifyStatuses.join(',')})`);
  assert(verifyStatuses[0] === 200, '[نقر مزدوج] الطلب الوحيد المُرسل يجب أن ينجح (200)، وليس رفضًا زائفًا بسبب تعارض ذاتي');

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

async function runSixPlayersRealFlowTest() {
  require('../lib/storeFactory').resetMemoryStoreForTests();
  const port = PORT + 5;
  const server = createServer();
  await new Promise((resolve) => server.listen(port, resolve));
  const base = `http://localhost:${port}/`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(base);

  const inputs = page.locator('#code-inputs input');
  for (let i = 0; i < 6; i++) await inputs.nth(i).fill(TEST_CODE[i]);
  await page.click('#submit-code');
  await page.waitForSelector('#screen-count', { timeout: 4000 });
  await page.click('#count-grid button[data-n="6"]');
  await page.waitForSelector('#screen-names', { timeout: 3000 });
  const nameInputsCount = await page.locator('#name-list input').count();
  assert(nameInputsCount === 6, `[6 لاعبين] يجب 6 خانات أسماء، وُجد ${nameInputsCount}`);

  const names = ['أحمد', 'Mohamed', 'سارة', 'Layla', 'خالد', 'Fatima'];
  for (let i = 0; i < 6; i++) await page.fill(`#name-list input[data-idx="${i}"]`, names[i]);
  await page.click('#start-round');
  await page.waitForSelector('#screen-game', { timeout: 3000 });

  const chipsCount = await page.locator('.player-chip').count();
  assert(chipsCount === 6, `[6 لاعبين] يجب ظهور 6 بطاقات لاعبين في شاشة اللعب، وُجد ${chipsCount}`);

  let reachedWinner = false;
  for (let step = 0; step < 900 && !reachedWinner; step++) {
    if ((await page.locator('#screen-winner').count()) > 0) { reachedWinner = true; break; }
    if ((await page.locator('.wire-btn').count()) > 0) { await page.locator('.wire-btn').first().click(); continue; }
    if ((await page.locator('#event-options button').count()) > 0) { await page.locator('#event-options button').first().click(); continue; }
    if ((await page.locator('#target-select button').count()) > 0) { await page.locator('#target-select button').first().click(); continue; }
    await page.waitForTimeout(10);
  }
  assert(reachedWinner, '[6 لاعبين] يجب الوصول لشاشة الفائز عبر لعب فعلي كامل بـ6 لاعبين');
  if (reachedWinner) {
    const winnerName = await page.locator('.winner-screen .name').textContent();
    assert(winnerName && names.includes(winnerName.trim()), `[6 لاعبين] اسم الفائز المعروض يجب أن يكون أحد اللاعبين الستة الفعليين - وُجد: "${winnerName}"`);
  }

  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

run().catch((e) => { console.error('تعطل الاختبار:', e); process.exit(1); });
