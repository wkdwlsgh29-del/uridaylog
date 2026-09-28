// ============================================================
// '함께 육아일지' 저장소 — localStorage 한 덩어리(JSON) + 기록·구성원 CRUD
// · 키 하나(KEY)에 전부 저장한다. 읽기는 절대 throw 하지 않고, 깨진 값은 백업 키로 옮겨 둔 뒤 새로 시작한다.
// · 모든 변경은 updatedAt 을 올리고 dirty=true (서버에 보낼 것). updatedAt 은 이전 값+1 이상으로만 올라가서
//   기기 시계가 뒤로 가도 '내가 방금 고친 것'이 LWW(마지막 쓰기 승리)에서 지지 않는다.
// · dirty 는 이 기기 전용 표시다 — 저장은 하지만 서버로는 보내지 않는다 (sync.js 가 떼고 보냄).
// ============================================================

import { uuid, isUuid, cleanData, sleepState } from './logic.js';
import { EVENT_TYPES, ACTION_META, ROLE_BY_ID, AMOUNT_TYPES, LIMITS } from './log-data.js';

/** localStorage 키 (기록 전체가 들어 있는 한 덩어리) */
export const KEY = 'bl:v1';
/** 깨진 저장값 백업 키 (복구용 — 덮어쓰지 않고 한 번 옮겨 둠) */
export const CORRUPT_KEY = 'bl:v1:corrupt';

const DAY = 86400000;
const TYPE_RE = /^[a-z_]{2,16}$/;
const THEMES = ['auto', 'light', 'dark'];

