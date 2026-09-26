'use strict';
/**
 * عميل بسيط جدًا لـ Upstash Redis عبر REST API مباشرة (fetch فقط، بدون أي SDK خارجي).
 * يُستخدم فقط في بيئة الإنتاج على Vercel، عبر متغيرات البيئة:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 * (هذه القيم تُنشأ تلقائيًا عند ربط تكامل Upstash من Vercel Marketplace بالمشروع)
 *
 * ملاحظة: هذا الملف غير مُستخدَم في الاختبارات الآلية إطلاقًا (لا يوجد اتصال إنترنت في
 * بيئة التطوير) - الاختبارات تستخدم مخزنًا وهميًا بنفس الواجهة (get/set/del)
 * في tests/fakeStore.js. أي منطق قرار حقيقي موجود في lib/codeAuth.js فقط، وهو ما يُختبر.
 */

function createUpstashStore() {
  const baseUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('متغيرات البيئة الخاصة بـ Upstash غير مُعدّة (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }

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

module.exports = { createUpstashStore };
