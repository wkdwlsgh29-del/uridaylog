// ============================================================
// '함께 육아일지' 가족 공유 — API 클라이언트 · 병합 · 서비스워커 연결 · 초대 링크
// 서버 계약: SPEC §6.3 (Edge Function uriday-log, POST JSON { a, ... }).
//
// 데이터를 잃지 않는 규칙
//   · dirty(아직 서버 확인 안 된) 기록은 서버 사본의 updatedAt 이 로컬 이상일 때만 dirty 를 푼다.
//     (보낸 뒤 응답이 끊겨도 다음 동기화의 pull 에서 확인되면 풀린다 — 재전송은 서버에서 멱등)
//   · 서버가 거부한 기록(rejected)은 이 기기에 그대로 두고 rejected 표시 (무한 재전송 방지). 고치면 다시 보냄.
//   · 401 = 이 기기 연결이 끊김 → sync.revoked=true, 자동 동기화 중지. 기록은 기기에 그대로.
//   · 동기화 도중 사용자가 기록을 고쳐도 LWW 로 로컬이 이긴다 (updatedAt 은 store.bump 로 단조 증가).
//
// 서비스워커(sw.js) 연결 — Cache Storage `SW_DATA_CACHE`('uriday-bl-data')
//   · ./__bl/config  : writeSwConfig 가 쓰는 JSON { v, endpoint, token, meId, meName, meEmoji, quickActions, lastMl, babyName }
//   · ./__bl/inbox/<id> : 서비스워커가 (오프라인·서버 없음으로) 바로 못 보낸 알림 버튼 기록을 한 건씩 넣는 곳.
//       본문 = 기록 JSON { id(uuid), type, ts, by?, data? }. 'both' 는 두 건(pee, poop)으로 넣는다.
//       drainInbox 가 가져와 저장한 뒤에만 지운다 (한 건씩 키가 달라서 읽기-쓰기 경합이 없다).
//       서버로 바로 보내는 데 성공했으면 수신함에 넣지 않는다 (중복 방지).
//     (SPEC 의 단일 배열 ./__bl/inbox 도 읽어서 가져온다 — 호환용)
//   · 알림 버튼 → 서비스워커는 먼저 id(uuid)를 만들고 quick 주소에 `&src=notif&id=<uuid>&ts=<ms>` 를 붙여 POST.
//     실패하면 같은 id 로 수신함에 넣는다 → 사실은 서버에 들어갔더라도 서버가 id 로 중복을 막는다.
//   ⚠ sw.js 의 activate 에서 옛 캐시를 지울 때 SW_DATA_CACHE 는 남겨 둘 것.
//
// 여러 기기(같은 사람): 이미 기기가 있는 구성원은 초대 링크로 '차지'할 수 없다(서버 403).
//   그 사람의 기존 기기에서 createDeviceLink → `#dev=CODE` 링크(1회용·15분)를 새 기기에서 열거나 붙여 넣어 joinFamily.
// ============================================================

import { BRAND } from '../shared/js/brand.js';
import { uuid, isUuid, cleanData } from './logic.js';
import { EVENT_TYPES, ROLE_BY_ID } from './log-data.js';
import { save, dirtyMembers, familyDirty, defaultSync, bump } from './store.js';

/** 서비스워커와 공유하는 데이터 캐시 이름 (sw.js 가 지우지 않게 이 이름을 import 해서 제외) */
export const SW_DATA_CACHE = 'uriday-bl-data';
/** 서비스워커 설정 항목 경로 (페이지 기준 상대 경로) */
export const SW_CONFIG_PATH = './__bl/config';
/** 서비스워커 수신함 경로 — 한 건씩 `${SW_INBOX_PATH}/<id>` */
export const SW_INBOX_PATH = './__bl/inbox';
/** 개발용 엔드포인트 덮어쓰기 localStorage 키 (localhost·127.0.0.1 에서만 유효) */
export const DEV_ENDPOINT_KEY = 'bl:devEndpoint';
/** 요청 제한 시간 (ms) */
export const TIMEOUT_MS = 15000;
/** 공유 초대 링크 기본 주소 (location 이 없을 때) */
export const PUBLIC_URL = 'https://wkdwlsgh29-del.github.io/uridaylog/baby-log/';

const PUSH_MAX_BYTES = 150000;   // 한 요청에 싣는 기록 JSON 크기 (서버 본문 한도 256KB)
const PUSH_MAX_COUNT = 400;
const KEEPALIVE_MAX_BYTES = 50000;   // fetch keepalive 본문 한도(64KB) 안쪽
const MAX_ROUNDS = 40;           // 한 번의 syncNow 안에서 push/pull 반복 상한
const BACKOFF_BASE = 5000;
const BACKOFF_MAX = 5 * 60000;

/** 오류 코드별 한국어 안내 (서버 message 가 없을 때) */
export const ERROR_COPY = {
  network: '인터넷 연결이 불안정해요. 기록은 이 기기에 안전하게 남아 있어요',
  timeout: '서버 응답이 늦어요. 잠시 후 다시 시도할게요',
  unauthorized: '이 기기의 가족 연결이 끊겼어요',
  invite_invalid: '초대 링크가 만료됐거나 잘못됐어요. 새 링크를 받아 주세요',
  forbidden: '관리자만 할 수 있어요',
  rate_limited: '요청이 많아요. 잠시 후 다시 시도해 주세요',
  too_large: '한 번에 보내는 기록이 너무 많아요',
  bad_request: '요청이 올바르지 않아요',
  server: '서버에 잠깐 문제가 생겼어요. 잠시 후 다시 시도할게요',
  bad_response: '서버 응답을 읽지 못했어요',
  no_endpoint: '가족 공유는 곧 열려요',
  not_shared: '가족 공유가 켜져 있지 않아요',
  already_shared: '이미 다른 가족과 공유 중이에요. 먼저 공유를 끊어 주세요',
};

