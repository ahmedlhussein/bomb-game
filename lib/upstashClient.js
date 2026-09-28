'use strict';
/**
 * عميل بسيط جدًا لـ Upstash Redis عبر REST API مباشرة (fetch فقط، بدون أي SDK خارجي).
 * يُستخدم فقط في بيئة الإنتاج على Vercel، عبر متغيرات البيئة:
 *   UPSTASH_REDIS_REST_URL  أو (بديلًا عنه)  KV_REST_API_URL
 *   UPSTASH_REDIS_REST_TOKEN أو (بديلًا عنه) KV_REST_API_TOKEN
 * (تكامل Upstash في Vercel Marketplace قد ينشئ أحد الاسمين حسب نوع التكامل؛ الأولوية للأسماء UPSTASH_*)
 *
 * ملاحظة: هذا الملف غير مُستخدَم في الاختبارات الآلية إطلاقًا (لا يوجد اتصال إنترنت في
 * بيئة التطوير) - الاختبارات تستخدم مخزنًا وهميًا بنفس الواجهة (get/set/del)
 * في tests/fakeStore.js. أي منطق قرار حقيقي موجود في lib/codeAuth.js فقط، وهو ما يُختبر.
 */

/** يحدد إعداد Upstash من متغيرات البيئة (UPSTASH_* أولًا، ثم KV_REST_API_*). يُعيد null إن لم يكتمل. */
function getUpstashConfig() {
  const baseUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return baseUrl && token ? { baseUrl, token } : null;
}

function createUpstashStore() {
  const config = getUpstashConfig();
  if (!config) {
    throw new Error('متغيرات البيئة الخاصة بـ Upstash غير مُعدّة (UPSTASH_REDIS_REST_URL/KV_REST_API_URL و UPSTASH_REDIS_REST_TOKEN/KV_REST_API_TOKEN)');
  }
  const { baseUrl, token } = config;

  async function call(pathSegments) {
    const url = baseUrl.replace(/\/$/, '') + '/' + pathSegments.map(encodeURIComponent).join('/');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('Upstash request failed: ' + res.status);
    const data = await res.json();
    return data.result;
  }

  return {
    async get(key) {
      const result = await call(['get', key]);
      return result == null ? null : result;
    },
    async set(key, value, exSeconds) {
      const segments = ['set', key, value];
      if (exSeconds) segments.push('EX', String(exSeconds));
      await call(segments);
    },
    async del(key) {
      await call(['del', key]);
    },
  };
}

module.exports = { createUpstashStore, getUpstashConfig };
