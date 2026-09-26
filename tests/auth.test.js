'use strict';
/**
 * اختبارات آلية لمنطق نظام الأكواد وقفل الجهاز الواحد (lib/codeAuth.js).
 * التشغيل: node tests/auth.test.js
 */
const assert = require('assert');
const { hashCode, attemptLogin, heartbeat, releaseSession, CONST } = require('../lib/codeAuth');
const { createFakeStore } = require('./fakeStore');

let failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

async function testValidCodeLogsIn() {
  const store = createFakeStore();
  const code = 'zxc123';
  const allowedHashes = [hashCode(code)];
  const res = await attemptLogin({ code, allowedHashes }, store);
  check(res.status === 200 && res.body.ok, 'كود صحيح ومسموح يجب أن ينجح في الدخول');
  check(!!res.body.sessionToken, 'يجب إرجاع sessionToken عند النجاح');
  check(!('code' in res.body) && !JSON.stringify(res.body).includes(code), 'يجب ألا يظهر الكود الحقيقي في الاستجابة إطلاقًا');
}

async function testInvalidFormatRejected() {
  const store = createFakeStore();
  const res = await attemptLogin({ code: 'ab', allowedHashes: [] }, store);
  check(res.status === 400, 'كود بصيغة خاطئة يجب رفضه فورًا (400) دون أي بحث في القائمة');
}

async function testUnauthorizedCodeRejected() {
  const store = createFakeStore();
  const res = await attemptLogin({ code: 'zzz999', allowedHashes: [hashCode('abc123')] }, store);
  check(res.status === 401, 'كود بصيغة صحيحة لكنه غير موجود في القائمة المعتمدة يجب رفضه (401)');
}

async function testSameCodeTwoDevicesRejected() {
  const store = createFakeStore();
  const code = 'abc123';
  const allowedHashes = [hashCode(code)];
  const first = await attemptLogin({ code, allowedHashes }, store);
  check(first.status === 200, 'أول محاولة دخول بالكود يجب أن تنجح');
  const second = await attemptLogin({ code, allowedHashes }, store);
  check(second.status === 409, `يجب رفض استخدام نفس الكود من جهاز ثانٍ أثناء نشاط الجلسة الأولى (وُجد status=${second.status})`);
}

async function testCodeReusableAfterSessionExpires() {
  const store = createFakeStore();
  const code = 'abc123';
  const allowedHashes = [hashCode(code)];
  const first = await attemptLogin({ code, allowedHashes }, store);
  check(first.status === 200, 'أول دخول ناجح');
  store._advanceTime((CONST.SESSION_TTL_SECONDS + 5) * 1000); // تجاوز مهلة الجلسة بدون أي نبضة (heartbeat)
  const second = await attemptLogin({ code, allowedHashes }, store);
  check(second.status === 200, 'بعد انتهاء صلاحية الجلسة السابقة (بدون نبضات)، يجب السماح باستخدام الكود من جديد');
}

async function testHeartbeatKeepsSessionAliveBeyondTTL() {
  const store = createFakeStore();
  const code = 'abc123';
  const allowedHashes = [hashCode(code)];
  const login = await attemptLogin({ code, allowedHashes }, store);
  const codeHash = login.body.codeHash;
  const sessionToken = login.body.sessionToken;

  // محاكاة نبضات دورية كل 30 ثانية عبر مدة أطول من TTL الأصلي (90 ثانية)
  for (let i = 0; i < 5; i++) {
    store._advanceTime(30000);
    const hb = await heartbeat({ codeHash, sessionToken }, store);
    check(hb.status === 200, `النبضة رقم ${i + 1} يجب أن تنجح وتجدّد الجلسة`);
  }
  // بعد كل هذه المدة (150 ثانية)، محاولة جهاز آخر يجب أن تُرفض لأن الجلسة ما زالت حية بفضل النبضات
  const otherDevice = await attemptLogin({ code, allowedHashes }, store);
  check(otherDevice.status === 409, 'النبضات المستمرة يجب أن تُبقي الجلسة حية وتمنع جهازًا آخر رغم مرور وقت طويل');
}