/** API 오류 { status(0=네트워크), code, message } */
export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || ERROR_COPY[code] || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------- 엔드포인트 ----------
/**
 * API 주소: BRAND.logEndpoint. 개발 중에만(localhost·127.0.0.1) localStorage 'bl:devEndpoint' 로 덮어쓸 수 있다.
 * URL 파라미터로는 절대 바꿀 수 없다 (조작된 링크로 토큰을 빼가는 것 방지).
 */
export function endpoint() {
  try {
    const h = globalThis.location?.hostname;
    if (h === 'localhost' || h === '127.0.0.1') {
      const dev = globalThis.localStorage?.getItem(DEV_ENDPOINT_KEY);
      if (dev && /^https?:\/\/[^\s]+$/i.test(dev.trim())) return dev.trim();
    }
  } catch (e) { /* ignore */ }
  return (BRAND && typeof BRAND.logEndpoint === 'string' && BRAND.logEndpoint) || '';
}

/** 가족 공유를 켤 수 있는지 (서버 주소가 설정됨) */
export function canShare() {
  return !!endpoint();
}

function codeForStatus(status) {
  return { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'invite_invalid', 413: 'too_large', 429: 'rate_limited' }[status]
    || (status >= 500 ? 'server' : 'bad_response');
}

/**
 * POST JSON { a: action, ...body } → 응답 JSON (ok:true). 실패는 ApiError (네트워크·시간초과는 status 0).
 * opts: { timeoutMs, keepalive, fetch }
 */
