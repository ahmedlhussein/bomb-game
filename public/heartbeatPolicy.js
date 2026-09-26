(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HeartbeatPolicy = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_GRACE_MS = 60000; // "دقيقة واحدة أو أقل" حسب الـMaster Prompt

  /**
   * يقرر ما إذا كان يجب إجبار المستخدم على إعادة إدخال الكود بعد فشل نبضة (heartbeat).
   * @param {object} p
   * @param {boolean} p.ok - هل نجحت النبضة؟
   * @param {number} p.status - رمز حالة HTTP (0 يعني فشل شبكي: تعذر الوصول للخادم إطلاقًا)
   * @param {number} p.msSinceLastSuccess - المدة منذ آخر نبضة ناجحة (أو منذ تسجيل الدخول)
   * @param {number} [p.graceMs] - مهلة السماح بالمللي ثانية (افتراضيًا 60000)
   */
  function shouldForceReauth(p) {
    if (p.ok) return false;
    const graceMs = p.graceMs != null ? p.graceMs : DEFAULT_GRACE_MS;
    const isDefinitiveRejection = p.status === 409 || p.status === 410;
    if (isDefinitiveRejection) return true; // رفض قطعي من الخادم - لا فائدة من إعادة المحاولة
    // أي شيء آخر (0 = فشل شبكي، أو خطأ خادم 5xx عابر) يُعامل كانقطاع مؤقت:
    // نستمر بصمت طالما لم نتجاوز مهلة السماح منذ آخر نجاح فعلي.
    return p.msSinceLastSuccess > graceMs;
  }

  return { shouldForceReauth, DEFAULT_GRACE_MS };
});
