'use strict';
/**
 * منطق نظام أكواد الدخول وقفل الجهاز الواحد - معزول تمامًا عن أي تفاصيل شبكية
 * (Vercel / Upstash) حتى يمكن اختباره آليًا بالكامل بدون أي اتصال إنترنت.
 *
 * أي دالة هنا تستقبل "store" كوسيط: كائن يوفر get/set/del بنفس دلالات Upstash Redis
 * (set مع خيار EX بالثواني). في الإنتاج، "store" الحقيقي (lib/upstashClient.js) ينفّذها
 * عبر REST API. في الاختبارات، نستخدم مخزنًا وهميًا في الذاكرة بنفس الدلالات بالضبط
 * (بما في ذلك انتهاء الصلاحية الفعلي بمرور الوقت).
 */

const crypto = require('crypto');

const CONST = {
  SESSION_TTL_SECONDS: 90, // مدة قفل الجلسة في Redis؛ يُجدَّد بنبضات (heartbeat) من العميل كل ~25-30 ثانية
  RECONNECT_GRACE_SECONDS: 60, // "دقيقة واحدة أو أقل" حسب الـMaster Prompt
};

function normalizeCode(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isValidFormat(code) {
  return /^[a-z]{2,4}[0-9]{2,4}$/.test(code) && code.length === 6;
}

function hashCode(code) {
  return crypto.createHash('sha256').update('bombgame_salt_v1:' + code).digest('hex');
}

function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function lockKeyFor(hash) {
  return 'session_lock:' + hash;
}

/**
 * محاولة تسجيل الدخول بكود. لا تكشف أبدًا أي معلومة عن الكود نفسه أو عن أكواد أخرى.
 * @param {object} params { code, allowedHashes: string[] }
 * @param {object} store { get, set, del }
 */
async function attemptLogin({ code, allowedHashes }, store) {
  const normalized = normalizeCode(code);
  if (!isValidFormat(normalized)) {
    return { status: 400, body: { ok: false, error: 'صيغة الكود غير صحيحة' } };
  }
  const hash = hashCode(normalized);
  if (!allowedHashes || !allowedHashes.includes(hash)) {
    return { status: 401, body: { ok: false, error: 'الكود غير صحيح' } };
  }

  const key = lockKeyFor(hash);
  const existing = await store.get(key);
  if (existing) {
    return { status: 409, body: { ok: false, error: 'هذا الكود مستخدم حاليًا من جهاز آخر' } };
  }

  const sessionToken = generateSessionToken();
  await store.set(key, sessionToken, CONST.SESSION_TTL_SECONDS);
  return {
    status: 200,
    body: { ok: true, sessionToken, codeHash: hash, expiresInSeconds: CONST.SESSION_TTL_SECONDS },
  };
}

/**
 * نبضة حياة (heartbeat) من العميل للحفاظ على الجلسة حية أثناء الاستخدام الطبيعي،
 * ولاستعادتها إذا عاد الاتصال خلال مهلة السماح.
 */
async function heartbeat({ codeHash, sessionToken }, store) {
  if (!codeHash || !sessionToken) {
    return { status: 400, body: { ok: false, error: 'بيانات جلسة ناقصة' } };
  }
  const key = lockKeyFor(codeHash);
  const current = await store.get(key);
  if (!current) {
    // انتهت المهلة (أكثر من دقيقة بدون نبضة) - يجب إعادة إدخال الكود
    return { status: 410, body: { ok: false, error: 'انتهت صلاحية الجلسة، الرجاء إدخال الكود من جديد' } };
  }
  if (current !== sessionToken) {
    // جهاز آخر استولى على الكود بعد انتهاء جلستنا السابقة
    return { status: 409, body: { ok: false, error: 'تم استخدام هذا الكود من جهاز آخر' } };
  }
  await store.set(key, sessionToken, CONST.SESSION_TTL_SECONDS);
  return { status: 200, body: { ok: true, expiresInSeconds: CONST.SESSION_TTL_SECONDS } };
}

/** تحرير الجلسة صراحة (مثلًا عند الضغط على "خروج") */
async function releaseSession({ codeHash, sessionToken }, store) {
  if (!codeHash || !sessionToken) return { status: 400, body: { ok: false, error: 'بيانات جلسة ناقصة' } };
  const key = lockKeyFor(codeHash);
  const current = await store.get(key);
  if (current === sessionToken) await store.del(key);
  return { status: 200, body: { ok: true } };
}

module.exports = {
  CONST,
  normalizeCode,
  isValidFormat,
  hashCode,
  generateSessionToken,
  lockKeyFor,
  attemptLogin,
  heartbeat,
  releaseSession,
};