function storage() {
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const cut = (s, n) => Array.from(String(s)).slice(0, n).join('');

/** 변경 시각 올리기: max(now, 이전+1) — 시계가 뒤로 가도 단조 증가 */
export function bump(prev, now = Date.now()) {
  return Math.max(isNum(now) ? now : Date.now(), (isNum(prev) ? prev : 0) + 1);
}

/** 새 상태 (처음 실행) */
export function defaultState() {
  return {
    v: 1,
    family: { id: null, name: '', birth: '', updatedAt: 0, dirty: false },
    members: [],
    meId: null,
    events: [],
    sync: defaultSync(),
    prefs: {
      grid: {}, game: true, theme: 'auto', lastMl: {}, seenStage: null,
      seenBadges: [], seenThanks: [], handoffCount: 0, quickActions: ['pee', 'poop'],
    },
  };
}

/** 공유 안 한 상태의 sync 블록 (memberId = 서버가 이 기기 토큰에 묶은 구성원, revoked = 401로 끊김) */
export function defaultSync() {
  return { token: null, familyId: null, rev: 0, isAdmin: false, lastSyncAt: 0, invite: null, memberId: null, revoked: false };
}

// ---------- 불러오기 · 검증 ----------
function backupCorrupt(raw) {
  const ls = storage();
  if (!ls) return;
  try {
    if (!ls.getItem(CORRUPT_KEY)) ls.setItem(CORRUPT_KEY, raw);
  } catch (e) { /* ignore */ }
}

function normMember(m) {
  if (!isObj(m) || typeof m.id !== 'string' || !m.id) return null;
  const role = ROLE_BY_ID[m.role] ? m.role : 'other';
  return {
    ...m,
    id: m.id,
    name: typeof m.name === 'string' && m.name.trim() ? cut(m.name.trim(), LIMITS.memberName) : ROLE_BY_ID[role].label,
    role,
    emoji: typeof m.emoji === 'string' && m.emoji ? cut(m.emoji, LIMITS.memberEmoji) : ROLE_BY_ID[role].emoji,
    updatedAt: isNum(m.updatedAt) ? m.updatedAt : 0,
    isAdmin: !!m.isAdmin,
    claimed: !!m.claimed,
    revoked: !!m.revoked,
    dirty: !!m.dirty,
  };
}

function normEvent(e) {
  if (!isObj(e) || typeof e.id !== 'string' || !e.id || typeof e.type !== 'string' || !TYPE_RE.test(e.type) || !isNum(e.ts)) return null;
  return {
    ...e,
    ts: Math.round(e.ts),
    by: typeof e.by === 'string' && e.by ? e.by : null,
    data: isObj(e.data) ? e.data : {},
    deleted: !!e.deleted,
    updatedAt: isNum(e.updatedAt) ? e.updatedAt : e.ts,
    rev: isNum(e.rev) && e.rev > 0 ? e.rev : 0,
    dirty: !!e.dirty,
  };
}

/** 저장된 객체를 현재 모양으로 맞춤 (모르는 최상위 키는 보존 — 새 버전과 오갈 때 잃지 않게). 잘못된 값은 버리거나 기본값 */
export function normalizeState(obj) {
  if (!isObj(obj)) throw new TypeError('state is not an object');
  const s = defaultState();
  for (const k of Object.keys(obj)) if (!(k in s)) s[k] = obj[k];
  // 가족
  const f = isObj(obj.family) ? obj.family : {};
  s.family = {
    id: typeof f.id === 'string' && f.id ? f.id : null,
    name: typeof f.name === 'string' ? cut(f.name.trim(), LIMITS.babyName) : '',
    birth: typeof f.birth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.birth) ? f.birth : '',
    updatedAt: isNum(f.updatedAt) ? f.updatedAt : 0,
    dirty: !!f.dirty,
  };
  // 구성원 (id 중복이면 나중 것 버림)
  const seenM = new Set();
  s.members = (Array.isArray(obj.members) ? obj.members : []).map(normMember).filter((m) => m && !seenM.has(m.id) && seenM.add(m.id));
  // 기록 (id 중복이면 updatedAt 이 큰 것)
  const byId = new Map();
  for (const raw of Array.isArray(obj.events) ? obj.events : []) {
    const e = normEvent(raw);
    if (!e) continue;
    const prev = byId.get(e.id);
    if (!prev || e.updatedAt > prev.updatedAt) byId.set(e.id, e);
  }
  s.events = [...byId.values()];
  // 나
  s.meId = typeof obj.meId === 'string' && s.members.some((m) => m.id === obj.meId) ? obj.meId : (s.members[0]?.id ?? null);
  // 동기화
  const y = isObj(obj.sync) ? obj.sync : {};
  s.sync = {
    ...defaultSync(),
    token: typeof y.token === 'string' && y.token ? y.token : null,
    familyId: typeof y.familyId === 'string' && y.familyId ? y.familyId : null,
    rev: isNum(y.rev) && y.rev > 0 ? y.rev : 0,
    isAdmin: !!y.isAdmin,
    lastSyncAt: isNum(y.lastSyncAt) ? y.lastSyncAt : 0,
    invite: typeof y.invite === 'string' && y.invite ? y.invite : null,
    memberId: typeof y.memberId === 'string' && y.memberId ? y.memberId : null,
    revoked: !!y.revoked,
  };
  if (isNum(y.skewMs)) s.sync.skewMs = y.skewMs;
  // 설정
  const p = isObj(obj.prefs) ? obj.prefs : {};
  const d = s.prefs;
  const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null);
  s.prefs = {
    ...p,
    grid: isObj(p.grid) ? Object.fromEntries(Object.entries(p.grid).map(([k, v]) => [k, strList(v)]).filter(([, v]) => v)) : d.grid,
    game: typeof p.game === 'boolean' ? p.game : d.game,
    theme: THEMES.includes(p.theme) ? p.theme : d.theme,
    lastMl: isObj(p.lastMl) ? Object.fromEntries(Object.entries(p.lastMl).filter(([, v]) => isNum(v))) : d.lastMl,
    seenStage: typeof p.seenStage === 'string' ? p.seenStage : null,
    seenBadges: strList(p.seenBadges) || [],
    seenThanks: strList(p.seenThanks) || [],
    handoffCount: isNum(p.handoffCount) ? Math.max(0, Math.floor(p.handoffCount)) : 0,
    quickActions: strList(p.quickActions) || d.quickActions,
  };
  s.v = 1;
  return s;
}

/** 상태 불러오기 — 절대 throw 하지 않음. 없으면 새 상태, 깨졌으면 CORRUPT_KEY 에 원본을 백업하고 새 상태 */
export function load() {
  let raw = null;
  try { raw = storage()?.getItem(KEY) ?? null; } catch (e) { raw = null; }
  if (!raw) return defaultState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch (e) {
    backupCorrupt(raw);
    return defaultState();
  }
}

function isQuota(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''));
}

