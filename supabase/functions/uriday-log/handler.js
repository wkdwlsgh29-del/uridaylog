// uridaylog — 함께 육아일지 동기화 서버 로직 (Edge Function uriday-log 의 본체)
//
// 런타임 무관: Node 22(테스트·dev-server.mjs)와 Deno(Supabase Edge, index.ts)에서 그대로 돈다.
//   · npm 패키지를 import 하지 않는다 — postgres.js 인스턴스(sql)를 주입받는다.
//   · 암호화는 Web Crypto(crypto.subtle / crypto.getRandomValues)만 쓴다.
// 설계서: SPEC §6 — 단일 엔드포인트 JSON API(create/peek/join/sync/invite/remove/admin/leave)
//          + 단축어·알림용 quick 엔드포인트(POST ?a=q&k=TOKEN&t=TYPE …, 응답은 한국어 한 줄 텍스트).
//
// 데이터 원칙 (새벽 3시에도 기록이 사라지지 않게)
//   · 같은 가족의 모든 쓰기는 families 행을 select … for update 로 잠근 뒤 rev 를 받는다
//     → 한 가족 안에서 rev 는 커밋 순서대로 증가, 읽는 쪽 커서(since)가 기록을 건너뛰지 않는다.
//   · 기록 충돌은 updatedAt 기준 LWW(나중에 고친 것이 이김). 삭제는 툼스톤(deleted=true).
//   · 클라이언트 입력은 전부 검증: 타입 화이트리스트, uuid 형식, 숫자 범위, 문자열 길이(잘라냄),
//     타입별 허용 키 외에는 버림, jsonb 가 거부하는 \u0000·짝 없는 서로게이트 제거.
// 보안
//   · 기기 토큰·초대코드는 sha256 해시만 저장·비교한다. 토큰·요청 본문·URL 은 절대 로그에 남기지 않는다.
//   · devices.last_seen_at 같은 기기별 활동 정보는 서버 내부용 — 응답에 절대 싣지 않는다(시터 사생활).
//
// API 요약 (POST JSON { a, ... } → { ok:true, ... } | { ok:false, error, message })
//   create { family, members[≤20], meId, events[≤2000] } → { token, invite, familyId, me, family, members, rev:0, rejected }
//   peek   { invite }                                    → { family:{name}, members:[{id,name,role,emoji,claimed}] }
//   peek   { device }  (기기 연결 코드, 쓰지 않음)         → { family:{name}, member:{id,name,role,emoji} }
//   join   { invite, claim(기기 없는 자리만) | me:{id?,name,role,emoji} } → { token, familyId, me, family, members, rev:0 }
//   join   { device }  (1회용·15분)                      → 위와 같은 모양 (코드를 만든 그 사람으로 연결)
//   devlink { k }                                        → { code, expiresAt }  (내 다른 기기 연결 코드)
//   sync   { k, since, push[≤500], members[≤20], family? } → { events, more, rev, members, family, me, serverTime, rejected,
//                                                             rejectedMembers?, reset? }
//   invite { k } (관리자) → { invite } · remove { k, memberId } (관리자) → { members } · admin { k, memberId, on } → { members }
//   unlink { k, memberId } (관리자, 나 자신 X) → { members }  — 내보내지 않고 기기만 모두 끊기 (다시 차지 가능한 자리로)
//   leave  { k } → {}
//   quick  POST ?a=q&k=TOKEN&t=TYPE[&ml=&side=&min=&color=&texture=&c=&name=&result=&text=&say=&src=notif&id=&ts=]
//          → text/plain "✓ 소변 기록 · 오후 3:12 · 아빠\n오늘 소변 6번째"
import { parseSay } from './parse.js';

// ── 한도 ─────────────────────────────────────────────────────────────────
export const LIMITS = {
  body: 256 * 1024, // 요청 본문 최대 (넘으면 413)
  push: 500, // sync 한 번에 올리는 기록 수
  createEvents: 2000, // create 한 번에 올리는 기존 기록 수 (본문 256KB 한도가 먼저 걸릴 수 있음)
  membersPerRequest: 20,
  membersPerFamily: 50,
  page: 1000, // pull 한 번에 내려주는 기록 수
  rate: { create: 30, join: 60, peek: 120 }, // IP 해시 버킷당 1시간 (이동통신 CGNAT 로 IP 를 여럿이 나눠 쓰는 걸 감안)
  deviceLinkMs: 15 * 60 * 1000, // 기기 연결 코드 유효 시간
};
const TS_MIN = 946684800000; // 2000-01-01 — 이보다 이른 epoch ms 는 잘못된 값
const TS_MAX = 4102444800000; // 2100-01-01
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const ROLES = ['mom', 'dad', 'sitter', 'grandma', 'grandpa', 'other'];
const ROLE_LABEL = { mom: '엄마', dad: '아빠', sitter: '시터', grandma: '할머니', grandpa: '할아버지', other: '가족' };
const ROLE_EMOJI = { mom: '👩', dad: '👨', sitter: '🧑‍🍼', grandma: '👵', grandpa: '👴', other: '🙂' };

// SPEC §4 기록 종류 (+ handoff/ack 추가분). label 은 quick 응답 문구용 — 앱 baby-log/log-data.js 와 같은 이름.
const TYPES = {
  formula: { label: '분유', emoji: '🍼', feed: true, ml: true },
  breast: { label: '모유', emoji: '🤱', feed: true },
  pumped: { label: '유축 수유', emoji: '🫗', feed: true, ml: true },
  milk: { label: '우유', emoji: '🥛', ml: true }, // 앱과 같이 '수유' 횟수에서는 뺀다 (돌 이후 식사의 일부)
  pee: { label: '소변', emoji: '💧' },
  poop: { label: '대변', emoji: '💩' },
  burp: { label: '트림', emoji: '😮‍💨' },
  sleep: { label: '잠', emoji: '😴' },
  bath: { label: '목욕', emoji: '🛁' },
  tummy: { label: '터미타임', emoji: '🐢' },
  brush: { label: '양치', emoji: '🪥' },
  water: { label: '물', emoji: '🥤' },
  solid: { label: '이유식', emoji: '🥣' },
  meal: { label: '식사', emoji: '🍚' },
  snack: { label: '간식', emoji: '🍪' },
  temp: { label: '체온', emoji: '🌡️' },
  med: { label: '약', emoji: '💊' },
  potty: { label: '변기', emoji: '🚽' },
  note: { label: '메모', emoji: '📝' },
  thanks: { label: '고마워요', emoji: '💛', noQuick: true },
  handoff: { label: '바통 넘기기', emoji: '📋', noQuick: true },
  ack: { label: '받았어요', emoji: '✅', noQuick: true },
};
const ML_DEFAULT = 100; // 분유(유축·우유) 양을 안 보냈고 이전 기록도 없을 때
const FEED_TYPES = ['formula', 'breast', 'pumped']; // 앱 log-data.js FEED_TYPES 와 같게
const BURP_FEEDS = ['formula', 'breast', 'pumped']; // 트림을 붙일 수 있는 수유
const TEXTURES = new Set(['watery', 'soft', 'normal', 'hard']);
const AMOUNTS = new Set(['little', 'half', 'all', 'more']);
const REACTIONS = new Set(['good', 'meh', 'refuse', 'allergy']);
const POTTY = new Set(['pee', 'poop', 'try', 'accident']);
const SRCS = new Set(['app', 'shortcut', 'notif', 'say']);
const COLOR_LABEL = { yellow: '노랑', green: '초록', brown: '갈색', black: '검정', red: '빨강', pale: '흰색·회색' }; // 앱 POOP_COLORS id
const TEXTURE_LABEL = { watery: '묽음', soft: '무름', normal: '보통', hard: '단단' };
const SIDE_LABEL = { L: '왼쪽', R: '오른쪽', both: '양쪽' };

