'use strict';
const { releaseSession } = require('../lib/codeAuth');
const { getStore } = require('../lib/storeFactory');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  try {
    const { codeHash, sessionToken } = req.body || {};
    const store = getStore();
    const result = await releaseSession({ codeHash, sessionToken }, store);
    res.status(result.status).json(result.body);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'حدث خطأ غير متوقع' });
  }
};
