// ============================================================
// 함께 육아일지 서비스워커 — 홈 화면 설치(PWA) + 오프라인 + 안드로이드 알림 버튼 빠른 기록
//
// 캐시 전략
//   · 앱 핵심 파일(CORE): 캐시 먼저 → 새벽에 인터넷이 없어도 바로 열림.
//     화면을 열 때(내비게이션) 뒤에서 CORE 전체를 한꺼번에 새로 받아, 전부 성공했을 때만 캐시를 바꾼다.
//     (파일마다 따로 갱신하면 새 app.js + 옛 logic.js 처럼 버전이 섞여 모듈 import 가 깨질 수 있어서)
//   · 그 밖의 같은 출처 GET(아이콘 등): stale-while-revalidate.
//   · 다른 출처(서버 함수·글꼴)와 POST 는 건드리지 않는다.
//   · activate 때 옛 캐시 정리는 'uriday-bl-' 로 시작하는 내 캐시만 — 데이터 캐시(DATA_CACHE)는 절대 지우지 않는다.
//
// 알림 버튼 (sync.js 머리 주석의 계약)
//   · 페이지가 Cache Storage `DATA_CACHE`의 ./__bl/config 에 { endpoint, token, meId, quickActions, lastMl, babyName } 을 써 둔다.
//   · 버튼 탭 → id(uuid)를 먼저 만들고, 공유 중이면 quick 주소에 POST (&src=notif&id=&ts=).
//     실패하거나 공유 전이면 같은 id 로 ./__bl/inbox/<id> 에 한 건 넣는다 → 앱을 열면 sync.drainInbox 가 가져감.
//     (서버에 사실은 들어갔는데 응답만 끊긴 경우도 서버가 id 로 중복을 막는다)
//   · 그다음 같은 tag 로 알림을 다시 띄운다 (웹엔 '고정 알림'이 없어서 — RESEARCH D). 본문 = 서버 응답 첫 줄.
// ============================================================

const CACHE = 'uriday-bl-v1';
// ⚠ sync.js 의 SW_DATA_CACHE 와 같은 값이어야 한다 (알림 버튼 설정·수신함)
const DATA_CACHE = 'uriday-bl-data';
const QUICK_TAG = 'bl-quick';

const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './log-data.js',
  './logic.js',
  './store.js',
  './sync.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  '../shared/css/base.css',
  '../shared/js/brand.js',
  '../shared/js/date-utils.js',
  '../baby-today/today-data.js',
];
const CORE_URLS = CORE.map((p) => new URL(p, self.location).href);
const SHELL = new URL('./', self.location).href;
const SHELL_ALT = new URL('./index.html', self.location).href;

// 알림 버튼 이름 (log-data.js EVENT_TYPES 와 같은 이름·이모지)
const LABELS = {
  pee: { label: '소변', emoji: '💧' },
  poop: { label: '대변', emoji: '💩' },
  both: { label: '소변+대변', emoji: '💧💩' },
  formula: { label: '분유', emoji: '🍼' },
  pumped: { label: '유축', emoji: '🫗' },
  burp: { label: '트림', emoji: '😮‍💨' },
  bath: { label: '목욕', emoji: '🛁' },
  tummy: { label: '터미타임', emoji: '🐢' },
};

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.startsWith('uriday-bl-') && k !== CACHE && k !== DATA_CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---------- 캐시 ----------
let lastRefresh = 0;
let refreshing = null;
/** CORE 전체를 새로 받아 모두 성공했을 때만 교체 (60초에 한 번까지) */
function refreshCore() {
  if (refreshing) return refreshing;
  if (Date.now() - lastRefresh < 60000) return Promise.resolve();
  lastRefresh = Date.now();
  refreshing = (async () => {
    try {
      const res = await Promise.all(CORE_URLS.map((u) => fetch(u, { cache: 'no-cache' })));
      if (!res.every((r) => r.ok)) return;
      const c = await caches.open(CACHE);
      await Promise.all(res.map((r, i) => c.put(CORE_URLS[i], r)));
    } catch (err) {
      /* 오프라인 — 다음에 다시 */
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function shellResponse(req) {
  const c = await caches.open(CACHE);
  const cached = (await c.match(SHELL)) || (await c.match(SHELL_ALT));
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) c.put(SHELL, res.clone());
    return res;
  } catch (err) {
    return Response.error();
  }
}

async function cacheFirst(key, req) {
  const c = await caches.open(CACHE);
  const cached = await c.match(key);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) c.put(key, res.clone());
  return res;
}

async function staleWhileRevalidate(req) {
  const c = await caches.open(CACHE);
  const cached = await c.match(req);
  const fetched = fetch(req)
    .then((res) => {
      if (res.ok) c.put(req, res.clone());
      return res;
    })
    .catch(() => cached || Response.error());
  return cached || fetched;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/__bl/')) return;
  const bare = url.origin + url.pathname;
  if (req.mode === 'navigate') {
    // ?q=pee(홈 화면 바로가기)·#join= 이 붙어 와도 같은 앱 화면
    if (bare === SHELL || bare === SHELL_ALT) {
      e.respondWith(shellResponse(req));
      e.waitUntil(refreshCore());
    }
    return;
  }
  const i = CORE_URLS.indexOf(bare);
  if (i >= 0 && !url.search) {
    e.respondWith(cacheFirst(CORE_URLS[i], req));
    return;
  }
  e.respondWith(staleWhileRevalidate(req));
});