const MSG = {
  bad_request: '요청 형식이 올바르지 않아요',
  unauthorized: '이 기기의 가족 연결이 끊겼어요. 초대 링크로 다시 참여해 주세요',
  invite_invalid: '초대 링크가 올바르지 않거나 새 링크로 바뀌었어요. 새 초대 링크를 받아 주세요',
  device_invalid: '기기 연결 코드가 만료됐거나 이미 사용됐어요. 새로 만들어 주세요.',
  claimed: '이미 다른 기기에서 쓰는 사람이에요. 그 기기의 설정 > "내 다른 기기 연결"로 연결해 주세요.',
  forbidden: '관리자만 할 수 있어요',
  rate_limited: '요청이 너무 많아요. 잠시 후 다시 시도해 주세요',
  too_large: '한 번에 보내는 기록이 너무 많아요. 나눠서 보내 주세요',
  server: '서버에 잠시 문제가 있어요. 잠시 후 다시 시도해 주세요',
};
const QUICK_401 = '기록 주소가 올바르지 않거나 가족 연결이 끊겼어요.\n앱의 🔒 잠금화면 기록에서 주소를 다시 복사해 주세요';
const GET_HINT = '단축어에서 방법을 POST로 바꿔 주세요';

class HttpError extends Error {
  constructor(status, code, message, headers) {
    super(message || MSG[code] || code);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
const bad = (message) => new HttpError(400, 'bad_request', message || MSG.bad_request);

// ── 응답 ─────────────────────────────────────────────────────────────────
const BASE_HEADERS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
const PREFLIGHT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey, x-client-info, x-bl-key',
  'Access-Control-Max-Age': '86400',
};
function json(obj, status = 200, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}
function text(body, status = 200, extra) {
  return new Response(body, { status, headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra } });
}

// ── 입력 정리 ────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
function numOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}
function intIn(v, lo, hi) {
  const n = numOf(v);
  if (n == null) return null;
  const r = Math.round(n);
  return r >= lo && r <= hi ? r : null;
}
function epochOf(v) {
  const n = numOf(v);
  if (n == null) return null;
  const r = Math.round(n);
  return r >= TS_MIN && r <= TS_MAX ? r : null;
}
// 문자열 정리: 짝 없는 서로게이트 → U+FFFD, 제어문자 제거(여러 줄 허용 시 \n·\t 유지), 코드포인트 기준 max 자로 자름
function cleanStr(v, max, { multiline = false } = {}) {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  let s = typeof v.toWellFormed === 'function' ? v.toWellFormed() : v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
  s = multiline
    ? s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    : s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ');
  s = s.trim();
  const cps = Array.from(s);
  if (cps.length > max) s = cps.slice(0, max).join('').trim();
  return s;
}
const SEGMENTER = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ko', { granularity: 'grapheme' }) : null;
const utf8Len = (s) => new TextEncoder().encode(s).length;
// 이모지: 8자 이하면 그대로, 길면 첫 글자(그래핌)만. DB 한도 32바이트.
function cleanEmoji(v) {
  let s = cleanStr(v, 64);
  if (!s) return '';
  if (Array.from(s).length > 8) {
    s = SEGMENTER ? SEGMENTER.segment(s)[Symbol.iterator]().next().value?.segment || '' : Array.from(s)[0];
    if (Array.from(s).length > 8) return '';
  }
  return utf8Len(s) <= 32 ? s : '';
}
function birthOf(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1990 || y > 2100 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return v;
}
function arrayOf(v, max, what, { status = 400 } = {}) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw bad(`${what} 형식이 올바르지 않아요`);
  if (v.length > max) {
    throw status === 413 ? new HttpError(413, 'too_large', `${MSG.too_large} (한 번에 ${max}개까지)`) : bad(`${what}는 한 번에 ${max}개까지 보낼 수 있어요`);
  }
  return v;
}

// 기록 data 정리 — 타입별 허용 키만 남긴다. 필수 값이 없거나 범위 밖이면 null(=거부).
// 툼스톤(deleted)은 필수 값이 없어도 받아 준다 (삭제는 반드시 전파돼야 하므로).
function cleanData(type, raw, deleted) {
  const d = isObj(raw) ? raw : {};
  const out = {};
  const burp = () => {
    if (d.burp === 'yes' || d.burp === 'no') out.burp = d.burp;
  };
  const opt = (key, v) => {
    if (v != null && v !== '') out[key] = v;
  };
  switch (type) {
    case 'formula':
    case 'pumped':
    case 'milk': {
      const ml = intIn(d.ml, 1, 500);
      if (ml == null && !deleted) return null;
      opt('ml', ml);
      burp();
      break;
    }
    case 'breast':
      out.side = d.side === 'L' || d.side === 'R' || d.side === 'both' ? d.side : 'both';
      opt('min', intIn(d.min, 1, 120));
      burp();
      break;
    case 'poop':
      if (typeof d.color === 'string' && /^[a-z_]{2,16}$/.test(d.color)) out.color = d.color;
      if (TEXTURES.has(d.texture)) out.texture = d.texture;
      break;
    case 'water':
      opt('ml', intIn(d.ml, 1, 1000));
      break;
    case 'sleep':
      opt('end', epochOf(d.end));
      break;
    case 'tummy':
      opt('min', intIn(d.min, 1, 120));
      break;
    case 'solid':
    case 'meal':
    case 'snack':
      opt('food', cleanStr(d.food, 30));
      if (AMOUNTS.has(d.amount)) out.amount = d.amount;
      if (REACTIONS.has(d.reaction)) out.reaction = d.reaction;
      break;
    case 'temp': {
      const c = numOf(d.c);
      const ok = c != null && c >= 34 && c <= 42.5;
      if (!ok && !deleted) return null;
      if (ok) out.c = Math.round(c * 10) / 10;
      break;
    }
    case 'med':
      opt('name', cleanStr(d.name, 20));
      opt('note', cleanStr(d.note, 60, { multiline: true }));
      break;
    case 'potty':
      if (POTTY.has(d.result)) out.result = d.result;
      else if (!deleted) return null;
      break;
    case 'note': {
      const t = cleanStr(d.text, 200, { multiline: true });
      if (!t && !deleted) return null;
      opt('text', t);
      break;
    }
    case 'thanks':
    case 'ack': {
      const target = uuidOf(d.target);
      if (!target && !deleted) return null;
      opt('target', target);
      break;
    }
    case 'handoff': {
      const from = epochOf(d.from);
      const to = epochOf(d.to);
      if ((from == null || to == null) && !deleted) return null;
      opt('from', from);
      opt('to', to);
      break;
    }
    default: // pee · burp · bath · brush — 값 없음
      break;
  }
  if (type !== 'med') opt('note', cleanStr(d.note, 100, { multiline: true }));
  if (SRCS.has(d.src)) out.src = d.src;
  return out;
}