async function testDisconnectWithinOneMinuteRecoversViaHeartbeat() {
  // محاكاة: انقطاع اتصال حقيقي لأقل من دقيقة ثم عودة نبضة - يجب أن تنجح ولا تُفقد الجلسة
  const store = createFakeStore();
  const code = 'abc123';
  const allowedHashes = [hashCode(code)];
  const login = await attemptLogin({ code, allowedHashes }, store);
  const { codeHash, sessionToken } = login.body;

  store._advanceTime(45000); // انقطاع 45 ثانية (أقل من دقيقة) - لا نبضات خلالها
  const hb = await heartbeat({ codeHash, sessionToken }, store);
  check(hb.status === 200, 'عودة الاتصال خلال أقل من دقيقة (وقبل انتهاء TTL) يجب أن تستعيد الجلسة بنجاح');
}

async function testDisconnectOverOneMinuteExpiresSession() {
  const store = createFakeStore();
  const code = 'abc123';
  const allowedHashes = [hashCode(code)];
  const login = await attemptLogin({ code, allowedHashes }, store);
  const { codeHash, sessionToken } = login.body;

  store._advanceTime((CONST.SESSION_TTL_SECONDS + 1) * 1000); // تجاوز مهلة القفل بالكامل بدون نبضات
  const hb = await heartbeat({ codeHash, sessionToken }, store);
  check(hb.status === 410, 'انقطاع أطول من مهلة الجلسة يجب أن ينهي الجلسة ويطلب إعادة إدخال الكود');

  // وبعدها يجب أن يكون الكود متاحًا من جديد لأي جهاز (بما فيه نفسه)
  const relogin = await attemptLogin({ code, allowedHashes }, store);
  check(relogin.status === 200, 'بعد انتهاء الجلسة، يجب أن يكون الكود متاحًا للاستخدام من جديد');
}

async function testMultipleIndependentCodes() {
  // كودان مختلفان لا يجب أن يتداخلا في القفل إطلاقًا
  const store = createFakeStore();
  const codeA = 'aaa111';
  const codeB = 'bbb222';
  const allowedHashes = [hashCode(codeA), hashCode(codeB)];
  const a = await attemptLogin({ code: codeA, allowedHashes }, store);
  const b = await attemptLogin({ code: codeB, allowedHashes }, store);
  check(a.status === 200 && b.status === 200, 'كودان مختلفان يجب أن يعملا في نفس الوقت دون تعارض');
  const aAgain = await attemptLogin({ code: codeA, allowedHashes }, store);
  check(aAgain.status === 409, 'قفل الكود A يجب ألا يتأثر أو يتأثر بقفل الكود B');
}

async function testReleaseFreesCodeImmediately() {
  const store = createFakeStore();
  const code = 'abc123';
  const allowedHashes = [hashCode(code)];
  const login = await attemptLogin({ code, allowedHashes }, store);
  const { codeHash, sessionToken } = login.body;
  const rel = await releaseSession({ codeHash, sessionToken }, store);
  check(rel.status === 200, 'تحرير الجلسة صراحة يجب أن ينجح');
  const relogin = await attemptLogin({ code, allowedHashes }, store);
  check(relogin.status === 200, 'بعد التحرير الصريح، يجب أن يكون الكود متاحًا فورًا دون انتظار TTL');
}

async function testWrongSessionTokenRejected() {
  const store = createFakeStore();
  const code = 'abc123';
  const allowedHashes = [hashCode(code)];
  const login = await attemptLogin({ code, allowedHashes }, store);
  const hb = await heartbeat({ codeHash: login.body.codeHash, sessionToken: 'توكن-مزوّر-خاطئ' }, store);
  check(hb.status === 409, 'رمز جلسة غير مطابق يجب رفضه (لا يمكن انتحال جلسة جهاز آخر)');
}

async function main() {
  await testValidCodeLogsIn();
  await testInvalidFormatRejected();
  await testUnauthorizedCodeRejected();
  await testSameCodeTwoDevicesRejected();
  await testCodeReusableAfterSessionExpires();
  await testHeartbeatKeepsSessionAliveBeyondTTL();
  await testDisconnectWithinOneMinuteRecoversViaHeartbeat();
  await testDisconnectOverOneMinuteExpiresSession();
  await testMultipleIndependentCodes();
  await testReleaseFreesCodeImmediately();
  await testWrongSessionTokenRejected();

  console.log('=== نتيجة اختبارات نظام الأكواد والجلسات ===');
  if (failures.length === 0) {
    console.log('✅ نجحت جميع الاختبارات (11 اختبارًا)');
    process.exit(0);
  } else {
    console.log(`❌ فشل ${failures.length}:`);
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}

main();
