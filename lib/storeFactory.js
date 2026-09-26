'use strict';
let memorySingleton = null;

function getStore() {
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const { createUpstashStore } = require('./upstashClient');
    return createUpstashStore();
  }
  // لا يوجد إعداد Upstash - نفترض بيئة تطوير محلي/اختبار فقط.
  if (!memorySingleton) {
    const { createMemoryStore } = require('./memoryStore');
    memorySingleton = createMemoryStore();
  }
  return memorySingleton;
}

/** لأغراض الاختبار الآلي فقط: إعادة تعيين المخزن المحلي المؤقت بين سيناريوهات مستقلة،
 * حتى لا تتسرب حالة جلسة من سيناريو اختبار سابق (لا وجود لهذا الوضع في الإنتاج، حيث
 * يُستخدم Upstash الحقيقي المشترك عبر الطلبات كما هو مطلوب فعليًا). */
function resetMemoryStoreForTests() {
  memorySingleton = null;
}

module.exports = { getStore, resetMemoryStoreForTests };
