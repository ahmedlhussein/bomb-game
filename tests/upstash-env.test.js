'use strict';
/**
 * يتحقق أن api/verify-code.js يستخدم مخزن Upstash الحقيقي (طلبات fetch خارجية فعلية) عندما تكون
 * متغيرات البيئة بأسماء KV_REST_API_* أو UPSTASH_REDIS_REST_*، وأنه لا يسقط بصمت إلى مخزن الذاكرة.
 * fetch هنا مُحاكى محليًا بدلالات Upstash REST (get/set/del) - لا اتصال حقيقي ولا أسرار حقيقية.
 * التشغيل: node tests/upstash-env.test.js
 */
const { hashCode } = require('../lib/codeAuth');
const { resetMemoryStoreForTests } = require('../lib/storeFactory');

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

const TEST_CODE = 'zxc123';
const ENV_KEYS = ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'ACCESS_CODE_HASHES'];

function installFakeUpstash() {
  const data = new Map();
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const auth = (opts && opts.headers && opts.headers.Authorization) || '';
    calls.push({ host: u.origin, cmd: seg[0], auth });
    let result = null;
    if (seg[0] === 'get') result = data.has(seg[1]) ? data.get(seg[1]) : null;
    else if (seg[0] === 'set') { data.set(seg[1], seg[2]); result = 'OK'; }
    else if (seg[0] === 'del') { result = data.delete(seg[1]) ? 1 : 0; }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return { calls };
}

function callHandler() {
  delete require.cache[require.resolve('../api/verify-code.js')];
  const handler = require('../api/verify-code.js');
  return new Promise((resolve) => {
    const res = { status(code) { return { json(body) { resolve({ status: code, body }); } }; } };
    handler({ method: 'POST', body: { code: TEST_CODE } }, res);
  });
}

function resetEnv(env) {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  process.env.ACCESS_CODE_HASHES = JSON.stringify([hashCode(TEST_CODE)]);
  Object.assign(process.env, env);
  resetMemoryStoreForTests();
}

async function main() {
  // 1) KV_* فقط -> يجب استخدام Upstash الحقيقي (طلبات خارجية) مع تخزين القفل فعليًا
  resetEnv({ KV_REST_API_URL: 'https://kv-host.example.io', KV_REST_API_TOKEN: 'kv-token' });
  let fake = installFakeUpstash();
  let r1 = await callHandler();
  check(r1.status === 200 && r1.body.ok, `[KV_* فقط] أول دخول يجب أن ينجح - status=${r1.status}`);
  check(fake.calls.length > 0, '[KV_* فقط] يجب حدوث طلبات خارجية إلى Upstash (وليس مخزن الذاكرة)');
  check(fake.calls.every((c) => c.host === 'https://kv-host.example.io'), '[KV_* فقط] كل الطلبات يجب أن تذهب إلى KV_REST_API_URL');
  check(fake.calls.every((c) => c.auth === 'Bearer kv-token'), '[KV_* فقط] يجب استخدام KV_REST_API_TOKEN في ترويسة Authorization');
  let r2 = await callHandler();
  check(r2.status === 409, `[KV_* فقط] الدخول الثاني بنفس الكود يجب أن يُرفض (409) لأن القفل محفوظ في المخزن الحقيقي - status=${r2.status}`);

  // 2) UPSTASH_* لها الأولوية على KV_* عند وجود الاثنين
  resetEnv({
    UPSTASH_REDIS_REST_URL: 'https://upstash-host.example.io', UPSTASH_REDIS_REST_TOKEN: 'up-token',
    KV_REST_API_URL: 'https://kv-host.example.io', KV_REST_API_TOKEN: 'kv-token',
  });
  fake = installFakeUpstash();
  await callHandler();
  check(fake.calls.length > 0 && fake.calls.every((c) => c.host === 'https://upstash-host.example.io' && c.auth === 'Bearer up-token'),
    '[الأولوية] UPSTASH_* يجب أن تتقدم على KV_REST_API_* عند وجود الاثنين');

  // 3) UPSTASH_* فقط (السلوك السابق) -> لا regression
  resetEnv({ UPSTASH_REDIS_REST_URL: 'https://upstash-host.example.io', UPSTASH_REDIS_REST_TOKEN: 'up-token' });
  fake = installFakeUpstash();
  const r3 = await callHandler();
  check(r3.status === 200 && fake.calls.length > 0, '[UPSTASH_* فقط] يجب أن يعمل كما كان سابقًا عبر Upstash الحقيقي');

  // 4) لا متغيرات -> مخزن الذاكرة المحلي (تطوير/اختبار) بدون أي طلب خارجي
  resetEnv({});
  fake = installFakeUpstash();
  const r4 = await callHandler();
  check(r4.status === 200 && fake.calls.length === 0, '[بلا متغيرات] يجب أن يبقى السلوك المحلي كما هو (ذاكرة، بلا طلبات خارجية)');

  console.log('=== نتيجة اختبار متغيرات بيئة Upstash / KV ===');
  if (failures.length === 0) { console.log('✅ نجحت جميع الاختبارات (4 سيناريوهات)'); process.exit(0); }
  console.log(`❌ فشل ${failures.length}:`); failures.forEach((f) => console.log('  - ' + f)); process.exit(1);
}
main();