// 기록 한 건 정리 → { row } | { reject: id }
function cleanEvent(raw, memberIds) {
  if (!isObj(raw)) return { reject: null };
  const id = uuidOf(raw.id);
  const rid = typeof raw.id === 'string' ? raw.id.slice(0, 64) : null;
  if (!id) return { reject: rid };
  const type = typeof raw.type === 'string' && Object.hasOwn(TYPES, raw.type) ? raw.type : null;
  const ts = epochOf(raw.ts);
  const updatedAt = epochOf(raw.updatedAt);
  if (!type || ts == null || updatedAt == null) return { reject: id };
  const deleted = raw.deleted === true;
  const data = cleanData(type, raw.data, deleted);
  if (!data || utf8Len(JSON.stringify(data)) > 1500) return { reject: id };
  const by = uuidOf(raw.by);
  return { row: { id, type, ts, member_id: by && memberIds.has(by) ? by : null, data, deleted, updated_at: updatedAt } };
}
function prepareEvents(list, memberIds) {
  const byId = new Map();
  const rejected = [];
  for (const raw of list) {
    const r = cleanEvent(raw, memberIds);
    if (!r.row) {
      if (r.reject) rejected.push(r.reject);
      continue;
    }
    const prev = byId.get(r.row.id); // 같은 id 가 두 번 오면 더 최근(updatedAt) 것만
    if (!prev || r.row.updated_at >= prev.updated_at) byId.set(r.row.id, r.row);
  }
  return { rows: [...byId.values()], rejected };
}

// 구성원 한 명 정리 (프로필 필드만; isAdmin/claimed/revoked 는 서버 소유라 무시)
function cleanMember(raw) {
  if (!isObj(raw)) return null;
  const id = uuidOf(raw.id);
  if (!id) return null;
  const role = ROLES.includes(raw.role) ? raw.role : 'other';
  const name = cleanStr(raw.name, 12) || ROLE_LABEL[role];
  const emoji = cleanEmoji(raw.emoji) || ROLE_EMOJI[role];
  return { id, name, role, emoji, updated_at: epochOf(raw.updatedAt) ?? 0 };
}
function dedupeMembers(list) {
  const m = new Map();
  for (const x of list) m.set(x.id, x);
  return [...m.values()];
}
// 가족 정보 패치: 보낸 필드만 반영 (name/birth 가 undefined 면 그대로 둠)
function cleanFamily(raw, fallbackUpdatedAt) {
  if (!isObj(raw)) return null;
  const updatedAt = epochOf(raw.updatedAt) ?? fallbackUpdatedAt;
  if (updatedAt == null) return null;
  return {
    name: raw.name === undefined ? null : cleanStr(raw.name, 10) ?? '',
    // 빈 값은 '지우기', 형식이 틀린 값은 '그대로 두기' (잘못 보낸 값으로 생일이 지워지지 않게)
    birthSet: raw.birth === '' || raw.birth === null || birthOf(raw.birth) != null,
    birth: birthOf(raw.birth),
    updatedAt,
  };
}

