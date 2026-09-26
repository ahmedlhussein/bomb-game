'use strict';
const { attemptLogin } = require('../lib/codeAuth');
const { getStore } = require('../lib/storeFactory');

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
    // لا نُسرّب أي تفاصيل داخلية في رسالة الخطأ للعميل
    res.status(500).json({ ok: false, error: 'حدث خطأ غير متوقع' });
  }
};
