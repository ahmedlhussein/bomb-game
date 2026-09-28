'use strict';
const { attemptLogin } = require('../lib/codeAuth');
const { getStore } = require('../lib/storeFactory');
const { getUpstashConfig } = require('../lib/upstashClient');

function getAllowedHashes() {
  // قائمة الهاشات المسموحة تُقرأ من متغير بيئة على Vercel (Server-side secret) -
  // لا يظهر أي كود حقيقي أو هاش في الكود المصدري أو في المستودع العام إطلاقًا.
  try {
    return JSON.parse(process.env.ACCESS_CODE_HASHES || '[]');
  } catch (e) {
    return [];
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  try {
    const { code } = req.body || {};
    const store = getStore();
    const result = await attemptLogin({ code, allowedHashes: getAllowedHashes() }, store);
    res.status(result.status).json(result.body);
  } catch (e) {
    // تشخيص آمن فقط: اسم/رسالة الخطأ، وأي مجموعة متغيرات بيئة اكتُشفت (بالاسم فقط، بدون قيمها).
    // لا يُطبع أي كود، هاش، أو قيمة فعلية لأي متغير بيئة إطلاقًا - هذا يظهر فقط في Vercel Logs
    // وليس في استجابة الـ API التي يراها العميل.
    const cfg = (() => { try { return getUpstashConfig(); } catch (_) { return null; } })();
    console.error('[verify-code] failed:', e.name + ': ' + e.message, {
      hasUpstashConfig: !!cfg,
      envPresence: {
        UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
        KV_REST_API_URL: !!process.env.KV_REST_API_URL,
        KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
        ACCESS_CODE_HASHES: !!process.env.ACCESS_CODE_HASHES,
      },
    });
    res.status(500).json({ ok: false, error: 'حدث خطأ غير متوقع' });
  }
};