// ── 토큰·해시 ────────────────────────────────────────────────────────────
const HEX = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
export async function sha256hex(s) {
  return HEX(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // 43자 base64url
}
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // I L O U 없음
function randomInvite() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (x) => CROCKFORD[x & 31]).join(''); // 256 % 32 = 0 → 치우침 없음
}
// 초대코드·기기 연결 코드: 16자 Crockford base32. 코드만, 하이픈·소문자, 링크(#join=… / #dev=…) 모두 받는다.
function normCode(v, param) {
  if (typeof v !== 'string') return null;
  let s = v.trim();
  const m = s.match(new RegExp(`(?:^|[#?&])${param}=([^&#\\s]+)`));
  if (m) {
    try {
      s = decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  } else if (/[#?&=]/.test(s)) return null; // 다른 종류의 링크
  s = s.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(s) ? s : null;
}
// 요청에서 초대코드 / 기기 연결 코드 고르기 (device 가 있거나, invite 칸에 #dev= 링크가 붙여졌으면 기기 연결)
function pickCode(body) {
  const devRaw = body.device ?? (typeof body.invite === 'string' && /[#?&]dev=/.test(body.invite) ? body.invite : null);
  if (devRaw != null && devRaw !== '') return { kind: 'device', code: normCode(devRaw, 'dev') };
  return { kind: 'invite', code: normCode(body.invite, 'join') };
}
function tokenOf(v) {
  const k = typeof v === 'string' ? v.trim() : '';
  return /^[A-Za-z0-9_-]{43}$/.test(k) ? k : null;
}

// ── 서울 시간 (Intl, timeZone 'Asia/Seoul') ───────────────────────────────
const SEOUL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Seoul', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});
function seoul(ts) {
  const p = {};
  for (const { type, value } of SEOUL_FMT.formatToParts(new Date(ts))) p[type] = value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
export function seoulDayStart(ts) {
  const p = seoul(ts);
  const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
  return Date.UTC(p.y, p.mo - 1, p.d) - offset;
}
export function fmtTime(ts) {
  const p = seoul(ts);
  return `${p.h < 12 ? '오전' : '오후'} ${p.h % 12 || 12}:${String(p.mi).padStart(2, '0')}`;
}
export function fmtDur(min) {
  const m = Math.round(min);
  if (m < 1) return '1분 미만';
  const h = Math.floor(m / 60);
  if (!h) return `${m}분`;
  return m % 60 ? `${h}시간 ${m % 60}분` : `${h}시간`;
}
function dayLabel(ts, nowMs) {
  if (seoulDayStart(ts) === seoulDayStart(nowMs)) return '오늘';
  const p = seoul(ts);
  return `${p.mo}/${p.d}`;
}
function ageDays(birth, at) {
  const b = birthOf(birth);
  if (!b) return null;
  const [y, m, d] = b.split('-').map(Number);
  return Math.round((seoulDayStart(at) - seoulDayStart(Date.UTC(y, m - 1, d, 3))) / DAY);
}

// ── 본문 읽기 (256KB 한도) ────────────────────────────────────────────────
async function readBody(req) {
  const len = Number(req.headers.get('content-length'));
  if (Number.isFinite(len) && len > LIMITS.body) throw new HttpError(413, 'too_large');
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LIMITS.body) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new HttpError(413, 'too_large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
const decode = (bytes) => new TextDecoder('utf-8').decode(bytes);

// quick 본문은 무엇이 와도 관대하게: 비어 있음 / JSON / form-urlencoded / multipart
async function lenientParams(bytes, contentType) {
  const out = {};
  const put = (k, v) => {
    if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) out[k] = String(v);
  };
  if (!bytes.length) return out;
  try {
    if (/multipart\/form-data/i.test(contentType || '')) {
      const fd = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
      for (const [k, v] of fd) if (typeof v === 'string') put(k, v);
      return out;
    }
    const t = decode(bytes).trim();
    if (t.startsWith('{')) {
      const o = JSON.parse(t);
      if (isObj(o)) for (const [k, v] of Object.entries(o)) put(k, v);
    } else if (/^[\w.%-]+=/.test(t)) {
      for (const [k, v] of new URLSearchParams(t)) put(k, v);
    }
  } catch {
    /* 본문은 무시해도 된다 (쿼리가 기본) */
  }
  return out;
}

// ── 요청 IP → 레이트 리밋 버킷 ────────────────────────────────────────────
function clientIp(req) {
  const h = req.headers;
  return (
    h.get('cf-connecting-ip') ||
    h.get('x-real-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0] ||
    ''
  ).trim().slice(0, 64);
}

// ── 응답 모양 ────────────────────────────────────────────────────────────
const evOut = (r) => ({
  id: r.id,
  type: r.type,
  ts: Number(r.ts),
  by: r.member_id ?? null,
  data: r.data ?? {},
  deleted: !!r.deleted,
  updatedAt: Number(r.updated_at),
  rev: Number(r.rev),
});
const EV_COLS = ['id', 'member_id', 'type', 'ts', 'data', 'deleted', 'updated_at', 'rev'];

export function createHandler({ sql, now = () => Date.now(), salt = '' }) {
  if (!sql) throw new Error('createHandler: sql(postgres.js 인스턴스)가 필요해요');

  // 트랜잭션 (직렬화 실패·교착은 한 번 재시도)
  async function tx(fn) {
    for (let i = 0; ; i++) {
      try {
        return await sql.begin(fn);
      } catch (e) {
        if (i < 1 && (e?.code === '40001' || e?.code === '40P01')) continue;
        throw e;
      }
    }
  }

  async function rateLimit(kind, req) {
    const ip = clientIp(req);
    if (!ip) return; // IP 헤더가 없으면 생략 — 모든 요청이 한 버킷에 몰려 전체가 막히는 것보다 낫다
    const bucket = `${kind}:${(await sha256hex(`${ip}|${salt}`)).slice(0, 32)}`;
    const [r] = await sql`
      insert into uriday.rate as r (bucket, count, window_start) values (${bucket}, 1, now())
      on conflict (bucket) do update set
        count = case when r.window_start <= now() - interval '1 hour' then 1 else r.count + 1 end,
        window_start = case when r.window_start <= now() - interval '1 hour' then now() else r.window_start end
      returning count, ceil(extract(epoch from (r.window_start + interval '1 hour' - now())))::int as retry`;
    if (Math.random() < 0.02) sql`delete from uriday.rate where window_start < now() - interval '1 day'`.catch(() => {});
    if (r.count > LIMITS.rate[kind]) {
      throw new HttpError(429, 'rate_limited', MSG.rate_limited, { 'Retry-After': String(Math.max(1, r.retry || 60)) });
    }
  }

  // 기기 토큰 확인. lock=true 면 가족 행을 잠근 뒤(쓰기 직렬화) 최신 상태로 다시 확인한다.
  async function authDevice(t, hash, lock) {
    if (lock) {
      const [d] = await t`select family_id from uriday.devices where token_hash = ${hash}`;
      if (!d) throw new HttpError(401, 'unauthorized');
      await t`select 1 from uriday.families where id = ${d.family_id} for update`;
    }
    const [me] = await t`
      select d.family_id, d.member_id, m.is_admin, m.name, m.role, m.emoji
      from uriday.devices d
      join uriday.members m on m.family_id = d.family_id and m.id = d.member_id
      where d.token_hash = ${hash} and d.revoked_at is null and m.revoked_at is null`;
    if (!me) throw new HttpError(401, 'unauthorized');
    return me;
  }
  const touch = (t, hash) =>
    t`update uriday.devices set last_seen_at = now()
      where token_hash = ${hash} and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`;

  async function loadMembers(t, fid) {
    const rows = await t`
      select m.id, m.name, m.role, m.emoji, m.updated_at, m.is_admin, m.revoked_at is not null as revoked,
             exists (select 1 from uriday.devices d
                     where d.family_id = m.family_id and d.member_id = m.id and d.revoked_at is null) as claimed
      from uriday.members m where m.family_id = ${fid}
      order by m.created_at, m.id`;
    return rows.map((r) => ({
      id: r.id, name: r.name, role: r.role, emoji: r.emoji, updatedAt: Number(r.updated_at),
      isAdmin: r.is_admin, claimed: r.claimed, revoked: r.revoked,
    }));
  }
  async function loadFamily(t, fid) {
    const [f] = await t`
      select id, baby_name, to_char(birth_date, 'YYYY-MM-DD') as birth, updated_at
      from uriday.families where id = ${fid}`;
    return { id: f.id, name: f.baby_name, birth: f.birth || '', updatedAt: Number(f.updated_at) };
  }
  async function memberIdSet(t, fid) {
    const rows = await t`select id from uriday.members where family_id = ${fid}`;
    return new Set(rows.map((r) => r.id));
  }

  // 구성원 삽입/LWW 갱신. 반환: 인원 한도로 못 넣은 id 목록
  async function upsertMembers(t, fid, list, { adminId = null } = {}) {
    if (!list.length) return [];
    const have = await memberIdSet(t, fid);
    let room = LIMITS.membersPerFamily - have.size;
    const rows = [];
    const skipped = [];
    for (const m of list) {
      if (have.has(m.id)) rows.push(m);
      else if (room > 0) {
        rows.push(m);
        room--;
      } else skipped.push(m.id);
    }
    if (rows.length) {
      await t`
        insert into uriday.members as m (family_id, id, name, role, emoji, is_admin, updated_at, created_at)
        select ${fid}, x.id, x.name, x.role, x.emoji, coalesce(x.id = ${adminId}::uuid, false), x.updated_at,
               now() + x.ord * interval '1 microsecond'
        from jsonb_to_recordset(${sql.json(rows.map((r, ord) => ({ ...r, ord })))})
             as x(id uuid, name text, role text, emoji text, updated_at bigint, ord int)
        on conflict (family_id, id) do update
          set name = excluded.name, role = excluded.role, emoji = excluded.emoji, updated_at = excluded.updated_at
          where m.updated_at < excluded.updated_at`;
    }
    return skipped;
  }

  // 기록 upsert (가족 잠금 안에서만 호출). 반환: 실제로 쓰인 id 집합
  async function upsertEvents(t, fid, rows) {
    if (!rows.length) return new Set();
    const applied = await t`
      insert into uriday.events as e (family_id, id, member_id, type, ts, data, deleted, updated_at, rev)
      select ${fid}, x.id, x.member_id, x.type, x.ts, coalesce(x.data, '{}'::jsonb), coalesce(x.deleted, false),
             x.updated_at, nextval('uriday.rev_seq')
      from jsonb_to_recordset(${sql.json(rows)})
           as x(id uuid, member_id uuid, type text, ts bigint, data jsonb, deleted boolean, updated_at bigint)
      on conflict (family_id, id) do update
        set member_id = excluded.member_id, type = excluded.type, ts = excluded.ts, data = excluded.data,
            deleted = excluded.deleted, updated_at = excluded.updated_at, rev = excluded.rev
        where e.updated_at < excluded.updated_at
      returning e.id`;
    return new Set(applied.map((r) => r.id));
  }

  // ── create ─────────────────────────────────────────────────────────────
  async function actCreate(body, req) {
    const nowMs = now();
    const fam = cleanFamily(body.family, nowMs);
    if (!fam) throw bad('아기 정보(family)가 필요해요');
    const rawMembers = arrayOf(body.members, LIMITS.membersPerRequest, '구성원(members)');
    if (!rawMembers.length) throw bad('구성원(members)이 한 명 이상 필요해요');
    const members = rawMembers.map(cleanMember);
    if (members.some((m) => !m)) throw bad('구성원 id 는 uuid 여야 해요');
    const list = dedupeMembers(members);
    const meId = uuidOf(body.meId);
    if (!meId || !list.some((m) => m.id === meId)) throw bad('meId 가 구성원 목록에 없어요');
    const events = arrayOf(body.events, LIMITS.createEvents, '기록(events)', { status: 413 });
    const { rows, rejected } = prepareEvents(events, new Set(list.map((m) => m.id)));
    await rateLimit('create', req); // 형식 검증을 통과한 요청만 센다
    const token = randomToken();
    const invite = randomInvite();
    const [th, ih] = await Promise.all([sha256hex(token), sha256hex(invite)]);

    return tx(async (t) => {
      const [f] = await t`
        insert into uriday.families (baby_name, birth_date, invite_hash, invite_at, updated_at)
        values (${fam.name ?? ''}, ${fam.birth}, ${ih}, now(), ${fam.updatedAt})
        returning id`;
      const fid = f.id;
      await upsertMembers(t, fid, list, { adminId: meId });
      await t`insert into uriday.devices (token_hash, family_id, member_id) values (${th}, ${fid}, ${meId})`;
      await upsertEvents(t, fid, rows);
      return {
        ok: true,
        token,
        invite,
        familyId: fid,
        me: { memberId: meId, isAdmin: true },
        family: await loadFamily(t, fid),
        members: await loadMembers(t, fid),
        rev: 0, // 첫 sync 에서 자기 기록까지 rev 를 받아 가도록 0 부터
        rejected,
      };
    });
  }

  // ── peek ───────────────────────────────────────────────────────────────
  // 초대코드: 가족 이름 + 구성원(차지 가능 여부 claimed) / 기기 연결 코드: 가족 이름 + 연결될 그 사람 (코드는 쓰지 않음)
  async function actPeek(body, req) {
    await rateLimit('peek', req);
    const { kind, code } = pickCode(body);
    if (kind === 'device') {
      const link = code && (await findDeviceLink(sql, await sha256hex(code)));
      if (!link) throw new HttpError(404, 'invite_invalid', MSG.device_invalid);
      const [m] = await sql`
        select m.id, m.name, m.role, m.emoji, f.baby_name
        from uriday.members m join uriday.families f on f.id = m.family_id
        where m.family_id = ${link.family_id} and m.id = ${link.member_id}`;
      return { ok: true, family: { name: m.baby_name }, member: { id: m.id, name: m.name, role: m.role, emoji: m.emoji } };
    }
    if (!code) throw new HttpError(404, 'invite_invalid');
    const ih = await sha256hex(code);
    const [f] = await sql`select id, baby_name from uriday.families where invite_hash = ${ih}`;
    if (!f) throw new HttpError(404, 'invite_invalid');
    const members = (await loadMembers(sql, f.id))
      .filter((m) => !m.revoked)
      .map(({ id, name, role, emoji, claimed }) => ({ id, name, role, emoji, claimed }));
    return { ok: true, family: { name: f.baby_name }, members };
  }

  // 아직 유효한(안 썼고 안 만료됐고 그 사람이 내보내지지 않은) 기기 연결 코드. lock=true 면 코드 행을 잠근다.
  async function findDeviceLink(t, hash, { lock = false } = {}) {
    const nowMs = now();
    const rows = lock
      ? await t`
          select l.family_id, l.member_id from uriday.device_links l
          join uriday.members m on m.family_id = l.family_id and m.id = l.member_id
          where l.code_hash = ${hash} and l.used_at is null and l.expires_at > ${nowMs} and m.revoked_at is null
          for update of l`
      : await t`
          select l.family_id, l.member_id from uriday.device_links l
          join uriday.members m on m.family_id = l.family_id and m.id = l.member_id
          where l.code_hash = ${hash} and l.used_at is null and l.expires_at > ${nowMs} and m.revoked_at is null`;
    return rows[0] || null;
  }

  // 새 기기 토큰 발급 + join 응답 (초대·기기 연결 공통)
  async function issueDevice(t, fid, memberId) {
    const token = randomToken();
    await t`insert into uriday.devices (token_hash, family_id, member_id) values (${await sha256hex(token)}, ${fid}, ${memberId})`;
    const members = await loadMembers(t, fid);
    const me = members.find((x) => x.id === memberId);
    return {
      ok: true,
      token,
      familyId: fid,
      me: { memberId, isAdmin: !!me?.isAdmin },
      family: await loadFamily(t, fid),
      members,
      rev: 0,
    };
  }

  // ── join ───────────────────────────────────────────────────────────────
  // ① 초대코드 + claim: 기기가 하나도 없는 자리(자리표시 구성원)만 차지할 수 있다 — 이미 쓰는 사람이면 403.
  // ② 초대코드 + me: 새 구성원으로 참여.
  // ③ device(기기 연결 코드): 그 코드를 만든 사람으로 이 기기를 연결 (1회용·15분).
  async function actJoin(body, req) {
    await rateLimit('join', req);
    const { kind, code } = pickCode(body);
    if (kind === 'device') return joinByDeviceLink(code);
    if (!code) throw new HttpError(404, 'invite_invalid');
    const claim = body.claim == null || body.claim === '' ? null : uuidOf(body.claim);
    if (body.claim != null && body.claim !== '' && !claim) throw bad('claim 은 구성원 id(uuid)여야 해요');
    let meIn = null;
    if (!claim) {
      if (!isObj(body.me)) throw bad('참여할 사람(claim 또는 me)을 골라 주세요');
      meIn = cleanMember({ ...body.me, id: body.me.id ?? crypto.randomUUID() });
      if (!meIn) throw bad('me.id 는 uuid 여야 해요');
    }
    const ih = await sha256hex(code);

    return tx(async (t) => {
      const [f] = await t`select id from uriday.families where invite_hash = ${ih} for update`;
      if (!f) throw new HttpError(404, 'invite_invalid');
      const fid = f.id;
      const memberId = claim || meIn.id;
      const [m] = await t`
        select m.id, m.revoked_at,
               exists (select 1 from uriday.devices d
                       where d.family_id = m.family_id and d.member_id = m.id and d.revoked_at is null) as active
        from uriday.members m where m.family_id = ${fid} and m.id = ${memberId}`;
      if (claim && !m) throw bad('고른 사람을 이 가족에서 찾을 수 없어요');
      if (m?.revoked_at) throw new HttpError(403, 'forbidden', '이 사람은 가족 공유에서 빠졌어요. 새 사람으로 참여하거나 관리자에게 물어봐 주세요');
      // 이미 기기가 있는 사람은 초대 링크로 차지할 수 없다 (me.id 로 같은 id 를 보내도 마찬가지)
      if (m?.active) throw new HttpError(403, 'forbidden', MSG.claimed);
      if (!m) {
        const skipped = await upsertMembers(t, fid, [meIn]);
        if (skipped.length) throw bad(`가족 구성원은 ${LIMITS.membersPerFamily}명까지예요`);
      }
      return issueDevice(t, fid, memberId);
    });
  }

  async function joinByDeviceLink(code) {
    const invalid = () => new HttpError(404, 'invite_invalid', MSG.device_invalid);
    if (!code) throw invalid();
    const hash = await sha256hex(code);
    return tx(async (t) => {
      const [l0] = await t`select family_id from uriday.device_links where code_hash = ${hash}`;
      if (!l0) throw invalid();
      await t`select 1 from uriday.families where id = ${l0.family_id} for update`;
      const link = await findDeviceLink(t, hash, { lock: true }); // 잠근 뒤 다시 확인 → 동시에 두 번 써도 한 번만
      if (!link) throw invalid();
      await t`update uriday.device_links set used_at = now() where code_hash = ${hash}`;
      return issueDevice(t, link.family_id, link.member_id);
    });
  }

  // ── sync ───────────────────────────────────────────────────────────────
  async function actSync(body) {
    const k = tokenOf(body.k);
    if (!k) throw new HttpError(401, 'unauthorized');
    let since = 0;
    if (body.since != null && body.since !== '') {
      const n = numOf(body.since);
      if (n == null || n < 0 || !Number.isSafeInteger(Math.round(n))) throw bad('since 는 0 이상의 정수여야 해요');
      since = Math.round(n);
    }
    const push = arrayOf(body.push, LIMITS.push, '기록(push)', { status: 413 });
    const mp = arrayOf(body.members, LIMITS.membersPerRequest, '구성원(members)');
    const fp = body.family != null ? cleanFamily(body.family, null) : null;
    const members = dedupeMembers(mp.map(cleanMember).filter(Boolean));
    const rejectedMembers = mp.filter((x) => !cleanMember(x)).map((x) => (isObj(x) && typeof x.id === 'string' ? x.id.slice(0, 64) : null)).filter(Boolean);
    const writes = push.length > 0 || members.length > 0 || !!fp;
    const hash = await sha256hex(k);
    const nowMs = now();

    return tx(async (t) => {
      const me = await authDevice(t, hash, writes);
      const fid = me.family_id;

      // 커서 점검: 이 가족의 최대 rev 보다 큰 since 는 잘못된 커서 → 처음부터 다시 (LWW 병합이라 안전)
      let cursor = since;
      let reset = false;
      if (since > 0) {
        const [mx] = await t`select coalesce(max(rev), 0) as m from uriday.events where family_id = ${fid}`;
        if (since > Number(mx.m)) {
          cursor = 0;
          reset = true;
        }
      }

      if (fp) {
        await t`
          update uriday.families set
            baby_name = coalesce(${fp.name}, baby_name),
            birth_date = case when ${fp.birthSet} then ${fp.birth}::date else birth_date end,
            updated_at = ${fp.updatedAt}
          where id = ${fid} and updated_at < ${fp.updatedAt}`;
      }
      if (members.length) rejectedMembers.push(...(await upsertMembers(t, fid, members)));

      let rejected = [];
      let lost = [];
      if (push.length) {
        const prepared = prepareEvents(push, await memberIdSet(t, fid));
        rejected = prepared.rejected;
        const applied = await upsertEvents(t, fid, prepared.rows);
        // LWW 로 밀린(서버가 더 최신인) 기록: 커서 뒤라 pull 에 안 나오면 서버본을 같이 돌려준다
        const skipped = prepared.rows.filter((r) => !applied.has(r.id)).map((r) => r.id);
        if (skipped.length) {
          lost = await t`
            select ${sql(EV_COLS)} from uriday.events
            where family_id = ${fid} and id = any(${skipped}::uuid[]) and rev <= ${cursor}`;
        }
      }

      const pulled = await t`
        select ${sql(EV_COLS)} from uriday.events
        where family_id = ${fid} and rev > ${cursor}
        order by rev limit ${LIMITS.page + 1}`;
      const more = pulled.length > LIMITS.page;
      const page = (more ? pulled.slice(0, LIMITS.page) : pulled).map(evOut);
      const rev = page.length ? page[page.length - 1].rev : cursor;
      await touch(t, hash);
      const out = {
        ok: true,
        events: page.concat(lost.map(evOut)),
        more,
        rev,
        members: await loadMembers(t, fid),
        family: await loadFamily(t, fid),
        me: { memberId: me.member_id, isAdmin: me.is_admin },
        serverTime: nowMs,
        rejected,
      };
      if (rejectedMembers.length) out.rejectedMembers = rejectedMembers;
      if (reset) out.reset = true;
      return out;
    });
  }

  // ── 관리 동작 (invite / remove / admin / leave) ────────────────────────
  async function withMe(body, fn) {
    const k = tokenOf(body.k);
    if (!k) throw new HttpError(401, 'unauthorized');
    const hash = await sha256hex(k);
    return tx(async (t) => {
      const me = await authDevice(t, hash, true);
      await touch(t, hash);
      return fn(t, me, hash);
    });
  }
  const needAdmin = (me) => {
    if (!me.is_admin) throw new HttpError(403, 'forbidden');
  };

  const actInvite = (body) =>
    withMe(body, async (t, me) => {
      needAdmin(me);
      const invite = randomInvite();
      await t`update uriday.families set invite_hash = ${await sha256hex(invite)}, invite_at = now() where id = ${me.family_id}`;
      return { ok: true, invite };
    });

  const actRemove = (body) =>
    withMe(body, async (t, me) => {
      needAdmin(me);
      const target = uuidOf(body.memberId);
      if (!target) throw bad('memberId 가 필요해요');
      if (target === me.member_id) throw new HttpError(403, 'forbidden', "나 자신은 내보낼 수 없어요 ('이 기기 공유 끊기'를 써 주세요)");
      const [m] = await t`
        update uriday.members set revoked_at = coalesce(revoked_at, now()), is_admin = false
        where family_id = ${me.family_id} and id = ${target} returning id`;
      if (!m) throw bad('이 가족의 구성원이 아니에요');
      await t`
        update uriday.devices set revoked_at = coalesce(revoked_at, now())
        where family_id = ${me.family_id} and member_id = ${target}`;
      await t`delete from uriday.device_links where family_id = ${me.family_id} and member_id = ${target}`;
      return { ok: true, members: await loadMembers(t, me.family_id) };
    });

  // 기기 연결 끊기(관리자): 그 사람을 내보내지 않고 기기만 모두 끊는다 → 다시 초대 링크로 차지할 수 있는 자리가 된다.
  //   (폰을 잃어버렸을 때 복구용. 기록의 by 는 그대로 유지. 내 기기는 '이 기기 공유 끊기(leave)'로.)
  const actUnlink = (body) =>
    withMe(body, async (t, me) => {
      needAdmin(me);
      const target = uuidOf(body.memberId);
      if (!target) throw bad('memberId 가 필요해요');
      if (target === me.member_id) throw new HttpError(403, 'forbidden', '내 기기 연결은 설정 > 이 기기 공유 끊기로 해 주세요');
      const [m] = await t`select id from uriday.members where family_id = ${me.family_id} and id = ${target}`;
      if (!m) throw bad('이 가족의 구성원이 아니에요');
      await t`
        update uriday.devices set revoked_at = now()
        where family_id = ${me.family_id} and member_id = ${target} and revoked_at is null`;
      await t`delete from uriday.device_links where family_id = ${me.family_id} and member_id = ${target}`;
      return { ok: true, members: await loadMembers(t, me.family_id) };
    });

  const actAdmin = (body) =>
    withMe(body, async (t, me) => {
      needAdmin(me);
      const target = uuidOf(body.memberId);
      if (!target) throw bad('memberId 가 필요해요');
      const on = body.on === true || body.on === 'true' || body.on === 1;
      const [m] = await t`select revoked_at from uriday.members where family_id = ${me.family_id} and id = ${target}`;
      if (!m) throw bad('이 가족의 구성원이 아니에요');
      if (on && m.revoked_at) throw bad('가족 공유에서 빠진 사람은 관리자가 될 수 없어요');
      if (!on) {
        const [c] = await t`
          select count(*)::int as n from uriday.members
          where family_id = ${me.family_id} and is_admin and revoked_at is null and id <> ${target}`;
        if (c.n === 0) throw bad('관리자가 한 명은 있어야 해요');
      }
      await t`update uriday.members set is_admin = ${on} where family_id = ${me.family_id} and id = ${target}`;
      return { ok: true, members: await loadMembers(t, me.family_id) };
    });

  // 내 다른 기기 연결: 이 기기의 구성원으로 새 기기를 붙일 1회용 코드 (15분). 새로 만들면 이전 코드는 지워진다.
  const actDevlink = (body) =>
    withMe(body, async (t, me) => {
      const nowMs = now();
      const code = randomInvite();
      const expiresAt = nowMs + LIMITS.deviceLinkMs;
      // 이 사람의 이전 코드(안 쓴 것 포함)와, 이 가족의 하루 넘게 지난 코드를 지운다 (가족 범위 안에서만 → 잠금 충돌 없음)
      await t`
        delete from uriday.device_links
        where family_id = ${me.family_id} and (member_id = ${me.member_id} or expires_at < ${nowMs - DAY})`;
      await t`
        insert into uriday.device_links (code_hash, family_id, member_id, expires_at)
        values (${await sha256hex(code)}, ${me.family_id}, ${me.member_id}, ${expiresAt})`;
      return { ok: true, code, expiresAt };
    });

  const actLeave = (body) =>
    withMe(body, async (t, me, hash) => {
      await t`update uriday.devices set revoked_at = now() where token_hash = ${hash}`;
      return { ok: true };
    });

  // ── quick (단축어·알림) ─────────────────────────────────────────────────
  // 응답 1줄째 = 알림 미리보기에 보이는 짧은 확인 ("✓ 소변 기록 · 오후 3:12 · 아빠"), 2줄째 = 오늘 몇 번째.
  // 구성원별 횟수는 절대 싣지 않는다 (가족 전체 횟수만).
  function describe(type, data) {
    const L = TYPES[type].label;
    switch (type) {
      case 'formula':
      case 'pumped':
      case 'milk':
        return `${L} ${data.ml}ml${data.burp === 'yes' ? ' · 트림 ✓' : ''}`;
      case 'breast':
        return `${L} ${SIDE_LABEL[data.side] || ''}${data.min ? ` ${data.min}분` : ''}`;
      case 'poop': {
        const d = [COLOR_LABEL[data.color], TEXTURE_LABEL[data.texture]].filter(Boolean).join('·');
        return d ? `${L}(${d})` : L;
      }
      case 'temp':
        return `${L} ${data.c.toFixed(1)}℃`;
      case 'tummy':
        return data.min ? `${L} ${data.min}분` : L;
      case 'water':
        return data.ml ? `${L} ${data.ml}ml` : L;
      case 'med':
        return data.name ? `${L}(${data.name})` : L;
      case 'potty':
        return `${L} ${{ pee: '쉬 성공', poop: '응가 성공', try: '시도', accident: '실수' }[data.result]}`;
      default:
        return L;
    }
  }

  async function countLine(t, fid, types, at, nowMs) {
    const from = seoulDayStart(at);
    const rows = await t`
      select type, data from uriday.events
      where family_id = ${fid} and not deleted and ts >= ${from} and ts <= ${at}`;
    const day = dayLabel(at, nowMs);
    const count = (pred) => rows.filter(pred).length;
    const parts = [];
    for (const type of types) {
      if (TYPES[type].feed) {
        const n = count((r) => FEED_TYPES.includes(r.type));
        const ml = rows.filter((r) => FEED_TYPES.includes(r.type)).reduce((s, r) => s + (Number(r.data?.ml) || 0), 0);
        parts.push(`수유 ${n}번째${ml ? ` · 총 ${ml}ml` : ''}`);
      } else if (type === 'burp') {
        parts.push(`트림 ${count((r) => r.type === 'burp' || (BURP_FEEDS.includes(r.type) && r.data?.burp === 'yes'))}번째`);
      } else {
        parts.push(`${TYPES[type].label} ${count((r) => r.type === type)}번째`);
      }
    }
    return `${day} ${parts.join(' · ')}`;
  }

  function quickPlan(p) {
    const t = (p.t || '').trim().toLowerCase();
    const sayText = p.say ?? p.text ?? '';
    if (t === 'say' || (!t && sayText.trim())) {
      const r = parseSay(sayText);
      if (!r) {
        const echo = cleanStr(sayText, 40) || '(빈 말)';
        throw new HttpError(400, 'bad_request', `알아듣지 못했어요: ${echo}\n예) 분유 120 · 쉬했어 · 응가 노란색 · 잠들었어 · 깼어 · 모유 왼쪽 10분`);
      }
      const base = { src: 'say', agoMin: r.agoMin };
      if (r.action === 'sleep_end') return { ...base, kind: 'sleep_end' };
      if (r.type === 'sleep') return { ...base, kind: 'sleep_start' };
      if (r.type === 'burp') return { ...base, kind: 'burp' };
      if (r.type === 'both') return { ...base, kind: 'both', data: r.data };
      return { ...base, kind: 'one', type: r.type, data: r.data };
    }
    if (!t) throw bad('기록 종류(t)가 필요해요. 예) t=pee');
    if (t === 'sleep') return { kind: 'sleep_toggle' };
    if (t === 'burp') return { kind: 'burp' };
    if (t === 'both') return { kind: 'both', data: poopParams(p) };
    if (!Object.hasOwn(TYPES, t) || TYPES[t].noQuick) throw bad(`모르는 기록 종류예요: ${cleanStr(t, 16)}`);
    const data = {};
    if (TYPES[t].ml || t === 'water') {
      if (p.ml != null && p.ml !== '') data.ml = p.ml;
    }
    if (t === 'breast') {
      const s = (p.side || '').trim().toLowerCase();
      data.side = /^(l|left|왼|좌)/.test(s) ? 'L' : /^(r|right|오|우)/.test(s) ? 'R' : 'both';
    }
    if ((t === 'breast' || t === 'tummy') && p.min) data.min = p.min;
    if (t === 'tummy' && !data.min) data.min = 5; // 앱 퀵버튼과 같은 기본 5분
    if (t === 'poop') Object.assign(data, poopParams(p));
    if (t === 'temp') data.c = p.c ?? p.temp;
    if (t === 'med') Object.assign(data, { name: p.name, note: p.note });
    if (t === 'potty') data.result = p.result;
    if (t === 'note') data.text = p.text ?? p.say;
    if (['solid', 'meal', 'snack'].includes(t)) Object.assign(data, { food: p.food, amount: p.amount, reaction: p.reaction });
    return { kind: 'one', type: t, data };
  }
  function poopParams(p) {
    const out = {};
    const c = (p.color || '').trim().toLowerCase();
    if (c === 'white' || c === 'gray' || c === 'grey') out.color = 'pale';
    else if (/^[a-z_]{2,16}$/.test(c)) out.color = c;
    else if (c) {
      const r = parseSay(`응가 ${c}`);
      if (r?.data?.color) out.color = r.data.color;
    }
    const x = (p.texture || '').trim().toLowerCase();
    if (TEXTURES.has(x)) out.texture = x;
    return out;
  }
  const QUICK_HINT = {
    formula: '분유 양은 1~500ml 로 보내 주세요 (예: ml=120)',
    pumped: '유축 양은 1~500ml 로 보내 주세요 (예: ml=120)',
    milk: '우유 양은 1~500ml 로 보내 주세요 (예: ml=200)',
    temp: '체온은 34.0~42.5℃ 로 보내 주세요 (예: c=37.5)',
    potty: 'result 는 pee / poop / try / accident 중 하나예요',
    note: '메모 내용(text)이 비었어요',
  };

  async function actQuick(p) {
    const k = tokenOf(p.k);
    if (!k) throw new HttpError(401, 'unauthorized', QUICK_401);
    const plan = quickPlan(p); // 토큰 확인 전에 말 해석 (DB 안 씀)
    const hash = await sha256hex(k);
    const nowMs = now();
    let at = nowMs;
    const tsParam = epochOf(p.ts);
    if (tsParam != null && tsParam <= nowMs + 5 * MIN && tsParam >= nowMs - 7 * DAY) at = tsParam;
    else if (plan.agoMin != null) at = nowMs - Math.min(plan.agoMin, 12 * 60) * MIN;
    const src = plan.src || (p.src === 'notif' ? 'notif' : 'shortcut');
    const reqId = uuidOf(p.id);

    return tx(async (t) => {
      let me;
      try {
        me = await authDevice(t, hash, true);
      } catch (e) {
        if (e instanceof HttpError && e.status === 401) throw new HttpError(401, 'unauthorized', QUICK_401);
        throw e;
      }
      await touch(t, hash);
      const fid = me.family_id;
      const who = me.name || ROLE_LABEL[me.role] || '';
      const line1 = (what, ts = at) => `✓ ${what} · ${fmtTime(ts)} · ${who}`;

      if (reqId) {
        const [dup] = await t`select type, ts from uriday.events where family_id = ${fid} and id = ${reqId}`;
        if (dup) return text(`✓ 이미 기록돼 있어요 · ${fmtTime(Number(dup.ts))}`);
      }
      const insert = async (type, data, id = crypto.randomUUID()) => {
        const clean = cleanData(type, { ...data, src }, false);
        if (!clean) throw new HttpError(400, 'bad_request', QUICK_HINT[type] || MSG.bad_request);
        await t`
          insert into uriday.events (family_id, id, member_id, type, ts, data, deleted, updated_at, rev)
          values (${fid}, ${id}, ${me.member_id}, ${type}, ${at}, ${sql.json(clean)}, false, ${nowMs}, nextval('uriday.rev_seq'))`;
        return clean;
      };
      const bump = (id, patch) => t`
        update uriday.events
        set data = data || ${sql.json(patch)}, updated_at = greatest(${nowMs}::bigint, updated_at + 1), rev = nextval('uriday.rev_seq')
        where family_id = ${fid} and id = ${id}`;
      const ongoingSleep = async () => {
        const [s] = await t`
          select id, ts from uriday.events
          where family_id = ${fid} and type = 'sleep' and not deleted and not (data ? 'end')
            and ts > ${at - DAY} and ts <= ${at + 5 * MIN}
          order by ts desc, rev desc limit 1`;
        return s ? { id: s.id, ts: Number(s.ts) } : null;
      };

      // 잠: 토글 / 시작 / 끝
      if (plan.kind === 'sleep_toggle' || plan.kind === 'sleep_start' || plan.kind === 'sleep_end') {
        const s = await ongoingSleep();
        if (s && plan.kind !== 'sleep_start') {
          const end = Math.max(at, s.ts);
          await bump(s.id, { end });
          const dur = fmtDur((end - s.ts) / MIN);
          return text(`${line1(`잠 끝 (${dur})`, end)}\n😴 ${dur} 잤어요`);
        }
        if (s) return text(`✓ 이미 재우는 중 · ${fmtTime(s.ts)}부터 (${fmtDur((at - s.ts) / MIN)}째)`, 409);
        if (plan.kind === 'sleep_end') return text('진행 중인 잠 기록이 없어요 · 앱에서 잠든 시간을 넣어 주세요', 409);
        await insert('sleep', {}, reqId || undefined);
        return text(`${line1('잠 시작')}\n😴 깨면 한 번 더 기록하면 끝나요`);
      }

      // 트림: 90분 안의 마지막 수유에 트림 값이 없으면 거기에 ✓, 아니면 따로 기록
      if (plan.kind === 'burp') {
        const [f] = await t`
          select id, type, ts, data from uriday.events
          where family_id = ${fid} and type in ('formula', 'breast', 'pumped') and not deleted
            and ts >= ${at - 90 * MIN} and ts <= ${at + 5 * MIN}
          order by ts desc, rev desc limit 1`;
        if (f && !(f.data && Object.hasOwn(f.data, 'burp'))) {
          await bump(f.id, { burp: 'yes' });
          const cl = await countLine(t, fid, ['burp'], at, nowMs);
          return text(`${line1('트림 기록')}\n${cl} · ${fmtTime(Number(f.ts))} ${TYPES[f.type].label}에 표시`);
        }
        await insert('burp', {}, reqId || undefined);
        return text(`${line1('트림 기록')}\n${await countLine(t, fid, ['burp'], at, nowMs)}`);
      }

      if (plan.kind === 'both') {
        await insert('pee', {}, reqId || undefined);
        const pd = await insert('poop', plan.data || {});
        const warn = await poopWarn(t, fid, pd, at);
        return text(`${line1(`소변·${describe('poop', pd)} 기록`)}\n${await countLine(t, fid, ['pee', 'poop'], at, nowMs)}${warn}`);
      }

      // 한 건 기록
      const { type } = plan;
      const data = { ...plan.data };
      if (TYPES[type].ml && (data.ml == null || data.ml === '')) {
        const [last] = await t`
          select (data->>'ml')::numeric as ml from uriday.events
          where family_id = ${fid} and type = ${type} and not deleted and jsonb_typeof(data->'ml') = 'number'
          order by ts desc, rev desc limit 1`;
        data.ml = last ? Number(last.ml) : ML_DEFAULT;
      }
      const clean = await insert(type, data, reqId || undefined);
      let extra = '';
      if (type === 'temp' && clean.c >= 38) {
        const [f] = await t`select to_char(birth_date, 'YYYY-MM-DD') as birth from uriday.families where id = ${fid}`;
        const age = ageDays(f?.birth, at);
        extra = age != null && age < 91
          ? '\n⚠️ 3개월 미만 아기의 38℃ 이상 발열은 바로 병원 진료가 필요해요'
          : '\n🌡️ 열이 있어요. 아기 상태를 잘 살펴 주세요';
      }
      if (type === 'poop') extra = await poopWarn(t, fid, clean, at);
      return text(`${line1(`${describe(type, clean)} 기록`)}\n${await countLine(t, fid, [type], at, nowMs)}${extra}`);
    });
  }
  async function poopWarn(t, fid, data, at) {
    if (data.color === 'pale') return '\n⚠️ 흰색·회색 변은 바로 소아과 진료가 필요할 수 있어요';
    if (data.color === 'red') return '\n⚠️ 빨간 변은 소아과 상담이 필요해요';
    if (data.color === 'black') {
      const [f] = await t`select to_char(birth_date, 'YYYY-MM-DD') as birth from uriday.families where id = ${fid}`;
      const age = ageDays(f?.birth, at);
      if (age == null || age > 3) return '\n⚠️ 검은 변(태변 시기 이후)은 소아과 상담이 필요해요';
    }
    return '';
  }

  const ACTIONS = {
    create: actCreate, peek: actPeek, join: actJoin, sync: actSync, invite: actInvite,
    remove: actRemove, unlink: actUnlink, admin: actAdmin, leave: actLeave, devlink: actDevlink,
  };

  // ── 진입점 ─────────────────────────────────────────────────────────────
  return async function handle(req) {
    let quick = false;
    let action = '';
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS });
      const url = new URL(req.url);
      quick = url.searchParams.get('a') === 'q';
      if (req.method === 'GET' || req.method === 'HEAD') {
        return text(GET_HINT, 405, { Allow: 'POST, OPTIONS' });
      }
      if (req.method !== 'POST') throw new HttpError(405, 'bad_request', 'POST 로 보내 주세요', { Allow: 'POST, OPTIONS' });
      const bytes = await readBody(req);

      if (quick) {
        action = 'q';
        const p = await lenientParams(bytes, req.headers.get('content-type'));
        for (const [k, v] of url.searchParams) if (v !== '') p[k] = v; // 쿼리가 우선
        if (!p.k && req.headers.get('x-bl-key')) p.k = req.headers.get('x-bl-key');
        return await actQuick(p);
      }

      let body;
      try {
        body = JSON.parse(decode(bytes));
      } catch {
        throw bad('JSON 형식이 올바르지 않아요');
      }
      if (!isObj(body)) throw bad();
      action = typeof body.a === 'string' ? body.a : '';
      if (action === 'q') {
        quick = true;
        const p = {};
        for (const [k, v] of Object.entries(body)) if (['string', 'number', 'boolean'].includes(typeof v)) p[k] = String(v);
        for (const [k, v] of url.searchParams) if (v !== '') p[k] = v;
        return await actQuick(p);
      }
      const fn = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
      if (!fn) throw bad(`모르는 요청이에요: ${cleanStr(action, 16) || '(a 없음)'}`);
      return json(await fn(body, req));
    } catch (e) {
      if (e instanceof HttpError) {
        if (quick) return text(e.message, e.status, e.headers);
        return json({ ok: false, error: e.code, message: e.message }, e.status, e.headers);
      }
      // 토큰·본문·URL 은 남기지 않는다 — 동작 이름과 DB 오류 코드/메시지만
      console.error(`[uriday-log] ${action || '-'} 실패:`, e?.code || '', e?.message || String(e));
      if (quick) return text(MSG.server, 500);
      return json({ ok: false, error: 'server', message: MSG.server }, 500);
    }
  };
}
