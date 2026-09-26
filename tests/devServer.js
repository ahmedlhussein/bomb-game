'use strict';
/**
 * خادم تطوير محلي بسيط جدًا (بدون أي مكتبات خارجية) لأغراض الاختبار الآلي المتكامل فقط.
 * يحاكي سلوك Vercel: يخدم public/ كملفات ثابتة، ويشغّل api/*.js كدوال حقيقية بنفس التوقيع
 * (req, res) مع محاكاة req.body وres.status().json() كما تفعل Vercel Node Functions.
 * هذا ليس جزءًا من عملية النشر - Vercel تتولى هذا تلقائيًا في الإنتاج.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const API_DIR = path.join(__dirname, '..', 'api');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => {
      try { resolve(chunks ? JSON.parse(chunks) : {}); } catch (e) { resolve({}); }
    });
  });
}

async function handleApi(req, res, apiName) {
  const handlerPath = path.join(API_DIR, apiName + '.js');
  if (!fs.existsSync(handlerPath)) return sendJson(res, 404, { ok: false, error: 'not found' });
  delete require.cache[require.resolve(handlerPath)]; // إعادة تحميل نظيفة لكل طلب أثناء الاختبار
  const handler = require(handlerPath);
  req.body = await readBody(req);
  res.status = (code) => ({ json: (obj) => sendJson(res, code, obj) });
  await handler(req, res);
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': (MIME[ext] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsed = url.parse(req.url);
    if (parsed.pathname.startsWith('/api/')) {
      const apiName = parsed.pathname.replace('/api/', '');
      try {
        await handleApi(req, res, apiName);
      } catch (e) {
        sendJson(res, 500, { ok: false, error: 'server error: ' + e.message });
      }
      return;
    }
    serveStatic(req, res, parsed.pathname);
  });
}

if (require.main === module) {
  const port = process.env.PORT || 3411;
  createServer().listen(port, () => console.log('Dev server running on http://localhost:' + port));
}

module.exports = { createServer };