/** 지운 지 30일 넘은 툼스톤 정리 (서버에 반영됐거나 공유 중이 아닌 것만) → 지운 개수 */
export function pruneTombstones(state, now = Date.now()) {
  const shared = !!state.sync?.token;
  const before = state.events.length;
  state.events = state.events.filter((e) => !(e.deleted && e.updatedAt < now - 30 * DAY && (!e.dirty || !shared)));
  return before - state.events.length;
}

/**
 * 저장 → true/false. 용량 초과면 오래된 툼스톤을 정리하고 다시, 그래도 안 되면 깨진 값 백업을 비우고 한 번 더.
 * false 면 UI가 "저장 공간이 부족해요" 안내 (메모리의 상태는 그대로 — 기록을 잃지 않게 백업을 권함).
 */
export function save(state, now = Date.now()) {
  const ls = storage();
  if (!ls || !state) return false;
  const write = () => { ls.setItem(KEY, JSON.stringify(state)); return true; };
  try {
    return write();
  } catch (e) {
    if (!isQuota(e)) return false;
  }
  try {
    if (pruneTombstones(state, now) > 0) return write();
  } catch (e) { /* 다음 단계 */ }
  try {
    if (ls.getItem(CORRUPT_KEY) != null) { ls.removeItem(CORRUPT_KEY); return write(); }
  } catch (e) { /* ignore */ }
  return false;
}

/** 이 기기의 기록 전부 삭제 (키 + 백업 키). 서비스워커 데이터는 sync.clearSwData() */
export function wipe() {
  const ls = storage();
  if (!ls) return;
  try { ls.removeItem(KEY); } catch (e) { /* ignore */ }
  try { ls.removeItem(CORRUPT_KEY); } catch (e) { /* ignore */ }
}

// ---------- 가족 · 구성원 ----------
function cleanMemberName(name, role) {
  const n = typeof name === 'string' ? cut(name.trim(), LIMITS.memberName) : '';
  return n || (ROLE_BY_ID[role] || ROLE_BY_ID.other).label;
}

/** 첫 실행: 아기 정보 + 나(구성원) 만들기 → 만든 구성원. meId 가 그 구성원이 된다 */
export function setupFamily(state, { name = '', birth = '', me = {} } = {}, now = Date.now()) {
  updateFamily(state, { name, birth }, now);
  const m = upsertMember(state, { role: me.role, name: me.name, emoji: me.emoji }, now);
  state.meId = m.id;
  return m;
}

/** 아기 이름·생일 수정 (설정) → family */
export function updateFamily(state, { name, birth } = {}, now = Date.now()) {
  const f = state.family;
  if (name !== undefined) f.name = typeof name === 'string' ? cut(name.trim(), LIMITS.babyName) : '';
  if (birth !== undefined) f.birth = typeof birth === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth : f.birth;
  f.updatedAt = bump(f.updatedAt, now);
  f.dirty = true;
  return f;
}

/** 구성원 추가/수정 (id 가 있고 이미 있으면 이름·역할·이모지만 수정) → 구성원. isAdmin/claimed/revoked 는 서버 소유라 건드리지 않음 */
export function upsertMember(state, member = {}, now = Date.now()) {
  const existing = member.id ? state.members.find((m) => m.id === member.id) : null;
  if (existing) {
    if (member.role !== undefined && ROLE_BY_ID[member.role]) existing.role = member.role;
    if (member.name !== undefined) existing.name = cleanMemberName(member.name, existing.role);
    if (member.emoji !== undefined) existing.emoji = typeof member.emoji === 'string' && member.emoji ? cut(member.emoji, LIMITS.memberEmoji) : ROLE_BY_ID[existing.role].emoji;
    existing.updatedAt = bump(existing.updatedAt, now);
    existing.dirty = true;
    return existing;
  }
  const role = ROLE_BY_ID[member.role] ? member.role : 'other';
  const m = {
    id: isUuid(member.id) ? member.id : uuid(),
    name: cleanMemberName(member.name, role),
    role,
    emoji: typeof member.emoji === 'string' && member.emoji ? cut(member.emoji, LIMITS.memberEmoji) : ROLE_BY_ID[role].emoji,
    updatedAt: isNum(now) ? now : Date.now(),
    dirty: true,
  };
  state.members.push(m);
  return m;
}

