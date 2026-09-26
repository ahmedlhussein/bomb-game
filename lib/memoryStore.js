'use strict';
/**
 * مخزن في الذاكرة يُستخدم فقط محليًا عند عدم توفر متغيرات بيئة Upstash
 * (تطوير محلي / خادم الاختبار المحلي). في الإنتاج على Vercel، بمجرد ضبط
 * UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN، يُستخدم Upstash الحقيقي تلقائيًا
 * بدلًا من هذا الملف (انظر lib/storeFactory.js).
 */
function createMemoryStore() {
  const map = new Map();
  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt != null && Date.now() >= entry.expiresAt) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, exSeconds) {
      map.set(key, { value, expiresAt: exSeconds ? Date.now() + exSeconds * 1000 : null });
    },
    async del(key) {
      map.delete(key);
    },
  };
}

module.exports = { createMemoryStore };
