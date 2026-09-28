// uridaylog — 로컬 개발 서버 (함께 육아일지 e2e·수동 확인용, 배포하지 않음)
//   · 저장소 루트의 정적 파일을 서빙하고, /api 는 handler.js(Edge Function 과 같은 코드)로 넘긴다.
//   · 실행:  cd supabase/functions/uriday-log && npm install
//            DATABASE_URL=postgresql://postgres@localhost:54329/babylog node dev-server.mjs
//   · 앱 연결: 브라우저 콘솔에서 localStorage['bl:devEndpoint'] = 'http://localhost:5190/api'
//   · 환경변수: DATABASE_URL (없으면 /api 는 503), PORT (기본 5190), HOST (기본: 모든 인터페이스), BL_SALT
//   · 스키마 uriday 가 없으면 마이그레이션을 자동으로 적용한다 (로컬 DB 전용 편의 기능).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createHandler, LIMITS } from './handler.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const MIGRATION = path.resolve(ROOT, 'supabase/migrations/20260928000000_uriday_log.sql');
const PORT = Number(process.env.PORT) || 5190;
const HOST = process.env.HOST || undefined;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

// ── DB + 핸들러 ──────────────────────────────────────────────────────────
let sql = null;
let handler = null;
if (process.env.DATABASE_URL) {
  sql = postgres(process.env.DATABASE_URL, { max: 5, onnotice: () => {} });
  const [{ t }] = await sql`select to_regclass('uriday.events') as t`;
  if (!t) {
    await sql.unsafe(await readFile(MIGRATION, 'utf8'));
    console.log('· 스키마 uriday 가 없어서 마이그레이션을 적용했어요');
  }
  handler = createHandler({ sql, salt: process.env.BL_SALT ?? 'dev' });
} else {
  console.warn('· DATABASE_URL 이 없어요 — 정적 파일만 서빙하고 /api 는 503 을 돌려줍니다');
}

// ── 공통 ─────────────────────────────────────────────────────────────────
function send(res, status, body = '', headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
// 본문 읽기 (256KB 판정은 핸들러가 한다 — 4MB 가 넘으면 버리면서 끝까지 흘려보낸 뒤 413)
function readAll(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total <= max) chunks.push(c);
    });
    req.on('end', () => (total > max ? reject(Object.assign(new Error('too large'), { tooLarge: true })) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'expect']);

// ── /api → handler (Node req → Request, Response → Node res) ─────────────
async function api(req, res, url) {
  if (!handler) {
    return send(res, 503, JSON.stringify({ ok: false, error: 'server', message: 'DATABASE_URL 을 설정하고 다시 실행해 주세요' }), {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
  }
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    try {
      body = await readAll(req, LIMITS.body * 16);
    } catch (e) {
      if (!e.tooLarge) throw e;
      return send(res, 413, JSON.stringify({ ok: false, error: 'too_large', message: '요청이 너무 커요' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
    }
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k) || v == null) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  headers.set('x-forwarded-for', req.socket.remoteAddress || 'local'); // 레이트 리밋 버킷용
  const request = new Request(url, { method: req.method, headers, body });
  const response = await handler(request);
  const out = {};
  response.headers.forEach((v, k) => {
    out[k] = v;
  });
  const buf = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, out);
  res.end(req.method === 'HEAD' || response.status === 204 ? undefined : buf);
}

// ── 정적 파일 ────────────────────────────────────────────────────────────
async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'GET 만 돼요', { Allow: 'GET, HEAD' });
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, '잘못된 경로');
  }
  if (rel.includes('\0') || rel.includes('\\')) return send(res, 400, '잘못된 경로');
  const segs = rel.split('/').filter(Boolean);
  // '..'·'.git'·'.env' 같은 점으로 시작하는 경로는 전부 거절 (경로 탈출 방지)
  if (segs.some((s) => s.startsWith('.'))) return send(res, 404, '없어요');
  let file = path.resolve(ROOT, ...segs);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return send(res, 403, '안 돼요');
  let st = await stat(file).catch(() => null);
  if (st?.isDirectory()) {
    if (!url.pathname.endsWith('/')) return send(res, 301, '', { Location: `${url.pathname}/${url.search}` });
    file = path.join(file, 'index.html');
    st = await stat(file).catch(() => null);
  }
  if (!st?.isFile()) return send(res, 404, '없어요');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const data = req.method === 'HEAD' ? null : await readFile(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  res.end(data ?? undefined);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || `localhost:${PORT}`}`);
    // 토큰이 쿼리에 실릴 수 있으므로 경로만 기록한다
    if (process.env.BL_DEV_LOG) console.log(req.method, url.pathname);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    console.error('dev-server 오류:', e?.message || e);
    if (!res.headersSent) send(res, 500, '서버 오류');
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`uridaylog dev server → http://localhost:${PORT}/  (API: http://localhost:${PORT}/api)`);
  console.log(`  함께 육아일지: http://localhost:${PORT}/baby-log/`);
});

const shutdown = async () => {
  server.close();
  await sql?.end({ timeout: 2 }).catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