/** 이 기기에서 기록하는 사람 (구성원 전환 시트에서 바꿀 수 있음) */
export function me(state) {
  return memberById(state, state?.meId);
}

/** id 로 구성원 찾기 (없으면 null) */
export function memberById(state, id) {
  if (!id || !state) return null;
  return state.members.find((m) => m.id === id) || null;
}

/** 이 기기의 '나' 바꾸기 (구성원 전환) → 성공 여부 */
export function setMe(state, memberId) {
  if (!memberById(state, memberId)) return false;
  state.meId = memberId;
  return true;
}

// ---------- 기록 ----------
/** id 로 기록 찾기 (지운 것 포함, 없으면 null) */
export function eventById(state, id) {
  return state.events.find((e) => e.id === id) || null;
}

function rememberMl(state, e) {
  if (AMOUNT_TYPES.includes(e.type) && isNum(e.data?.ml)) state.prefs.lastMl[e.type] = e.data.ml;
}

/**
 * 기록 추가 → 기록. by 생략 시 meId, ts 생략 시 now. data 는 종류별로 정리(cleanData).
 * id 를 넘기면(서비스워커 수신함 등) 그대로 쓰고, 이미 있으면 새로 만들지 않고 기존 기록을 돌려준다.
 * 모르는 종류는 TypeError ('both'·'sleep' 토글은 logAction/toggleSleep 을 쓴다).
 */
export function addEvent(state, { id, type, ts, by, data } = {}, now = Date.now()) {
  if (!EVENT_TYPES[type]) throw new TypeError(`알 수 없는 기록 종류: ${type}`);
  if (id) {
    const dup = eventById(state, id);
    if (dup) return dup;
  }
  const t = isNum(ts) ? Math.round(ts) : now;
  const e = {
    id: isUuid(id) ? id : uuid(),
    type,
    ts: t,
    by: by === undefined ? (state.meId ?? null) : (by || null),
    data: cleanData(type, data, t),
    deleted: false,
    updatedAt: now,
    rev: 0,
    dirty: true,
  };
  state.events.push(e);
  rememberMl(state, e);
  return e;
}

/**
 * 기록 수정 → 기록|null. patch: { ts?, by?, type?, data?, deleted? } — data 는 얕게 합치고 null/undefined 값은 키를 지운다.
 */
export function updateEvent(state, id, patch = {}, now = Date.now()) {
  const e = eventById(state, id);
  if (!e) return null;
  if (patch.type !== undefined && EVENT_TYPES[patch.type]) e.type = patch.type;
  if (isNum(patch.ts)) e.ts = Math.round(patch.ts);
  if ('by' in patch) e.by = patch.by || null;
  let data = { ...(e.data || {}) };
  if (isObj(patch.data)) {
    for (const [k, v] of Object.entries(patch.data)) {
      if (v === null || v === undefined) delete data[k];
      else data[k] = v;
    }
  }
  data = cleanData(e.type, data, e.ts);
  e.data = data;
  if ('deleted' in patch) e.deleted = !!patch.deleted;
  e.updatedAt = bump(e.updatedAt, now);
  e.dirty = true;
  delete e.rejected;
  rememberMl(state, e);
  return e;
}

/** 기록 지우기 (툼스톤 — 다른 기기에도 지워짐이 전달되도록 남겨 둠) → 기록|null */
export function deleteEvent(state, id, now = Date.now()) {
  const e = eventById(state, id);
  if (!e) return null;
  e.deleted = true;
  e.updatedAt = bump(e.updatedAt, now);
  e.dirty = true;
  return e;
}

/** 지운 기록 되살리기 → 기록|null */
export function restoreEvent(state, id, now = Date.now()) {
  const e = eventById(state, id);
  if (!e) return null;
  e.deleted = false;
  e.updatedAt = bump(e.updatedAt, now);
  e.dirty = true;
  return e;
}

/**
 * 수면 토글: 자는 중(24시간 이내 끝 없는 잠)이 있으면 전부 끝내고, 없으면 새로 시작.
 * → { kind: 'sleepStart'|'sleepEnd', events }. at = 기록 시각(기본 now, 'N분 전' 칩).
 */