export async function api(action, body = {}, opts = {}) {
  const url = endpoint();
  if (!url) throw new ApiError(0, 'no_endpoint');
  const f = opts.fetch || globalThis.fetch;
  if (typeof f !== 'function') throw new ApiError(0, 'network');
  const payload = JSON.stringify({ a: action, ...body });
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl?.abort(); }, opts.timeoutMs ?? TIMEOUT_MS);
  try {
    let res;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: ctrl?.signal,
        keepalive: !!opts.keepalive && payload.length < 60000,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch (e) {
      throw new ApiError(0, timedOut ? 'timeout' : 'network');
    }
    let json = null;
    try { json = await res.json(); } catch (e) {
      if (timedOut) throw new ApiError(0, 'timeout');
      json = null;
    }
    if (!res.ok || !isObj(json) || json.ok === false) {
      const code = (isObj(json) && typeof json.error === 'string' && json.error) || codeForStatus(res.status);
      throw new ApiError(res.status || 0, code, isObj(json) && typeof json.message === 'string' ? json.message : undefined);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 전송 형식 ----------
/** 기록 → 서버 전송 형식 (rev·dirty 등 로컬 필드 제외) */
export function toWireEvent(e) {
  return { id: e.id, type: e.type, ts: e.ts, by: e.by ?? null, data: e.data || {}, deleted: !!e.deleted, updatedAt: e.updatedAt };
}
/** 구성원 → 서버 전송 형식 (프로필 필드만 — isAdmin/claimed/revoked 는 서버 소유) */
export function toWireMember(m) {
  return { id: m.id, name: m.name, role: m.role, emoji: m.emoji, updatedAt: m.updatedAt };
}
function toWireFamily(f) {
  return { name: f.name || '', birth: f.birth || null, updatedAt: f.updatedAt || 0 };
}

// 서버 기록 → 로컬 모양 (snake_case 도 관대하게 받음). 잘못된 건 null
function fromServerEvent(s) {
  if (!isObj(s) || typeof s.id !== 'string' || !s.id || typeof s.type !== 'string' || s.ts == null || s.ts === '' || !isNum(Number(s.ts))) return null;
  const by = s.by ?? s.memberId ?? s.member_id ?? null;
  const updatedAt = Number(s.updatedAt ?? s.updated_at);
  return {
    id: s.id,
    type: s.type,
    ts: Number(s.ts),
    by: typeof by === 'string' && by ? by : null,
    data: isObj(s.data) ? s.data : {},
    deleted: !!s.deleted,
    updatedAt: isNum(updatedAt) ? updatedAt : Number(s.ts),
    rev: isNum(Number(s.rev)) ? Number(s.rev) : 0,
  };
}

function sameData(a, b) {
  try { return JSON.stringify(a || {}) === JSON.stringify(b || {}); } catch (e) { return false; }
}

// 크기·개수 한도 안에서 앞에서부터 잘라 한 묶음
function takeChunk(list, maxBytes = PUSH_MAX_BYTES) {
  const out = [];
  let bytes = 0;
  for (const e of list) {
    const w = toWireEvent(e);
    const n = JSON.stringify(w).length + 1;
    if (out.length && (bytes + n > maxBytes || out.length >= PUSH_MAX_COUNT)) break;
    out.push(e);
    bytes += n;
  }
  return out;
}

// ---------- 병합 ----------
/**
 * 서버 기록 병합 (LWW by updatedAt) → { changed, added, updated, confirmed }
 * · 로컬에 없으면 추가 · 로컬이 dirty 이고 더 새로우면 로컬 유지(rev 만 갱신)
 * · 서버 updatedAt ≥ 로컬 → 서버 것으로 바꾸고 dirty 해제 (보낸 기록의 '확인')
 */
export function mergeServer(state, serverEvents) {
  const res = { changed: false, added: 0, updated: 0, confirmed: 0 };
  if (!Array.isArray(serverEvents) || !serverEvents.length) return res;
  const idx = new Map(state.events.map((e, i) => [e.id, i]));
  for (const raw of serverEvents) {
    const s = fromServerEvent(raw);
    if (!s) continue;
    const i = idx.get(s.id);
    if (i === undefined) {
      state.events.push({ ...s, dirty: false });
      idx.set(s.id, state.events.length - 1);
      res.added++;
      continue;
    }
    const l = state.events[i];
    if (l.updatedAt > s.updatedAt) {
      // 로컬이 더 새로움 — 유지. (dirty 가 아닌데 더 새로우면 서버에 없는 변경이므로 다시 보내도록 dirty)
      if (s.rev > (l.rev || 0)) l.rev = s.rev;
      if (!l.dirty) l.dirty = true;
      continue;
    }
    const same = l.type === s.type && l.ts === s.ts && (l.by ?? null) === s.by && !!l.deleted === s.deleted
      && l.updatedAt === s.updatedAt && sameData(l.data, s.data);
    if (l.dirty) res.confirmed++;
    Object.assign(l, s, { dirty: false });
    delete l.rejected;
    if (!same) res.updated++;
  }
  res.changed = res.added + res.updated > 0;
  return res;
}

/**
 * 서버의 구성원·가족·나 정보 반영 → 바뀐 게 있으면 true
 * 구성원 프로필은 LWW(로컬 dirty 가 더 새로우면 유지), isAdmin/claimed/revoked 는 항상 서버 값.
 * meId 는 비었거나 없는 구성원일 때만 서버의 me 로 (이 기기에서 '나'를 바꿔 쓰는 경우를 존중).
 */
export function applyServerMeta(state, { members, family, me, familyId } = {}) {
  let changed = false;
  if (Array.isArray(members)) {
    for (const sm of members) {
      if (!isObj(sm) || typeof sm.id !== 'string') continue;
      const upd = isNum(Number(sm.updatedAt)) ? Number(sm.updatedAt) : 0;
      let l = state.members.find((m) => m.id === sm.id);
      if (!l) {
        l = { id: sm.id, name: '', role: 'other', emoji: '', updatedAt: -1, dirty: false };
        state.members.push(l);
        changed = true;
      }
      if (!(l.dirty && l.updatedAt > upd)) {
        const role = ROLE_BY_ID[sm.role] ? sm.role : 'other';
        const next = {
          name: typeof sm.name === 'string' && sm.name ? sm.name : ROLE_BY_ID[role].label,
          role,
          emoji: typeof sm.emoji === 'string' && sm.emoji ? sm.emoji : ROLE_BY_ID[role].emoji,
        };
        if (l.name !== next.name || l.role !== next.role || l.emoji !== next.emoji) changed = true;
        Object.assign(l, next, { updatedAt: upd, dirty: false });
      }
      for (const k of ['isAdmin', 'claimed', 'revoked']) {
        if (k in sm && !!sm[k] !== !!l[k]) { l[k] = !!sm[k]; changed = true; }
      }
    }
  }
  if (isObj(family)) {
    const f = state.family;
    const upd = isNum(Number(family.updatedAt)) ? Number(family.updatedAt) : 0;
    if (!(f.dirty && f.updatedAt > upd)) {
      const name = typeof family.name === 'string' ? family.name : f.name;
      const birth = typeof family.birth === 'string' && /^\d{4}-\d{2}-\d{2}/.test(family.birth) ? family.birth.slice(0, 10) : f.birth;
      if (name !== f.name || birth !== f.birth) changed = true;
      Object.assign(f, { name, birth, updatedAt: upd, dirty: false });
    }
    if (typeof family.id === 'string' && family.id && f.id !== family.id) { f.id = family.id; changed = true; }
  }
  if (typeof familyId === 'string' && familyId && state.family.id !== familyId) { state.family.id = familyId; changed = true; }
  if (isObj(me) && typeof me.memberId === 'string') {
    if (state.sync.memberId !== me.memberId) { state.sync.memberId = me.memberId; changed = true; }
    if ('isAdmin' in me && state.sync.isAdmin !== !!me.isAdmin) { state.sync.isAdmin = !!me.isAdmin; changed = true; }
    if (!state.meId || !state.members.some((m) => m.id === state.meId)) { state.meId = me.memberId; changed = true; }
  }
  return changed;
}

// ---------- 가족 만들기 · 참여 ----------
function assertNotShared(state) {
  if (state.sync?.token && !state.sync.revoked) throw new ApiError(0, 'already_shared');
}

function adoptSession(state, res, fallbackMemberId) {
  state.sync = {
    ...defaultSync(),
    token: res.token,
    familyId: res.familyId ?? res.family?.id ?? null,
    rev: 0,
    isAdmin: !!res.me?.isAdmin,
    invite: typeof res.invite === 'string' ? res.invite : null,
    memberId: res.me?.memberId ?? fallbackMemberId ?? null,
    revoked: false,
  };
  if (state.sync.familyId) state.family.id = state.sync.familyId;
}

async function afterJoin(state, now) {
  save(state, now);   // 토큰을 바로 저장 (앱이 닫혀도 연결이 남도록)
  await writeSwConfig(state).catch(() => false);
  try { await syncNow(state, now); } catch (e) { /* 자동 동기화가 이어서 처리 */ }
  save(state, now);
}

/**
 * 가족 공유 시작 — 가족·구성원(기존 id 그대로)·기록을 올리고 초대 코드를 받는다 → 서버 응답 { token, invite, familyId, me, … }
 * 기록이 많으면 첫 묶음만 create 에 싣고 나머지는 바로 이어지는 syncNow 가 나눠 보낸다.
 */
export async function createFamily(state, now = Date.now()) {
  assertNotShared(state);
  if (!state.meId || !state.members.some((m) => m.id === state.meId)) throw new ApiError(0, 'bad_request', '먼저 "나는 누구"를 골라 주세요');
  const alive = state.events.filter((e) => !e.deleted);
  const first = takeChunk(alive);
  const res = await api('create', {
    family: toWireFamily(state.family),
    members: state.members.map(toWireMember),
    meId: state.meId,
    events: first.map(toWireEvent),
  });
  if (typeof res.token !== 'string' || !res.token) throw new ApiError(0, 'bad_response');
  adoptSession(state, res, state.meId);
  // 새 가족에게 옛 툼스톤은 의미 없음. 살아 있는 기록은 dirty 로 두고 syncNow 의 pull 로 확인한다.
  for (const e of state.events) {
    if (e.deleted) e.dirty = false;
    else { e.dirty = true; e.rev = 0; }
  }
  applyServerMeta(state, res);
  await afterJoin(state, now);
  return res;
}

// 초대/기기 연결 코드 요청 본문. 링크 없이 코드만 붙여 넣었으면 초대로 먼저 시도하고, 404 면 기기 연결 코드로 한 번 더.
async function withJoinCode(text, fn) {
  const j = parseJoin(text) || { kind: 'invite', code: String(text || '').trim(), explicit: false };
  if (j.kind === 'device') return { kind: 'device', res: await fn({ device: j.code }) };
  try {
    return { kind: 'invite', res: await fn({ invite: j.code }) };
  } catch (e) {
    if (j.explicit || e.status !== 404) throw e;
    try {
      return { kind: 'device', res: await fn({ device: j.code }) };
    } catch (e2) {
      throw e;   // 둘 다 아니면 초대 링크 오류로 안내
    }
  }
}

/**
 * 초대(또는 기기 연결) 코드 미리보기 → { kind:'invite'|'device', family:{name}, members:[{id,name,role,emoji,claimed}], member? }
 * kind 'device' 는 그 코드를 만든 사람(member)으로만 연결된다 — members 에도 그 한 명.
 * claimed=true 인 사람은 초대 링크로 차지할 수 없음 (그 사람 기기에서 '내 다른 기기 연결' 코드를 받아야 함).
 */
export async function peekInvite(code) {
  const { kind, res } = await withJoinCode(code, (b) => api('peek', b));
  const members = Array.isArray(res.members) ? res.members : (isObj(res.member) ? [res.member] : []);
  return { kind, family: res.family || {}, members, member: isObj(res.member) ? res.member : null };
}

/**
 * 초대로 가족 참여 → 서버 응답. code = 초대 링크·코드, 또는 기기 연결 링크(#dev=, 그 사람으로 연결 — claim/me 무시).
 * 이미 기기가 있는 사람을 claim 하면 서버가 403(forbidden) — "그 사람 기기에서 '내 다른 기기 연결' 코드를 받아 주세요".
 * opts: { claim?: 기존 구성원 id("저는 이 사람이에요"), me?: {name, role, emoji} (새로 참여), merge?: 이 기기 기록을 합칠지 }
 * merge=true: 이 기기의 기록을 새 가족으로 올린다 — 내 기록(by=옛 meId)은 참여한 구성원으로 바꾸고,
 *   다른 사람 자리표시 구성원은 그 사람 기록이 있을 때만 함께 올린다. merge=false: 이 기기 기록을 버리고 가족 기록만 받는다.
 * 이미 다른 가족과 공유 중이면 ApiError('already_shared') — 먼저 leaveFamily.
 */
export async function joinFamily(state, code, { claim = null, me = null, merge = false } = {}, now = Date.now()) {
  assertNotShared(state);
  const oldMeId = state.meId;
  const prevFamilyId = state.sync?.familyId || null;
  const body = {};
  if (claim) body.claim = claim;
  else {
    const m = me || {};
    const role = ROLE_BY_ID[m.role] ? m.role : 'other';
    // 연결이 끊긴 기기(내보내진 사람일 수 있음)는 옛 구성원 id 를 다시 쓰지 않는다 — 서버가 403(빠진 사람)으로 막음.
    // 새 id 로 참여하고, merge 면 아래에서 내 옛 기록(by=옛 id)을 새 구성원으로 옮긴다.
    const reuse = merge && isUuid(oldMeId) && !state.sync?.revoked ? oldMeId : null;
    body.me = {
      id: reuse || (isUuid(m.id) ? m.id : uuid()),
      name: (typeof m.name === 'string' && m.name.trim()) || ROLE_BY_ID[role].label,
      role,
      emoji: (typeof m.emoji === 'string' && m.emoji) || ROLE_BY_ID[role].emoji,
    };
  }
  // 기기 연결 코드면 claim/me 없이 그 사람으로 연결된다
  const { res } = await withJoinCode(code, (b) => api('join', b.device ? b : { ...b, ...body }));
  if (typeof res.token !== 'string' || !res.token) throw new ApiError(0, 'bad_response');
  const newMe = res.me?.memberId || body.me?.id || claim;
  const sameFamily = prevFamilyId && (res.familyId === prevFamilyId || res.family?.id === prevFamilyId);

  if (merge || sameFamily) {
    for (const e of state.events) {
      if (oldMeId && e.by === oldMeId && newMe && oldMeId !== newMe) {
        e.by = newMe;
        e.updatedAt = bump(e.updatedAt, now);
        e.dirty = true;
      }
      if (!sameFamily) {
        if (e.deleted) e.dirty = false;
        else { e.dirty = true; e.rev = 0; }
      }
    }
    const usedBy = new Set(state.events.filter((e) => !e.deleted).map((e) => e.by));
    state.members = state.members.filter((m) => m.id !== oldMeId || m.id === newMe);
    if (!sameFamily) {
      state.members = state.members.filter((m) => usedBy.has(m.id) || m.id === newMe);
      for (const m of state.members) m.dirty = m.id !== newMe;
    }
  } else {
    state.events = [];
    state.members = [];
  }
  adoptSession(state, res, newMe);
  state.meId = newMe;
  state.family = { id: state.sync.familyId, name: '', birth: '', updatedAt: 0, dirty: false };
  applyServerMeta(state, res);
  await afterJoin(state, now);
  return res;
}

// ---------- 동기화 ----------
/**
 * 한 번 동기화: dirty 기록·구성원·가족을 보내고(묶음으로 나눠), rev 커서 이후를 more 가 없을 때까지 받아 병합 → { changed }
 * 공유 중이 아니면 { changed:false, skipped:true }. 실패는 ApiError 로 throw (401 이면 먼저 sync.revoked=true).
 * opts.keepalive: 화면이 가려질 때 한 번 밀어내기 (작은 묶음 1회).
 */
export async function syncNow(state, now = Date.now(), opts = {}) {
  const sync = state?.sync;
  if (!sync?.token || sync.revoked || !endpoint()) return { changed: false, skipped: true };
  const token = sync.token;
  const pushed = new Set();
  let changed = false;
  let since = isNum(sync.rev) ? sync.rev : 0;
  let res = null;
  const rounds = opts.keepalive ? 1 : MAX_ROUNDS;
  for (let round = 0; round < rounds; round++) {
    const pending = state.events.filter((e) => e.dirty && !e.rejected && !pushed.has(`${e.id}:${e.updatedAt}`));
    const push = takeChunk(pending, opts.keepalive ? KEEPALIVE_MAX_BYTES : PUSH_MAX_BYTES);
    for (const e of push) pushed.add(`${e.id}:${e.updatedAt}`);
    const body = { k: token, since, push: push.map(toWireEvent), members: dirtyMembers(state).map(toWireMember) };
    if (familyDirty(state)) body.family = toWireFamily(state.family);
    try {
      res = await api('sync', body, { keepalive: !!opts.keepalive });
    } catch (e) {
      if (e.status === 401 && state.sync?.token === token) { state.sync.revoked = true; }
      throw e;
    }
    if (state.sync?.token !== token) return { changed };   // 도중에 공유를 끊음/다른 가족 참여 — 결과 버림
    const events = Array.isArray(res.events) ? res.events : [];
    const m = mergeServer(state, events);
    changed = m.changed || changed;
    if (Array.isArray(res.rejected)) {
      const ids = new Set(res.rejected.map(String));
      for (const e of state.events) {
        if (ids.has(e.id) && pushed.has(`${e.id}:${e.updatedAt}`)) { e.dirty = false; e.rejected = true; changed = true; }
      }
    }
    if (Array.isArray(res.rejectedMembers)) {
      const ids = new Set(res.rejectedMembers.map(String));
      for (const mm of state.members) if (ids.has(mm.id) && mm.dirty) { mm.dirty = false; mm.rejected = true; }
    }
    changed = applyServerMeta(state, res) || changed;
    // reset: 서버가 커서가 이상하다고(가족 최대 rev 보다 큼) 처음부터 다시 보냄 → 커서도 0 기준으로 다시 계산
    const base = res.reset ? 0 : since;
    const maxRev = events.reduce((mx, e) => Math.max(mx, Number(e?.rev) || 0), base);
    since = res.more ? maxRev : Math.max(maxRev, isNum(Number(res.rev)) ? Number(res.rev) : 0);
    sync.rev = since;
    const morePush = pending.length > push.length;
    if (res.more && !events.length) break;   // 서버가 more 라면서 비었음 — 무한 반복 방지
    if (!res.more && !morePush) break;
  }
  sync.lastSyncAt = now;
  if (res && isNum(Number(res.serverTime))) sync.skewMs = Number(res.serverTime) - Date.now();
  return { changed };
}

async function authed(state, action, body = {}) {
  const token = state.sync?.token;
  if (!token || state.sync.revoked) throw new ApiError(0, 'not_shared');
  try {
    return await api(action, { k: token, ...body });
  } catch (e) {
    if (e.status === 401 && state.sync?.token === token) state.sync.revoked = true;
    throw e;
  }
}

/** 초대 코드 새로 만들기 (관리자; 옛 링크는 더 이상 안 됨) → 새 코드 */
export async function rotateInvite(state) {
  const res = await authed(state, 'invite');
  state.sync.invite = typeof res.invite === 'string' ? res.invite : null;
  return state.sync.invite;
}

/** 구성원 내보내기 (관리자, 나 자신은 안 됨) — 그 사람의 기기 연결도 끊긴다 */
export async function removeMember(state, memberId) {
  const res = await authed(state, 'remove', { memberId });
  const m = state.members.find((x) => x.id === memberId);
  if (m) m.revoked = true;
  if (Array.isArray(res.members)) applyServerMeta(state, res);
  return res;
}

/** 관리자 지정/해제 (관리자) */
export async function setAdmin(state, memberId, on) {
  const res = await authed(state, 'admin', { memberId, on: !!on });
  const m = state.members.find((x) => x.id === memberId);
  if (m) m.isAdmin = !!on;
  if (Array.isArray(res.members)) applyServerMeta(state, res);
  return res;
}

/** 구성원의 기기 연결만 모두 끊기 (관리자; 내보내지 않음 — 폰을 잃어버렸을 때. 그 자리는 다시 차지할 수 있음) */
export async function unlinkMember(state, memberId) {
  const res = await authed(state, 'unlink', { memberId });
  if (Array.isArray(res.members)) applyServerMeta(state, res);
  return res;
}

/**
 * 내 다른 기기 연결 코드 만들기 (1회용·15분) → { code, expiresAt, link }
 * 같은 사람이 폰 사파리 → 홈 화면 앱, 태블릿 등 기기를 늘릴 때. 새로 만들면 이전 코드는 무효.
 */
export async function createDeviceLink(state) {
  const res = await authed(state, 'devlink');
  return { code: res.code, expiresAt: Number(res.expiresAt) || null, link: deviceLink(res.code) };
}

/** createDeviceLink 의 다른 이름 (설계 메모의 이름) */
export const requestDeviceLink = (state) => createDeviceLink(state);

/**
 * 이 기기 공유 끊기 — 남은 기록을 먼저 한 번 보내 보고(실패해도 계속), 서버에서 이 기기만 끊은 뒤 로컬 연결 정보를 지운다.
 * 기록은 이 기기에 그대로 남는다 (이후 '이 기기만' 모드).
 */
export async function leaveFamily(state) {
  if (state.sync?.token && !state.sync.revoked) {
    try { await syncNow(state, Date.now()); } catch (e) { /* 계속 */ }
    try { await api('leave', { k: state.sync.token }); } catch (e) { /* 서버가 안 받아도 이 기기는 끊는다 */ }
  }
  state.sync = defaultSync();
  state.family.id = null;
  save(state);
  await writeSwConfig(state).catch(() => false);
  return true;
}

// ---------- 초대 링크 ----------
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{16}$/;
function normCode(s) {
  const c = String(s).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CROCKFORD.test(c) ? c : null;
}

/** 초대 링크 (지금 페이지 기준 ./#join=CODE — localhost 에서도 동작) */
export function inviteLink(code) {
  let base = PUBLIC_URL;
  try {
    const href = globalThis.location?.href;
    if (href && /^https?:/i.test(href)) base = new URL('./', href).href;
  } catch (e) { /* ignore */ }
  return `${base}#join=${encodeURIComponent(code)}`;
}

/** 내 다른 기기 연결 링크 (./#dev=CODE) */
export function deviceLink(code) {
  return inviteLink(code).replace('#join=', '#dev=');
}

/**
 * 붙여 넣은 글에서 참여 코드 찾기 → { kind:'invite'|'device', code, explicit } | null
 * #dev= / ?dev= 링크 = 기기 연결, #join= / ?join= 링크 = 초대, 코드만 = 초대(explicit:false — 서버가 모르면 기기 연결로 재시도).
 */
export function parseJoin(text) {
  if (typeof text !== 'string') return null;
  const dm = /[#?&]dev=([^&#\s]+)/i.exec(text.trim());
  if (dm) {
    let v = dm[1];
    try { v = decodeURIComponent(v); } catch (e) { /* ignore */ }
    const c = normCode(v);
    return c ? { kind: 'device', code: c, explicit: true } : null;
  }
  const code = parseInvite(text);
  if (!code) return null;
  return { kind: 'invite', code, explicit: /[#?&]join=/i.test(text) };
}

/**
 * 붙여 넣은 글에서 초대 코드 찾기 → 16자 코드 | null.
 * 받는 형식: 링크의 #join= / ?join= / &join=, 코드만(대소문자·하이픈·공백 무관, O→0·I/L→1 교정), 카톡 메시지 안에 섞인 링크·코드.
 */
export function parseInvite(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t || /[#?&]dev=/i.test(t)) return null;   // 기기 연결 링크는 초대가 아님 (parseJoin)
  const m = /[#?&]join=([^&#\s]+)/i.exec(t);
  if (m) {
    let v = m[1];
    try { v = decodeURIComponent(v); } catch (e) { /* ignore */ }
    return normCode(v);
  }
  const whole = normCode(t);
  if (whole) return whole;
  // 문장 속 코드: 공백으로 나뉜 토큰 중 16자(하이픈 허용) 코드
  for (const tok of t.split(/[\s,.:;"'()<>[\]]+/)) {
    if (tok.replace(/-/g, '').length !== 16) continue;
    const c = normCode(tok);
    if (c) return c;
  }
  return null;
}

/**
 * 잠금화면 단축어용 개인 주소 `${endpoint}?a=q&k=TOKEN&t=TYPE[&ml=..]` — 공유 중이 아니면 ''.
 * ⚠ 이 주소는 비밀번호와 같다 (토큰 포함).
 */
export function quickUrl(state, type, params = {}) {
  const ep = endpoint();
  const k = state?.sync?.token;
  if (!ep || !k || state.sync.revoked) return '';
  let u;
  try { u = new URL(ep); } catch (e) { return ''; }
  u.searchParams.set('a', 'q');
  u.searchParams.set('k', k);
  u.searchParams.set('t', type);
  for (const [key, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(key, String(v));
  }
  return u.toString();
}

// ---------- 서비스워커 데이터 (Cache Storage) ----------
function swUrl(path) {
  const href = globalThis.location?.href;
  const base = href && /^https?:/i.test(href) ? new URL('./', href).href : PUBLIC_URL;
  return new URL(path, base).href;
}

/** 서비스워커 설정 JSON (writeSwConfig 가 쓰는 내용) */
export function swConfig(state) {
  const token = state?.sync?.token && !state.sync.revoked ? state.sync.token : null;
  const meM = state?.members?.find((m) => m.id === state.meId) || null;
  return {
    v: 1,
    endpoint: token ? endpoint() : '',
    token,
    meId: state?.meId ?? null,
    meName: meM?.name || '',
    meEmoji: meM?.emoji || '',
    quickActions: Array.isArray(state?.prefs?.quickActions) ? state.prefs.quickActions.slice(0, 2) : ['pee', 'poop'],
    lastMl: { ...(state?.prefs?.lastMl || {}) },
    babyName: state?.family?.name || '',
  };
}

/** 서비스워커 설정 쓰기 (Cache Storage ./__bl/config) → 성공 여부. Cache Storage 가 없으면 false */
export async function writeSwConfig(state) {
  if (typeof caches === 'undefined') return false;
  try {
    const c = await caches.open(SW_DATA_CACHE);
    await c.put(swUrl(SW_CONFIG_PATH), new Response(JSON.stringify(swConfig(state)), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));
    return true;
  } catch (e) {
    return false;
  }
}

/** 서비스워커 데이터 캐시 전부 지우기 (이 기기 기록 모두 지우기 때) */
export async function clearSwData() {
  if (typeof caches === 'undefined') return false;
  try { return await caches.delete(SW_DATA_CACHE); } catch (e) { return false; }
}

/**
 * 'both' 의 대변 쪽 id — 소변 id 에서 결정적으로 만든다 (다시 가져와도 중복되지 않게): 마지막 12자리 16진수를 보수(15-d)로.
 * ⚠ 서버 supabase/functions/uriday-log/handler.js 의 pairId 와 같은 계산 (알림 버튼 요청의 응답이 끊겨 수신함으로도
 *   들어오면 서버와 앱이 같은 대변 id 를 만들어야 중복이 안 생긴다 — tests/store-sync.test.mjs 에서 둘을 비교).
 */
export function pairId(id) {
  if (!isUuid(id)) return uuid();
  const u = id.trim().toLowerCase();
  return u.slice(0, 24) + Array.from(u.slice(24), (ch) => (15 - parseInt(ch, 16)).toString(16)).join('');
}

function importInboxEvent(state, raw, now) {
  if (!isObj(raw)) return 0;
  const type = raw.type;
  if (type === 'both') {
    const t = isNum(raw.ts) ? raw.ts : now;
    return importInboxEvent(state, { ...raw, type: 'pee', data: { src: raw.data?.src } }, now)
      + importInboxEvent(state, { ...raw, id: isUuid(raw.id2) ? raw.id2 : pairId(raw.id), type: 'poop', ts: t }, now);
  }
  if (!EVENT_TYPES[type] || EVENT_TYPES[type].hidden) return 0;
  const id = isUuid(raw.id) ? raw.id : uuid();
  if (state.events.some((e) => e.id === id)) return 0;
  const ts = isNum(raw.ts) ? Math.round(raw.ts) : now;
  const data = cleanData(type, { src: 'notif', ...(isObj(raw.data) ? raw.data : {}) }, ts);
  state.events.push({
    id, type, ts,
    by: typeof raw.by === 'string' && raw.by ? raw.by : (state.meId ?? null),
    data, deleted: false, updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : ts, rev: 0, dirty: true,
  });
  return 1;
}

/**
 * 서비스워커 수신함 가져오기 → { imported }. id 로 중복 제거, 저장에 성공한 뒤에만 수신함 항목을 지운다
 * (저장 실패 시 다음에 다시 가져옴 — 중복은 id 로 걸러짐).
 */
export async function drainInbox(state, now = Date.now()) {
  if (typeof caches === 'undefined' || !state) return { imported: 0 };
  let c;
  try { c = await caches.open(SW_DATA_CACHE); } catch (e) { return { imported: 0 }; }
  const inbox = swUrl(SW_INBOX_PATH);
  const prefix = `${inbox}/`;
  let keys = [];
  try { keys = await c.keys(); } catch (e) { return { imported: 0 }; }
  let imported = 0;
  const done = [];
  for (const req of keys) {
    const url = typeof req === 'string' ? req : req.url;
    if (url !== inbox && !url.startsWith(prefix)) continue;
    try {
      const r = await c.match(req);
      const body = r ? await r.json() : null;
      const list = Array.isArray(body) ? body : [body];
      for (const raw of list) imported += importInboxEvent(state, raw, now);
      done.push(req);
    } catch (e) {
      done.push(req);   // 읽을 수 없는 항목은 치운다 (계속 실패하지 않게)
    }
  }
  if (imported && !save(state, now)) return { imported };   // 저장 실패 → 수신함 유지
  for (const req of done) { try { await c.delete(req); } catch (e) { /* ignore */ } }
  return { imported };
}

// ---------- 자동 동기화 ----------
/**
 * 자동 동기화 루프 (SPEC §2.8) → { kick(), stop(), status(), now() }
 * · 시작할 때, 화면이 다시 보일 때, focus, online, 20초마다(보일 때만), kick() 후 800ms 디바운스.
 * · 가려진 동안은 주기 동기화 안 함. 단, 가려지는 순간 보낼 기록이 있으면 한 번 밀어낸다 (keepalive — 새벽에 기록하고
 *   바로 잠가도 다른 가족 폰에 뜨도록).
 * · 실패 시 5초부터 두 배씩 최대 5분 대기 (화면 복귀·focus·online 은 대기를 무시하고 바로 시도).
 * · 401 → 루프 중지, status 'revoked'. 수신함(서비스워커)은 공유 여부와 상관없이 가져온다.
 * · 성공할 때마다 save(state) 후 onChange(state, { changed, status, error?, imported? }).
 *   getState() 가 다른 객체를 돌려주면(초기화·참여로 교체) 그 결과는 버린다.
 * status: 'off'(공유 안 함) | 'ok' | 'offline'(네트워크·시간초과) | 'error' | 'revoked'
 */
export function startAutoSync(getState, onChange = () => {}, opts = {}) {
  const debounceMs = opts.debounceMs ?? 800;
  const intervalMs = opts.intervalMs ?? 20000;
  const doc = typeof document !== 'undefined' ? document : null;
  const win = typeof window !== 'undefined' ? window : null;
  let stopped = false;
  let inflight = null;
  let again = false;
  let fails = 0;
  let nextAllowed = 0;
  let debounceT = null;
  let retryT = null;
  let lastCfg = '';

  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const shared = (s) => !!(s?.sync?.token && !s.sync.revoked && endpoint());
  // 첫 동기화 전 상태: 공유 중이면 낙관적으로 'ok' (열 때마다 점이 주황으로 깜빡이지 않게)
  const s0 = getState();
  let status = shared(s0) ? 'ok' : (s0?.sync?.revoked ? 'revoked' : 'off');
  const notify = (state, info) => { try { onChange(state, { status, ...info }); } catch (e) { /* UI 오류가 루프를 멈추지 않게 */ } };

  async function refreshSwConfig(state) {
    const cfg = JSON.stringify(swConfig(state));
    if (cfg === lastCfg) return;
    if (await writeSwConfig(state)) lastCfg = cfg;
  }

  function run(reason, force = false) {
    if (stopped) return Promise.resolve();
    if (inflight) { again = true; return inflight; }
    if (!force && Date.now() < nextAllowed) return Promise.resolve();
    const state = getState();
    if (!state) return Promise.resolve();
    inflight = (async () => {
      let imported = 0;
      try {
        imported = (await drainInbox(state).catch(() => ({ imported: 0 }))).imported;
        if (getState() !== state) return;
        if (!shared(state)) {
          status = state.sync?.revoked ? 'revoked' : 'off';
          if (imported) notify(state, { changed: true, imported });
          return;
        }
        if (!visible() && reason !== 'hide') {
          if (imported) notify(state, { changed: true, imported });
          return;
        }
        const r = await syncNow(state, Date.now(), { keepalive: reason === 'hide' });
        if (getState() !== state) return;
        fails = 0;
        nextAllowed = 0;
        clearTimeout(retryT);
        save(state);
        status = 'ok';
        refreshSwConfig(state).catch(() => {});
        notify(state, { changed: r.changed || imported > 0, imported });
      } catch (e) {
        if (getState() !== state) return;
        save(state);   // 도중까지 병합한 것도 저장 (dirty 표시는 안전하게 유지됨)
        if (e?.status === 401 || state.sync?.revoked) {
          status = 'revoked';
          refreshSwConfig(state).catch(() => {});
          notify(state, { changed: true, error: e, imported });
          return;
        }
        fails++;
        const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** (fails - 1)) * (0.8 + Math.random() * 0.4);
        nextAllowed = Date.now() + delay;
        clearTimeout(retryT);
        retryT = setTimeout(() => run('retry', true), delay);
        const offline = e?.code === 'network' || e?.code === 'timeout' || (typeof navigator !== 'undefined' && navigator.onLine === false);
        status = offline ? 'offline' : 'error';
        notify(state, { changed: imported > 0, error: e, imported });
      } finally {
        inflight = null;
        if (again && !stopped) { again = false; setTimeout(() => run('again'), 0); }
      }
    })();
    return inflight;
  }

  const onVis = () => {
    if (!doc) return;
    if (doc.visibilityState === 'visible') run('visible', true);
    else {
      const s = getState();
      if (debounceT || s?.events?.some((e) => e.dirty && !e.rejected)) { clearTimeout(debounceT); debounceT = null; run('hide', true); }
    }
  };
  const onFocus = () => run('focus', true);
  const onOnline = () => { fails = 0; nextAllowed = 0; run('online', true); };
  const onOffline = () => { if (status === 'ok') { status = 'offline'; const s = getState(); if (s) notify(s, { changed: false }); } };

  doc?.addEventListener?.('visibilitychange', onVis);
  win?.addEventListener?.('focus', onFocus);
  win?.addEventListener?.('online', onOnline);
  win?.addEventListener?.('offline', onOffline);
  const timer = setInterval(() => { if (visible()) run('tick'); }, intervalMs);
  run('start', true);

  return {
    /** 로컬 변경 후 호출 — 800ms 디바운스 후 동기화 */
    kick() {
      if (stopped) return;
      clearTimeout(debounceT);
      debounceT = setTimeout(() => { debounceT = null; run('kick'); }, debounceMs);
    },
    /** 루프 중지 (리스너·타이머 해제) */
    stop() {
      stopped = true;
      clearTimeout(debounceT);
      clearTimeout(retryT);
      clearInterval(timer);
      doc?.removeEventListener?.('visibilitychange', onVis);
      win?.removeEventListener?.('focus', onFocus);
      win?.removeEventListener?.('online', onOnline);
      win?.removeEventListener?.('offline', onOffline);
    },
    /** 현재 상태 문자열 */
    status() { return status; },
    /** 지금 바로 동기화 (대기 무시) → Promise */
    now() { return run('manual', true); },
  };
}
