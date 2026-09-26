'use strict';
/**
 * مخزن وهمي في الذاكرة بنفس دلالات Upstash Redis تمامًا (بما فيها انتهاء الصلاحية الفعلي
 * بمرور الوقت)، يُستخدم فقط في الاختبارات الآلية لعدم توفر اتصال إنترنت في بيئة التطوير.
 * يدعم حقن "ساعة" مزيّفة (fakeNow) لاختبار سيناريوهات انتهاء الصلاحية دون انتظار حقيقي.
 */
function createFakeStore() {
  const map = new Map(); // key -> { value, expiresAt (ms epoch) | null }
  let now = Date.now();

  return {
    _advanceTime(ms) { now += ms; },
    _setNow(ts) { now = ts; },
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt != null && now >= entry.expiresAt) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, exSeconds) {
      map.set(key, { value, expiresAt: exSeconds ? now + exSeconds * 1000 : null });
    },
    async del(key) {
      map.delete(key);
    },
  };
}

module.exports = { createFakeStore };