export function toggleSleep(state, now = Date.now(), { by, at } = {}) {
  const t = isNum(at) ? Math.round(at) : now;
  const { ongoingAll } = sleepState(state.events, Math.max(now, t));
  if (ongoingAll.length) {
    const events = ongoingAll.map((e) => updateEvent(state, e.id, { data: { end: Math.max(e.ts, t) } }, now));
    return { kind: 'sleepEnd', events };
  }
  const e = addEvent(state, { type: 'sleep', ts: t, by }, now);
  return { kind: 'sleepStart', events: [e] };
}

/**
 * 버튼 동작 하나 기록 (퀵 그리드용) → { kind: 'add'|'sleepStart'|'sleepEnd', events }
 * 'both' = 소변+대변 두 건(같은 시각, opts.data 는 대변 쪽). 'sleep' = 토글. 터미타임은 기본 5분.
 */
export function logAction(state, actionId, { ts, by, data } = {}, now = Date.now()) {
  if (actionId === 'sleep') return toggleSleep(state, now, { by, at: ts });
  if (actionId === 'both') {
    const t = isNum(ts) ? Math.round(ts) : now;
    const src = data?.src ? { src: data.src } : {};
    const pee = addEvent(state, { type: 'pee', ts: t, by, data: src }, now);
    const poop = addEvent(state, { type: 'poop', ts: t, by, data }, now);
    return { kind: 'add', events: [pee, poop] };
  }
  const meta = EVENT_TYPES[actionId] || ACTION_META[actionId];
  const d = meta?.defaultData ? { ...meta.defaultData, ...(data || {}) } : data;
  return { kind: 'add', events: [addEvent(state, { type: actionId, ts, by, data: d }, now)] };
}

/** logAction 되돌리기 (실행 취소 토스트): 추가 → 지우기, 잠 시작 → 지우기, 잠 끝 → 끝 시각 빼기 */
export function undoAction(state, result, now = Date.now()) {
  if (!result || !Array.isArray(result.events)) return;
  for (const e of result.events) {
    if (!e) continue;
    if (result.kind === 'sleepEnd') updateEvent(state, e.id, { data: { end: null } }, now);
    else deleteEvent(state, e.id, now);
  }
}

// ---------- 동기화 대상 ----------
/** 서버로 보낼 기록 (dirty) */
export function dirtyEvents(state) {
  return state.events.filter((e) => e.dirty);
}
/** 서버로 보낼 구성원 프로필 (dirty) */
export function dirtyMembers(state) {
  return state.members.filter((m) => m.dirty);
}
/** 아기 정보(이름·생일)를 서버로 보내야 하는지 */
export function familyDirty(state) {
  return !!state.family?.dirty;
}

/**
 * 다른 탭이 저장한 상태를 합치기 (window 'storage' 이벤트용) → 바뀐 게 있으면 true.
 * 기록·구성원은 updatedAt 이 큰 쪽, 같으면 어느 한쪽이라도 서버 확인(dirty=false)이면 확인된 것으로.
 * 다른 가족으로 바뀐 경우(참여·끊기)는 합치지 않고 false — 호출한 쪽이 새로 load() 하면 된다.
 */
export function absorb(state, other) {
  if (!state || !other || (state.sync?.familyId || null) !== (other.sync?.familyId || null)) return false;
  let changed = false;
  const mergeList = (mine, theirs) => {
    const idx = new Map(mine.map((x, i) => [x.id, i]));
    for (const t of theirs) {
      const i = idx.get(t.id);
      if (i === undefined) { mine.push({ ...t }); changed = true; continue; }
      const m = mine[i];
      if ((t.updatedAt || 0) > (m.updatedAt || 0)) { mine[i] = { ...t }; changed = true; }
      else if (t.updatedAt === m.updatedAt && m.dirty && !t.dirty) { m.dirty = false; if (isNum(t.rev)) m.rev = Math.max(m.rev || 0, t.rev); }
    }
  };
  mergeList(state.events, other.events || []);
  mergeList(state.members, other.members || []);
  if ((other.family?.updatedAt || 0) > (state.family?.updatedAt || 0)) { state.family = { ...other.family }; changed = true; }
  if (state.sync && other.sync && (other.sync.rev || 0) > (state.sync.rev || 0)) state.sync.rev = other.sync.rev;
  return changed;
}