// ---------- 알림 버튼 빠른 기록 ----------
function dataUrl(path) {
  return new URL(path, self.registration.scope).href;
}

async function readConfig() {
  try {
    const c = await caches.open(DATA_CACHE);
    const r = await c.match(dataUrl('./__bl/config'));
    return r ? await r.json() : null;
  } catch (err) {
    return null;
  }
}

function uuid() {
  if (self.crypto && typeof self.crypto.randomUUID === 'function') return self.crypto.randomUUID();
  const b = new Uint8Array(16);
  self.crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// '오후 3:12' (기기 시간대)
function fmtTime(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function mlFor(type, cfg) {
  const last = cfg && cfg.lastMl ? cfg.lastMl : {};
  return Number(last[type]) || Number(last.formula) || 100;
}

/** 수신함에 한 건 넣기 (앱이 열리면 sync.drainInbox 가 가져감) */
async function queueInbox(id, type, ts, cfg) {
  const data = { src: 'notif' };
  if (type === 'formula' || type === 'pumped') data.ml = mlFor(type, cfg);
  if (type === 'tummy') data.min = 5;
  const body = { id, type, ts, by: (cfg && cfg.meId) || null, data };
  const c = await caches.open(DATA_CACHE);
  await c.put(dataUrl(`./__bl/inbox/${id}`), new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  }));
}

async function postQuick(cfg, type, id, ts) {
  const u = new URL(cfg.endpoint);
  u.searchParams.set('a', 'q');
  u.searchParams.set('k', cfg.token);
  u.searchParams.set('t', type);
  if (type === 'formula' || type === 'pumped') u.searchParams.set('ml', String(mlFor(type, cfg)));
  u.searchParams.set('src', 'notif');
  u.searchParams.set('id', id);
  u.searchParams.set('ts', String(ts));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(u.href, { method: 'POST', signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    const text = (await res.text()).trim();
    return { status: res.status, ok: res.ok, text };
  } finally {
    clearTimeout(timer);
  }
}

async function showQuick(body) {
  const cfg = (await readConfig()) || {};
  const acts = (Array.isArray(cfg.quickActions) ? cfg.quickActions : ['pee', 'poop']).filter((t) => LABELS[t]).slice(0, 2);
  const title = `📒 ${cfg.babyName || '우리 아기'} 빠른 기록`;
  return self.registration.showNotification(title, {
    tag: QUICK_TAG,
    body: body || '버튼을 누르면 바로 기록돼요 (잠금화면에서도)',
    icon: 'icons/icon-192.png',
    silent: true,
    renotify: false,
    requireInteraction: true,
    actions: acts.map((t) => ({ action: t, title: `${LABELS[t].emoji} ${LABELS[t].label}` })),
    data: { blQuick: true },
  });
}

async function tellClients() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) c.postMessage({ type: 'bl-inbox' });
}

async function handleAction(type) {
  if (!LABELS[type]) return;
  const cfg = await readConfig();
  const id = uuid();
  const ts = Date.now();
  const what = `${LABELS[type].emoji} ${LABELS[type].label}`;
  let body;
  if (cfg && cfg.endpoint && cfg.token) {
    try {
      const r = await postQuick(cfg, type, id, ts);
      if (r.ok) {
        body = r.text || `✓ ${what} 기록 · ${fmtTime(ts)}`;
      } else if (r.status === 400) {
        // 서버가 내용을 받지 않음 — 다시 보내도 같으니 알림으로만 알린다
        body = `⚠ ${r.text.split('\n')[0] || '기록하지 못했어요'} — 앱에서 기록해 주세요`;
      } else {
        throw new Error(`HTTP ${r.status}`);
      }
    } catch (err) {
      await queueInbox(id, type, ts, cfg);
      body = `✓ ${what} 기록 · ${fmtTime(ts)}\n인터넷이 연결되면 가족에게 보내져요`;
    }
  } else {
    await queueInbox(id, type, ts, cfg);
    body = `✓ ${what} 기록 · ${fmtTime(ts)}\n앱을 열면 기록에 들어가요`;
  }
  await tellClients().catch(() => {});
  await showQuick(body);
}

async function focusApp() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of all) {
    if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
  }
  return self.clients.openWindow ? self.clients.openWindow('./') : undefined;
}

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  if (e.action) {
    // 버튼: 앱을 열지 않고(잠금 해제 없이) 바로 기록
    e.waitUntil(handleAction(e.action).catch(() => showQuick('기록하지 못했어요 — 앱에서 기록해 주세요')));
    return;
  }
  if (!(n.data && n.data.blQuick)) n.close();
  e.waitUntil(focusApp());
});

self.addEventListener('message', (e) => {
  const t = e.data && e.data.type;
  if (t === 'bl-quick-show') e.waitUntil(showQuick());
});
