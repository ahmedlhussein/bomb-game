'use strict';
const assert = require('assert');
const { shouldForceReauth } = require('../public/heartbeatPolicy.js');

let failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

check(shouldForceReauth({ ok: true, status: 200, msSinceLastSuccess: 999999 }) === false,
  'نجاح النبضة يجب ألا يفرض إعادة الدخول أبدًا مهما كان الوقت المنقضي');

check(shouldForceReauth({ ok: false, status: 409, msSinceLastSuccess: 0 }) === true,
  'رفض قطعي (409 - جهاز آخر استولى) يجب أن يفرض إعادة الدخول فورًا حتى لو كان أول فشل');

check(shouldForceReauth({ ok: false, status: 410, msSinceLastSuccess: 0 }) === true,
  'رفض قطعي (410 - انتهاء صلاحية) يجب أن يفرض إعادة الدخول فورًا');

check(shouldForceReauth({ ok: false, status: 0, msSinceLastSuccess: 500 }) === false,
  'فشل شبكي عابر جدًا (أقل من ثانية) يجب ألا يفرض إعادة الدخول - هذا هو الخطأ الذي تم إصلاحه');

check(shouldForceReauth({ ok: false, status: 0, msSinceLastSuccess: 45000 }) === false,
  'انقطاع شبكي 45 ثانية (أقل من دقيقة) يجب ألا يفرض إعادة الدخول بعد - يجب الاستمرار بصمت');

check(shouldForceReauth({ ok: false, status: 0, msSinceLastSuccess: 61000 }) === true,
  'انقطاع شبكي تجاوز دقيقة كاملة يجب أن يفرض إعادة الدخول');

check(shouldForceReauth({ ok: false, status: 500, msSinceLastSuccess: 30000 }) === false,
  'خطأ خادم عابر (5xx) قبل انتهاء مهلة السماح يجب ألا يفرض إعادة الدخول بعد');

check(shouldForceReauth({ ok: false, status: 0, msSinceLastSuccess: 20000, graceMs: 10000 }) === true,
  'يجب احترام قيمة graceMs مخصّصة عند تمريرها (مفيد للاختبارات المتكاملة الأسرع)');

console.log('=== نتيجة اختبار سياسة الـ heartbeat (مهلة السماح) ===');
if (failures.length === 0) {
  console.log('✅ نجحت جميع الاختبارات (8 اختبارات)');
  process.exit(0);
} else {
  console.log(`❌ فشل ${failures.length}:`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
