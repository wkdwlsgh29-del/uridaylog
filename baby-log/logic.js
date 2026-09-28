// ============================================================
// '함께 육아일지' 로직 — 순수 함수 모음 (DOM·저장소·네트워크 없음)
// · 현재 시각 now 는 항상 인자로 받는다 (기본값에서만 Date.now()).
// · 하루 경계는 기기 로컬 시간 기준 (new Date(ts) 의 로컬 연·월·일). 시간대를 가정하지 않는다.
//   하루를 더할 때 +86400000 대신 new Date(y, m, d + 1) 을 써서 서머타임이 있는 시간대에서도 안전하다.
// · 이벤트 배열은 바꾸지 않는다 (정렬도 복사본에서).
//
// 결정 사항 (문서화)
// · 수유 = 분유·모유·유축 (FEED_TYPES). 우유는 돌 이후 '식사'로 보고 수유 횟수·간격·트림 체크에서 뺀다.
// · 소변/대변 수 = pee/poop 기록 + 변기 성공(쉬/응가). 'both' 버튼은 pee+poop 두 건이라 각각 센다.
// · 끝나지 않은 잠은 min(구간 끝, now, 시작+24시간) 까지로 센다 (24시간 = 서버 수면 토글과 같은 창).
// · 30분 안에 이어진 수유(양쪽 모유·분유 보충)는 한 번의 수유로 묶어서 간격을 잰다.
// ============================================================

import {
  EVENT_TYPES, ACTION_META, QUICK_ACTIONS, STAGES, NORMS, POOP_COLORS, POOP_TEXTURES, BADGES, HINT_COPY,
  ROLE_BY_ID, MEMBER_COLORS, FEED_TYPES, AMOUNT_TYPES, REACTION_TYPES, AMOUNT_CHIPS, BREAST_SIDES,
  BURP_OPTIONS, FOOD_AMOUNTS, FOOD_REACTIONS, POTTY_RESULTS, LIMITS,
} from './log-data.js';
import { addMonths } from '../shared/js/date-utils.js';

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const SKEW = 2 * MIN;   // 기기끼리 시계가 조금 달라도(다른 폰이 1~2분 빠름) 방금 기록이 '미래'로 숨지 않게
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const REACTIONS = new Set(REACTION_TYPES);
const FEEDS = new Set(FEED_TYPES);

// ---------- 작은 유틸 ----------
const pad2 = (n) => String(n).padStart(2, '0');
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cut = (s, n) => Array.from(String(s)).slice(0, n).join('');   // 이모지(서로게이트 쌍)를 쪼개지 않고 자르기

/** 천 단위 쉼표 (1050 → '1,050') */
export function fmtNum(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 문구 자리표시자 채우기: fill('오늘 {n}ml', { n: 120 }) */
export function fill(tpl, vars = {}) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** 받침에 맞는 조사: josa('엄마', '이/가') → '엄마가', josa('이모님', '이/가') → '이모님이' */
export function josa(word, pair = '이/가') {
  const [withBatchim, without] = pair.split('/');
  const w = String(word || '');
  const code = w.charCodeAt(w.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    if (pair === '으로/로') return w + (jong === 0 || jong === 8 ? without : withBatchim);
    return w + (jong ? withBatchim : without);
  }
  // 한글이 아니면(이모지·영문) 받침 없는 쪽으로
  return w + without;
}

/** uuid v4 — crypto.randomUUID, 없으면 getRandomValues, 그것도 없으면 Math.random */
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** uuid 형식 검사 (서버가 id 로 받는 형식) */
export function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/** 기록 종류 정보 (모르는 종류 — 새 버전 앱이 만든 기록 — 도 안전한 기본값으로) */
export function typeMeta(type) {
  return EVENT_TYPES[type] || ACTION_META[type] || { label: '기록', emoji: '•', group: 'etc', input: 'tap', unknown: true };
}

// ---------- 날짜 ----------
/** 'YYYY-MM-DD' → 로컬 자정 Date, 잘못된 값이면 null */
export function parseBirth(iso) {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const dt = new Date(y, mo, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt;
}

/** 로컬 자정(epoch ms) */
export function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 로컬 날짜 기준 n일 뒤 자정 (서머타임 안전) */
export function addDaysTs(ts, n) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

/** 로컬 날짜 키 'YYYY-MM-DD' */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// 날짜 서수(연속한 날은 정확히 1 차이) — 로컬 연·월·일만 쓰므로 시간대·서머타임과 무관
function dayOrd(ts) {
  const d = new Date(ts);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

/** 밤 시간(22~06시)인지 — 로컬 시각 */
export function isNight(ts) {
  const h = new Date(ts).getHours();
  return h >= NORMS.nightFrom || h < NORMS.nightTo;
}

/** 생후 일수 (태어난 날 = 0일; 로컬 달력 기준). 생일이 잘못되면 null, 미래면 0 */
export function ageDays(birthISO, now = Date.now()) {
  const b = parseBirth(birthISO);
  if (!b || !isNum(now)) return null;
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(0, Math.round((today - b) / DAY));
}

/**
 * 현재 성장 단계 → { stage, index, daysIn, daysToNext, next, ageDays, progress }
 * 생일이 없거나 잘못돼도 null 대신 1단계(신생아)를 돌려준다 (ageDays: null).
 */
export function stageFor(birthISO, now = Date.now()) {
  const age = ageDays(birthISO, now);
  const a = age ?? 0;
  let index = 0;
  for (let i = 0; i < STAGES.length; i++) if (a >= STAGES[i].fromDay) index = i;
  const stage = STAGES[index];
  const next = STAGES[index + 1] || null;
  return {
    stage, index, next, ageDays: age,
    daysIn: a - stage.fromDay,
    daysToNext: next ? next.fromDay - a : null,
    progress: next ? (a - stage.fromDay) / (next.fromDay - stage.fromDay) : 1,
  };
}

/** 이 생후 일수에 보이는 버튼인지 (EVENT_TYPES.fromDay/toDay; 일수를 모르면 항상 true) */
export function isActionVisible(actionId, ageDaysValue) {
  const m = EVENT_TYPES[actionId] || ACTION_META[actionId];
  if (!m || m.hidden) return false;
  if (ageDaysValue == null) return true;
  if (m.fromDay != null && ageDaysValue < m.fromDay) return false;
  if (m.toDay != null && ageDaysValue >= m.toDay) return false;
  return true;
}

/**
 * 퀵 그리드 버튼 목록: prefs.grid[stage.id] (가족이 편집한 목록)가 있으면 그것, 아니면 단계 기본값.
 * 기본값은 아직 안 열린 버튼(예: 뒤집기 단계의 이유식은 120일부터)을 뺀다.
 */
export function gridFor(stage, ageDaysValue = null, prefs = null) {
  const custom = prefs && prefs.grid && Array.isArray(prefs.grid[stage.id]) ? prefs.grid[stage.id] : null;
  if (custom) return custom.filter((id) => (EVENT_TYPES[id] && !EVENT_TYPES[id].hidden) || !!ACTION_META[id]);
  return stage.grid.filter((id) => isActionVisible(id, ageDaysValue));
}

/** 더보기 시트 버튼 목록 (보이는 전체 버튼 중 그리드에 없는 것, QUICK_ACTIONS 순서) */
export function moreActions(stage, ageDaysValue = null, grid = null) {
  const g = new Set(grid || gridFor(stage, ageDaysValue));
  return QUICK_ACTIONS.filter((id) => !g.has(id) && isActionVisible(id, ageDaysValue));
}

/** 이 생후 일수에 보이는 전체 버튼 (설정 > 퀵버튼 편집 목록) */
export function visibleActions(ageDaysValue = null) {
  return QUICK_ACTIONS.filter((id) => isActionVisible(id, ageDaysValue));
}

// ---------- 기록 데이터 정리 ----------
const oneOf = (v, list) => (list.some((x) => x.id === v) ? v : undefined);
const intIn = (v, [lo, hi]) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!isNum(n)) return undefined;
  const r = Math.round(n);
  return r >= lo && r <= hi ? r : undefined;
};
const str = (v, n) => {
  if (typeof v !== 'string') return undefined;
  const t = cut(v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(), n);
  return t || undefined;
};

/**
 * 종류별 data 정리 — 서버 검증(SPEC §4)과 같은 범위로 자르고, 모르는 키·빈 값은 버린다.
 * ts: 수면 끝 시각이 시작보다 앞서지 않게 할 때 사용.
 */
export function cleanData(type, data, ts = null) {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const out = {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  switch (type) {
    case 'formula': case 'pumped': case 'milk':
      set('ml', intIn(d.ml, LIMITS.ml));
      if (type !== 'milk') set('burp', oneOf(d.burp, BURP_OPTIONS));
      break;
    case 'breast':
      set('side', oneOf(d.side, BREAST_SIDES) || 'both');
      set('min', intIn(d.min, LIMITS.min));
      set('burp', oneOf(d.burp, BURP_OPTIONS));
      break;
    case 'poop':
      set('color', oneOf(d.color, POOP_COLORS));
      set('texture', oneOf(d.texture, POOP_TEXTURES));
      break;
    case 'water':
      set('ml', intIn(d.ml, LIMITS.ml));
      break;
    case 'sleep': {
      const end = typeof d.end === 'string' && d.end.trim() !== '' ? Number(d.end) : d.end;
      if (isNum(end)) set('end', Math.round(isNum(ts) ? Math.max(ts, end) : end));
      break;
    }
    case 'tummy':
      set('min', intIn(d.min, LIMITS.min));
      break;
    case 'solid': case 'meal': case 'snack':
      set('food', str(d.food, LIMITS.food));
      set('amount', oneOf(d.amount, FOOD_AMOUNTS));
      set('reaction', oneOf(d.reaction, FOOD_REACTIONS));
      break;
    case 'temp': {
      const c = typeof d.c === 'string' ? Number(d.c.replace(',', '.')) : d.c;
      if (isNum(c) && c >= LIMITS.tempC[0] && c <= LIMITS.tempC[1]) set('c', Math.round(c * 10) / 10);
      break;
    }
    case 'med':
      set('name', str(d.name, LIMITS.medName));
      set('note', str(d.note, LIMITS.medNote));
      break;
    case 'potty':
      set('result', oneOf(d.result, POTTY_RESULTS));
      break;
    case 'note':
      set('text', str(d.text, LIMITS.noteText));
      break;
    case 'thanks': case 'ack':
      set('target', str(d.target, 64));
      break;
    case 'handoff':
      if (isNum(d.from)) set('from', Math.round(d.from));
      if (isNum(d.to)) set('to', Math.round(d.to));
      break;
    default:
      break;
  }
  // 공통 선택 필드
  if (type !== 'med') set('note', str(d.note, LIMITS.note));
  if (['app', 'shortcut', 'notif', 'say'].includes(d.src)) out.src = d.src;
  return out;
}

// ---------- 기록 조회 ----------
/** 살아 있는 기록: 지우지 않았고 반응(고마워요·확인)이 아닌 것, 시각 오름차순 (복사본) */
export function live(events) {
  if (!Array.isArray(events)) return [];
  return events
    .filter((e) => e && !e.deleted && !REACTIONS.has(e.type) && isNum(e.ts))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 소변으로 세는 기록인지 (소변 + 변기 쉬 성공) */
export function isPee(e) {
  return e.type === 'pee' || (e.type === 'potty' && e.data?.result === 'pee');
}
/** 대변으로 세는 기록인지 (대변 + 변기 응가 성공) */
export function isPoop(e) {
  return e.type === 'poop' || (e.type === 'potty' && e.data?.result === 'poop');
}

function hasEnd(e) {
  return isNum(e.data?.end);
}

// 잠 구간 [시작, 끝] — 끝이 없으면 min(cap, 시작+24h)
function sleepEnd(e, cap) {
  if (hasEnd(e)) return Math.max(e.ts, e.data.end);
  return Math.max(e.ts, Math.min(cap, e.ts + NORMS.sleepOngoingMaxMin * MIN));
}

/**
 * [from, to) 구간 통계 → { feeds, formulaMl, pumpedMl, bottleMl, milkMl, breast, breastMin, pee, poop,
 *   sleepMin, sleeps, byType:{type:n}, last:{type:event} }
 * 잠은 구간과 겹치는 만큼만 센다 (자정을 넘는 잠은 양쪽 날에 나눠 들어감). 끝나지 않은 잠은
 * min(to, now) 까지 — '오늘' 통계라면 now 를 넘기거나 to=now 로 부른다.
 */
export function statsBetween(events, from, to, now = to) {
  const out = {
    feeds: 0, formulaMl: 0, pumpedMl: 0, bottleMl: 0, milkMl: 0, breast: 0, breastMin: 0,
    pee: 0, poop: 0, sleepMin: 0, sleeps: 0, byType: {}, last: {},
  };
  const cap = Math.min(to, isNum(now) ? now : to);
  for (const e of live(events)) {
    if (e.type === 'sleep') {
      const s = Math.max(e.ts, from);
      const en = Math.min(sleepEnd(e, cap), to);
      if (en > s) { out.sleepMin += (en - s) / MIN; out.sleeps += 1; }
    }
    if (e.ts < from || e.ts >= to) continue;
    out.byType[e.type] = (out.byType[e.type] || 0) + 1;
    out.last[e.type] = e;
    const ml = isNum(e.data?.ml) ? e.data.ml : 0;
    if (FEEDS.has(e.type)) out.feeds += 1;
    if (e.type === 'formula') out.formulaMl += ml;
    if (e.type === 'pumped') out.pumpedMl += ml;
    if (e.type === 'milk') out.milkMl += ml;
    if (e.type === 'breast') { out.breast += 1; out.breastMin += isNum(e.data?.min) ? e.data.min : 0; }
    if (isPee(e)) out.pee += 1;
    if (isPoop(e)) out.poop += 1;
  }
  out.bottleMl = out.formulaMl + out.pumpedMl;
  out.sleepMin = Math.round(out.sleepMin);
  return out;
}

// ---------- 수유 ----------
/** 이 단계·생후 일수의 수유 간격 {calm, soon}(분) — 생후 일수를 알면 NORMS.feedGapByAge, 아니면 stage.feedGap. 돌 이후 null */
export function feedGapFor(stage, ageDaysValue = null) {
  if (!stage || !stage.feedGap) return null;
  if (ageDaysValue != null) {
    const row = NORMS.feedGapByAge.find((r) => ageDaysValue >= r.fromDay && ageDaysValue < r.toDay);
    if (row) return { calm: row.calm, soon: row.soon };
    return null;
  }
  return { ...stage.feedGap };
}

function feedsUpTo(events, now) {
  return live(events).filter((e) => FEEDS.has(e.type) && e.ts <= now + SKEW);
}

// 30분 안에 이어진 수유를 한 번으로 묶은 '수유 시작 시각' 목록
function sessionStarts(feeds) {
  const out = [];
  let prev = null;
  for (const e of feeds) {
    if (prev === null || e.ts - prev > NORMS.feedSessionMergeMin * MIN) out.push(e.ts);
    prev = e.ts;
  }
  return out;
}

// 최근 24시간 안의 수유 간격(분), 최근 것 최대 6개
function recentGaps(starts, now) {
  const recent = starts.filter((t) => t >= now - DAY);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) gaps.push((recent[i] - recent[i - 1]) / MIN);
  return gaps.slice(-6);
}

/**
 * 다음 수유 예상 시각(epoch ms) — 최근 24시간 수유 간격(최대 6개) 평균을 이 시기 보통 간격 [calm, soon] 으로 자른 값을
 * 마지막 수유 시작에 더한다. 간격 기록이 없으면 보통 간격의 가운데. 수유 기록이 없거나 24시간보다 오래됐거나 돌 이후면 null.
 */
export function nextFeedEstimate(events, now = Date.now(), stage, ageDaysValue = null) {
  const gap = feedGapFor(stage, ageDaysValue);
  if (!gap) return null;
  const feeds = feedsUpTo(events, now);
  if (!feeds.length) return null;
  if (now - feeds[feeds.length - 1].ts > DAY) return null;
  const starts = sessionStarts(feeds);
  const gaps = recentGaps(starts, now);
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : (gap.calm + gap.soon) / 2;
  return starts[starts.length - 1] + Math.round(clamp(avg, gap.calm, gap.soon)) * MIN;
}

/**
 * 수유 카드 상태 → { last, elapsedMin, level, nextAt, avgGapMin, burpPending, gap, night, wakeHint }
 * level: 'calm'(보통 간격 이내) | 'soon'(보통 간격의 끝 무렵) | 'over'(보통 간격을 넘김) | null(색 없음: 돌 이후·기록 없음)
 *   ⚠ 'over' 는 부드러운 호박색으로만 — 빨강 금지 (RESEARCH C). 생후 1개월 이후 밤(22~06시)엔 'calm' 으로 낮춘다.
 * burpPending: 트림 단계에서 마지막 수유(90분 이내)의 트림 여부를 아직 모름 → [트림 ✓][안 함] 버튼
 * wakeHint: 신생아가 4시간 넘게 안 먹음 → HINT_COPY.wakeFeed 부드러운 안내
 * ageDays 를 넘기면 생후 일수별 간격(NORMS.feedGapByAge)을 쓴다 (권장).
 */
export function feedState(events, now = Date.now(), stage, ageDaysValue = null) {
  const feeds = feedsUpTo(events, now);
  const last = feeds.length ? feeds[feeds.length - 1] : null;
  const gap = feedGapFor(stage, ageDaysValue);
  const night = isNight(now);
  const out = { last, elapsedMin: null, level: null, nextAt: null, avgGapMin: null, burpPending: false, gap, night, wakeHint: false };
  if (!last) return out;
  const elapsed = Math.max(0, Math.floor((now - last.ts) / MIN));
  out.elapsedMin = elapsed;
  const gaps = recentGaps(sessionStarts(feeds), now);
  out.avgGapMin = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
  out.nextAt = nextFeedEstimate(events, now, stage, ageDaysValue);
  if (gap && elapsed < DAY / MIN) {
    out.level = elapsed <= gap.calm ? 'calm' : elapsed <= gap.soon ? 'soon' : 'over';
    if (night && stage?.nightQuiet && out.level !== 'calm') out.level = 'calm';
  }
  if (stage?.burp && last.data?.burp == null && elapsed <= NORMS.burpWindowMin) {
    const burpedAfter = live(events).some((e) => e.type === 'burp' && e.ts >= last.ts && e.ts <= now + SKEW);
    out.burpPending = !burpedAfter;
  }
  const newborn = ageDaysValue != null ? ageDaysValue < 28 : stage?.id === 'newborn';
  out.wakeHint = newborn && elapsed >= NORMS.newbornWakeFeedMin && elapsed < 12 * 60;
  return out;
}

/** 최근 ml (종류별 마지막 기록의 양 — 분유 시트 기본값). 없으면 null */
export function lastMl(events, type) {
  const list = live(events);
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type === type && isNum(list[i].data?.ml)) return list[i].data.ml;
  }
  return null;
}

/** ml 칩 목록 (단계별 + 최근 양이 칩에 없으면 끼워 넣음, 오름차순) */
export function amountChips(stage, type, last = null) {
  const base = type === 'water' ? AMOUNT_CHIPS.water : (AMOUNT_CHIPS[stage?.id] || AMOUNT_CHIPS.hundred);
  const set = new Set(base);
  if (isNum(last) && last >= LIMITS.ml[0] && last <= LIMITS.ml[1]) set.add(Math.round(last));
  return [...set].sort((a, b) => a - b);
}

// ---------- 기저귀 · 잠 ----------
/** 기저귀 카드 → { lastPee, lastPoop, todayPee, todayPoop, peeMin, poopMin } (변기 성공 포함, 오늘 = 로컬 날짜) */
export function diaperState(events, now = Date.now()) {
  const from = startOfDay(now);
  const to = addDaysTs(now, 1);
  let lastPee = null, lastPoop = null, todayPee = 0, todayPoop = 0;
  for (const e of live(events)) {
    if (e.ts > now + SKEW) continue;
    if (isPee(e)) { lastPee = e; if (e.ts >= from && e.ts < to) todayPee++; }
    if (isPoop(e)) { lastPoop = e; if (e.ts >= from && e.ts < to) todayPoop++; }
  }
  const since = (e) => (e ? Math.max(0, Math.floor((now - e.ts) / MIN)) : null);
  return { lastPee, lastPoop, todayPee, todayPoop, peeMin: since(lastPee), poopMin: since(lastPoop) };
}

/**
 * 수면 카드 → { ongoing, ongoingAll, elapsedMin, last, stale }
 * ongoing: 끝나지 않은 잠(24시간 이내) 중 가장 먼저 시작한 것 — 두 기기가 따로 '재우기'를 눌러도 아기 잠은 하나.
 *   ongoingAll: 끝나지 않은 잠 전부 → '깼어요'는 모두에 end 를 넣어야 한다 (store.toggleSleep 가 그렇게 함).
 * elapsedMin: 자는 중이면 잠든 지, 아니면 마지막 잠 끝난 뒤 깨어 있는 시간(분). 기록 없으면 null.
 * last: 끝난 잠 중 가장 늦게 끝난 것. stale: 24시간 넘게 안 끝난 잠(끝 시각을 고쳐 달라고 안내할 때).
 */
export function sleepState(events, now = Date.now()) {
  const sleeps = live(events).filter((e) => e.type === 'sleep' && e.ts <= now + SKEW);
  const open = sleeps.filter((e) => !hasEnd(e));
  const ongoingAll = open.filter((e) => now - e.ts < NORMS.sleepOngoingMaxMin * MIN);
  const stale = open.filter((e) => now - e.ts >= NORMS.sleepOngoingMaxMin * MIN);
  let last = null;
  for (const e of sleeps) if (hasEnd(e) && e.data.end <= now + SKEW && (!last || e.data.end >= last.data.end)) last = e;
  const ongoing = ongoingAll[0] || null;
  let elapsedMin = null;
  if (ongoing) elapsedMin = Math.max(0, Math.floor((now - ongoing.ts) / MIN));
  else if (last) elapsedMin = Math.max(0, Math.floor((now - last.data.end) / MIN));
  return { ongoing, ongoingAll, elapsedMin, last, stale };
}

// ---------- 미션 · 연속 기록 · 도감 ----------
function passFilter(filter, e) {
  switch (filter) {
    case 'poopColor': return e.type === 'poop' && !!e.data?.color;
    case 'burpChecked': return e.type === 'burp' || (FEEDS.has(e.type) && (e.data?.burp === 'yes' || e.data?.burp === 'no'));
    case 'nightFeed': return FEEDS.has(e.type) && isNight(e.ts);
    case 'pottySuccess': return e.type === 'potty' && (e.data?.result === 'pee' || e.data?.result === 'poop');
    case 'tummy': return e.type === 'tummy';
    case 'reaction': return !!e.data?.reaction;
    default: return true;
  }
}

/**
 * 오늘의 팀 미션 → [{ id, label, emoji, count, target, done }] — 가족 전체 합계, 오늘 = now 의 로컬 날짜.
 * count 는 target 에서 멈춘다 (화면 표시 '3/3').
 */
export function quests(stage, events, now = Date.now()) {
  if (!stage || !Array.isArray(stage.quests)) return [];
  const from = startOfDay(now);
  const to = addDaysTs(now, 1);
  const today = (Array.isArray(events) ? events : []).filter((e) => e && !e.deleted && isNum(e.ts) && e.ts >= from && e.ts < to);
  return stage.quests.map((q) => {
    const n = today.filter((e) => q.types.includes(e.type) && passFilter(q.filter, e)).length;
    return { id: q.id, label: q.label, emoji: q.emoji, count: Math.min(n, q.count), target: q.count, done: n >= q.count };
  });
}

function activeDays(events) {
  return new Set(live(events).map((e) => dayOrd(e.ts)));
}

/** 가족 연속 기록 일수 — 오늘(없으면 어제)부터 거꾸로 기록이 1개 이상 있는 날 수. 하루 쉬면 0 (벌점 없음, UI는 '쉬어가도 괜찮아요') */
export function streakDays(events, now = Date.now()) {
  const days = activeDays(events);
  let d = dayOrd(now);
  if (!days.has(d)) d -= 1;
  let n = 0;
  while (days.has(d)) { n++; d--; }
  return n;
}

/** 가장 길었던 연속 기록 일수 (도감 '함께 N일'은 한 번 달성하면 유지) */
export function longestStreak(events) {
  const days = [...activeDays(events)].sort((a, b) => a - b);
  let best = 0, run = 0, prev = null;
  for (const d of days) {
    run = prev !== null && d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/** 획득한 도감 카드 id 집합 — 기록에서 매번 계산 (저장하지 않음). '새 카드'는 prefs.seenBadges 와 비교 */
export function earnedBadges({ events = [], members = [], family = {}, now = Date.now(), prefs = {} } = {}) {
  const got = new Set();
  const lv = live(events);
  const all = (Array.isArray(events) ? events : []).filter((e) => e && !e.deleted);
  const active = (members || []).filter((m) => m && !m.revoked);
  const age = ageDays(family?.birth, now);
  const birth = parseBirth(family?.birth);
  if (lv.length >= 1) got.add('first-log');
  if (active.length >= 2) got.add('team');
  if (active.some((m) => ['sitter', 'grandma', 'grandpa'].includes(m.role))) got.add('support');
  if (all.some((e) => e.type === 'thanks')) got.add('first-thanks');
  if (lv.some((e) => e.type === 'handoff')) got.add('first-baton');
  if (lv.some((e) => ['shortcut', 'notif', 'say'].includes(e.data?.src))) got.add('lockscreen');
  const best = longestStreak(events);
  if (best >= 7) got.add('streak-7');
  if (best >= 30) got.add('streak-30');
  if (best >= 100) got.add('streak-100');
  if (lv.length >= 100) got.add('logs-100');
  if (lv.length >= 1000) got.add('logs-1000');
  if (lv.some((e) => e.type === 'sleep' && hasEnd(e) && e.data.end - e.ts >= NORMS.fullNightSleepMin * MIN && e.data.end - e.ts <= DAY)) got.add('first-night');
  // 백일: 태어난 날을 1일로 세는 우리 관습 → 생후 99일(0일 기준)이 100일째
  if (age != null && age >= 99) got.add('day-100');
  if (lv.some((e) => e.type === 'solid')) got.add('first-solid');
  if (lv.some((e) => e.type === 'brush')) got.add('first-brush');
  if (birth && now >= addMonths(birth, 12).getTime()) got.add('birthday-1');
  if (birth && now >= addMonths(birth, 24).getTime()) got.add('birthday-2');
  if (lv.some((e) => e.type === 'potty' && (e.data?.result === 'pee' || e.data?.result === 'poop'))) got.add('potty-first');
  void prefs;
  return got;
}

/** 아직 안 본 도감 카드 id 목록 (BADGES 순서) */
export function newBadges(earned, prefs = {}) {
  const seen = new Set(prefs?.seenBadges || []);
  return BADGES.filter((b) => earned.has(b.id) && !seen.has(b.id)).map((b) => b.id);
}

// ---------- 팀 카드 · 고마워요 ----------
/** 이 기록에 고마워요를 보낸 구성원 id 목록 (중복 없이, 보낸 순서) */
export function thanksFor(events, eventId) {
  return reactorsFor(events, eventId, 'thanks');
}
/** 이 바통(handoff)에 '받았어요'를 누른 구성원 id 목록 */
export function acksFor(events, eventId) {
  return reactorsFor(events, eventId, 'ack');
}
function reactorsFor(events, eventId, type) {
  const out = [];
  for (const e of (Array.isArray(events) ? events : []).filter((x) => x && !x.deleted && x.type === type && x.data?.target === eventId).sort((a, b) => a.ts - b.ts)) {
    const who = e.by ?? null;
    if (!out.includes(who)) out.push(who);
  }
  return out;
}

/** 멤버 표시 이름 (이름 없으면 역할 이름, 멤버를 모르면 '누군가') */
export function memberName(member) {
  if (!member) return '누군가';
  return member.name || ROLE_BY_ID[member.role]?.label || '가족';
}

/** 멤버 이모지 (없으면 역할 이모지) */
export function memberEmoji(member) {
  if (!member) return '🙂';
  return member.emoji || ROLE_BY_ID[member.role]?.emoji || '🙂';
}

/** 멤버 띠 색 — 역할 색, 같은 역할이 앞에 있으면 팔레트에서 다음 색 */
export function memberColor(member, members = []) {
  if (!member) return '#B0A396';
  const role = ROLE_BY_ID[member.role] || ROLE_BY_ID.other;
  const list = (members || []).filter((m) => m && !m.revoked);
  const idx = list.findIndex((m) => m.id === member.id);
  const sameBefore = idx > 0 ? list.slice(0, idx).filter((m) => m.role === member.role).length : 0;
  if (!sameBefore) return role.color;
  const used = new Set(list.map((m) => (ROLE_BY_ID[m.role] || ROLE_BY_ID.other).color));
  const free = MEMBER_COLORS.filter((c) => !used.has(c));
  const pool = free.length ? free : MEMBER_COLORS;
  return pool[(sameBefore - 1) % pool.length];
}

/**
 * 팀 카드 (RESEARCH A: 사람별 횟수·순위 없음 — 가족 합계와 고마움만)
 * → { total, night, thanks, weekThanks, lastThanksToMe: { thanks, from, target, text } | null }
 *   total: [from,to) 우리 팀 기록 수 · night: 그중 밤(22~06시) 기록 수(가족 합계)
 *   thanks: [from,to) 주고받은 고마워요 수 · weekThanks: to 기준 최근 7일 고마워요 수
 *   lastThanksToMe: 최근 7일 안에 다른 사람이 '내 기록'에 보낸 마지막 고마워요 ("💛 엄마가 새벽 3:10 수유에 고마워했어요")
 */
export function team(events, members, from, to, meId = null) {
  const all = (Array.isArray(events) ? events : []).filter((e) => e && !e.deleted && isNum(e.ts));
  const lv = live(events).filter((e) => e.ts >= from && e.ts < to);
  const thanks = all.filter((e) => e.type === 'thanks');
  const out = {
    total: lv.length,
    night: lv.filter((e) => isNight(e.ts)).length,
    thanks: thanks.filter((e) => e.ts >= from && e.ts < to).length,
    weekThanks: thanks.filter((e) => e.ts >= to - 7 * DAY && e.ts < to).length,
    lastThanksToMe: null,
  };
  if (meId) {
    const byId = new Map(all.map((e) => [e.id, e]));
    const mine = thanks
      .filter((t) => t.by !== meId && t.ts >= to - 7 * DAY && t.ts < to)
      .map((t) => ({ t, target: byId.get(t.data?.target) }))
      .filter((x) => x.target && x.target.by === meId)
      .sort((a, b) => a.t.ts - b.t.ts)
      .pop();
    if (mine) {
      const fromM = (members || []).find((m) => m.id === mine.t.by) || null;
      const what = FEEDS.has(mine.target.type) ? '수유' : typeMeta(mine.target.type).label;
      out.lastThanksToMe = {
        thanks: mine.t, from: fromM, target: mine.target,
        text: `💛 ${josa(memberName(fromM), '이/가')} ${fmtTimeSoft(mine.target.ts)} ${what}에 고마워했어요`,
      };
    }
  }
  return out;
}

// ---------- 안내 힌트 ----------
/** 대변 색 안내 → null | { level:'info'|'check'|'urgent', text } (흰색·회색 = urgent, 피·태변 이후 검정 = check, 태변·초록 = info) */
export function poopAlert(event, ageDaysValue = null) {
  if (!event || event.type !== 'poop') return null;
  const c = event.data?.color;
  if (c === 'pale') return { level: 'urgent', text: `${HINT_COPY.poopPale} · ${HINT_COPY.poopScreen}` };
  if (c === 'red') return { level: 'check', text: HINT_COPY.poopRed };
  if (c === 'black') {
    if (ageDaysValue != null && ageDaysValue <= NORMS.meconiumOkDays) return { level: 'info', text: HINT_COPY.poopMeconium };
    return { level: 'check', text: HINT_COPY.poopRed };
  }
  if (c === 'green') return { level: 'info', text: HINT_COPY.poopGreen };
  return null;
}

const LEVEL_RANK = { urgent: 0, check: 1, info: 2 };

/**
 * 부드러운 참고 힌트 → [{ id, level:'info'|'check'|'urgent', text, link? }] (급한 것 먼저)
 * - 대변 색(48시간 이내 마지막 색 기록) · 생후 3개월 미만 38℃ 이상 = urgent
 * - 신생아 4시간 수유 공백 · 소변 기저귀 적음(기록이 꾸준할 때만) · 8시간 소변 없음(그 뒤 다른 기록 3개 이상일 때만)
 * - 분유 하루 960ml 초과 · 6개월 전 물 · 돌 전 우유 / 우유 500ml 초과 · 수유 간격이 보통보다 김(밤 제외)
 */
export function hints(stage, events, now = Date.now(), family = {}) {
  const out = [];
  const age = ageDays(family?.birth, now);
  const lv = live(events).filter((e) => e.ts <= now + MIN);
  const add = (id, level, text, link) => out.push(link ? { id, level, text, link } : { id, level, text });

  // 대변 색
  const lastColored = [...lv].reverse().find((e) => e.type === 'poop' && e.data?.color);
  if (lastColored && now - lastColored.ts <= 48 * HOUR) {
    const a = poopAlert(lastColored, age);
    if (a) add('poop-color', a.level, a.text);
  }
  // 체온
  const lastTemp = [...lv].reverse().find((e) => e.type === 'temp' && isNum(e.data?.c));
  if (lastTemp && now - lastTemp.ts <= 24 * HOUR && lastTemp.data.c >= NORMS.feverC) {
    if (age != null && age < NORMS.feverUrgentUnderDays) add('fever', 'urgent', HINT_COPY.feverInfant, '../fever/');
    else add('fever', 'info', HINT_COPY.fever, '../fever/');
  }
  // 수유 공백
  const fs = feedState(events, now, stage, age);
  if (fs.wakeHint) add('wake-feed', 'check', HINT_COPY.wakeFeed);
  else if (fs.level === 'over' && fs.gap && !(fs.night && stage?.nightQuiet)) {
    add('feed-gap', 'info', fill(HINT_COPY.feedGap, {
      elapsed: fmtElapsed(fs.elapsedMin),
      a: fmtHours(fs.gap.calm), b: fmtHours(fs.gap.soon),
    }));
  }
  // 소변 기저귀 개수 (생후 2개월까지, 기록이 꾸준할 때만)
  const last24 = lv.filter((e) => e.ts > now - DAY && e.ts <= now);
  const loggingActive = last24.length >= NORMS.activeLogMin24h && lv.length > 0 && lv[0].ts <= now - DAY;
  if (age != null && age < NORMS.wetCheckUntilDay && loggingActive) {
    const dol = age + 1;   // 생후 일째 (1일째 = 첫 24시간)
    const minWet = age >= 42 ? NORMS.wetMinAfter6w : NORMS.wetMinByDayOfLife[Math.min(dol, 5) - 1];
    const wet = last24.filter(isPee).length;
    if (wet < minWet) add('wet-low', 'check', fill(HINT_COPY.wetLow, { n: wet, min: minWet }));
  }
  // 8시간 소변 없음
  const lastPee = [...lv].reverse().find(isPee);
  if (lastPee && now - lastPee.ts >= NORMS.noPeeHours * HOUR && now - lastPee.ts < 3 * DAY) {
    const others = lv.filter((e) => e.ts > lastPee.ts && e.ts <= now).length;
    if (others >= NORMS.noPeeMinOtherLogs) add('no-pee', 'check', HINT_COPY.noPee);
  }
  // 오늘 분유·물·우유
  const today = statsBetween(events, startOfDay(now), addDaysTs(now, 1), now);
  if (today.formulaMl > NORMS.formulaDailyHintMl) add('formula-max', 'info', fill(HINT_COPY.formulaMax, { n: fmtNum(today.formulaMl) }));
  if (age != null && age < NORMS.waterFromDay && today.byType.water) add('water-early', 'info', HINT_COPY.waterEarly);
  if (age != null && age < NORMS.milkFromDay && today.byType.milk) add('milk-early', 'info', HINT_COPY.milkEarly);
  else if (today.milkMl > NORMS.milkMaxMl) add('milk-much', 'info', fill(HINT_COPY.milkMuch, { n: fmtNum(today.milkMl) }));

  return out.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

// ---------- 표시 형식 ----------
/** '오후 2:32' (자정 = '오전 12:05', 정오 = '오후 12:30') */
export function fmtTime(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h < 12 ? '오전' : '오후'} ${h12}:${pad2(d.getMinutes())}`;
}

/** 0~5시는 '새벽 3:10', 나머지는 fmtTime 과 같음 (고마워요 문장용) */
export function fmtTimeSoft(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  if (h < 6) return `새벽 ${h === 0 ? 12 : h}:${pad2(d.getMinutes())}`;
  return fmtTime(ts);
}

/** '14:32' (24시간제, 두 자리) */
export function fmtHM(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 경과 시간: '방금' / '45분' / '2시간' / '2시간 10분' / '1일 3시간' (UI가 '전'을 붙인다) */
export function fmtElapsed(min) {
  if (min == null || !Number.isFinite(min)) return '';
  const m = Math.max(0, Math.floor(min));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return r ? `${h}시간 ${r}분` : `${h}시간`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}일 ${rh}시간` : `${d}일`;
}

/** 진행 타이머: '1:12' (시:분), 40분 → '0:40' */
export function fmtDur(min) {
  if (min == null || !Number.isFinite(min)) return '0:00';
  const m = Math.max(0, Math.floor(min));
  return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
}

/** 시간 수(분 → '2', '2.5', '3.5') — '보통 {a}~{b}시간마다' 문구용 */
export function fmtHours(min) {
  const h = Math.round((min / 60) * 10) / 10;
  return String(h);
}

/** '9/28(월)' */
export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

const labelOf = (list, id) => list.find((x) => x.id === id)?.label;
const burpShort = (b) => BURP_OPTIONS.find((x) => x.id === b)?.short;
const burpPlain = (b) => BURP_OPTIONS.find((x) => x.id === b)?.plain;

/**
 * 기록 한 줄 내용 (종류 이름·시각·사람 제외): '120ml · 트림 ✓', '왼쪽 10분', '노랑 · 묽음', '~15:20 · 1시간 10분',
 * '38.2℃', '쉬 성공 🎉'. 내용이 없으면 ''.
 */
export function describe(event) {
  if (!event) return '';
  const d = event.data || {};
  const parts = [];
  switch (event.type) {
    case 'formula': case 'pumped': case 'milk': case 'water':
      if (isNum(d.ml)) parts.push(`${d.ml}ml`);
      if (burpShort(d.burp)) parts.push(burpShort(d.burp));
      break;
    case 'breast':
      parts.push(`${labelOf(BREAST_SIDES, d.side) || '양쪽'}${isNum(d.min) ? ` ${d.min}분` : ''}`);
      if (burpShort(d.burp)) parts.push(burpShort(d.burp));
      break;
    case 'poop':
      if (labelOf(POOP_COLORS, d.color)) parts.push(labelOf(POOP_COLORS, d.color));
      if (labelOf(POOP_TEXTURES, d.texture)) parts.push(labelOf(POOP_TEXTURES, d.texture));
      break;
    case 'sleep':
      if (hasEnd(event)) {
        parts.push(`~${fmtHM(d.end)}`);
        parts.push(fmtElapsed((d.end - event.ts) / MIN) || '0분');
      } else parts.push('자는 중');
      break;
    case 'tummy':
      if (isNum(d.min)) parts.push(`${d.min}분`);
      break;
    case 'solid': case 'meal': case 'snack':
      if (d.food) parts.push(d.food);
      if (labelOf(FOOD_AMOUNTS, d.amount)) parts.push(labelOf(FOOD_AMOUNTS, d.amount));
      if (labelOf(FOOD_REACTIONS, d.reaction)) parts.push(labelOf(FOOD_REACTIONS, d.reaction));
      break;
    case 'temp':
      if (isNum(d.c)) parts.push(`${d.c.toFixed(1)}℃`);
      break;
    case 'med':
      if (d.name) parts.push(d.name);
      if (d.note) parts.push(d.note);
      break;
    case 'potty': {
      const r = POTTY_RESULTS.find((x) => x.id === d.result);
      if (r) parts.push(r.success ? `${r.label} ${r.emoji}` : r.label);
      break;
    }
    case 'note':
      if (d.text) parts.push(Array.from(d.text).length > 40 ? `${cut(d.text, 40)}…` : d.text);
      break;
    case 'handoff':
      if (isNum(d.from) && isNum(d.to)) parts.push(`${fmtHM(d.from)}~${fmtHM(d.to)}`);
      break;
    case 'thanks':
      parts.push('💛 고마워요');
      break;
    case 'ack':
      parts.push('확인 ✓');
      break;
    default:
      break;
  }
  return parts.join(' · ');
}

// ---------- 교대 요약 ----------
// 카카오톡에 붙여 넣는 평문. 가장 중요한 줄(지금 상태)이 먼저, 15줄 이내, 오전/오후, 사람별 횟수 없음 (RESEARCH B)
function feedPlain(e) {
  const d = e.data || {};
  const label = typeMeta(e.type).label;
  let s;
  if (e.type === 'breast') s = `${label} ${labelOf(BREAST_SIDES, d.side) || '양쪽'}${isNum(d.min) ? ` ${d.min}분` : ''}`;
  else s = `${label}${isNum(d.ml) ? ` ${d.ml}ml` : ''}`;
  return burpPlain(d.burp) ? `${s} · ${burpPlain(d.burp)}` : s;
}

function diaperPlain(e, all) {
  if (e.type === 'potty') return labelOf(POTTY_RESULTS, e.data?.result) || '변기';
  const pair = all.some((x) => x !== e && x.ts === e.ts && (e.type === 'pee' ? x.type === 'poop' : x.type === 'pee'));
  if (pair) {
    const poop = e.type === 'poop' ? e : all.find((x) => x.ts === e.ts && x.type === 'poop');
    const c = labelOf(POOP_COLORS, poop?.data?.color);
    return c ? `소변+대변 ${c}` : '소변+대변';
  }
  if (e.type === 'pee') return '소변';
  return labelOf(POOP_COLORS, e.data?.color) || '대변';
}

function roundTo5(ts) {
  return Math.round(ts / (5 * MIN)) * 5 * MIN;
}

function fmtRange(from, to) {
  if (dayKey(from) === dayKey(to)) return `${fmtDate(from)} ${fmtTime(from)}~${fmtTime(to)}`;
  return `${fmtDate(from)} ${fmtTime(from)}~${fmtDate(to)} ${fmtTime(to)}`;
}

/**
 * 교대 요약 텍스트 (RESEARCH B 형식). 범위가 3시간 이하면 한 줄 짧은 버전('[새벽 교대] …').
 * @param {{family, members, events, from, to, now?, stage?, ageDays?}} p
 */
export function handoffText({ family = {}, members = [], events = [], from, to, now = to, stage = null, ageDays: ad = null } = {}) {
  void members;   // 사람별 횟수는 넣지 않는다 (RESEARCH A)
  const name = (family?.name || '').trim() || '우리 아기';
  const age = ad ?? ageDays(family?.birth, now);
  const st = stage || stageFor(family?.birth, now).stage;
  const lvAll = live(events).filter((e) => e.ts <= now + MIN);
  const inRange = lvAll.filter((e) => e.ts >= from && e.ts < to);
  const fs = feedState(events, now, st, age);
  const sl = sleepState(events, now);
  const lastFeed = fs.last && now - fs.last.ts <= DAY ? fs.last : null;
  const nextTxt = (fmt) => {
    if (!fs.nextAt) return null;
    return fs.nextAt <= now ? '지금쯤' : `${fmt(roundTo5(fs.nextAt))}쯤`;
  };
  const medsTemps = inRange.filter((e) => e.type === 'med' || (e.type === 'temp' && isNum(e.data?.c)));
  const mtText = (fmt) => medsTemps.slice(-4).map((e) => (e.type === 'temp'
    ? `${fmt(e.ts)} ${e.data.c.toFixed(1)}℃`
    : `${fmt(e.ts)} ${e.data?.name || '약'}`)).join(' · ');
  const notes = inRange.filter((e) => e.type === 'note' && e.data?.text).map((e) => e.data.text);
  const noteText = notes.length ? cut(notes.join(' / '), 120) : '';
  const diapers = lvAll.filter((e) => isPee(e) || isPoop(e) || e.type === 'potty');

  // ── 짧은 버전 (≤ 3시간: 밤중 교대 등) ──
  if (to - from <= 3 * HOUR) {
    const h = new Date(now).getHours();
    const label = h < 6 ? '새벽' : h >= 21 ? '밤' : name;
    const parts = [];
    if (lastFeed) parts.push(`마지막 수유 ${fmtHM(lastFeed.ts)} · ${feedPlain(lastFeed)}`);
    const lastD = diapers.filter((e) => now - e.ts <= DAY).pop();
    if (lastD) parts.push(`기저귀 ${fmtHM(lastD.ts)} ${diaperPlain(lastD, lvAll)}`);
    if (sl.ongoing) parts.push(`지금 자는 중 (${fmtElapsed(sl.elapsedMin)}째)`);
    if (medsTemps.length) parts.push(`약/체온 ${mtText(fmtHM)}`);
    const nx = nextTxt(fmtHM);
    if (nx) parts.push(`다음 수유 ${nx}`);
    if (noteText) parts.push(`메모: ${cut(noteText, 40)}`);
    if (!parts.length) parts.push('기록 없음');
    return `[${label} 교대] ${parts.join(' / ')}`;
  }

  // ── 기본 버전 ──
  const s = statsBetween(events, from, to, now);
  const lines = [`[${name} 교대 요약] ${fmtRange(from, to)}`];

  // 1) 지금
  if (sl.ongoing) {
    const sh = new Date(sl.ongoing.ts).getHours();
    const what = sh >= 7 && sh < 19 ? '낮잠 중' : '자는 중';
    const el = sl.elapsedMin >= 1 ? `${fmtElapsed(sl.elapsedMin)}째` : '방금 잠들었어요';
    lines.push(`지금: ${fmtTime(sl.ongoing.ts)}부터 ${what} (${el})`);
  } else if (sl.last) {
    lines.push(`지금: 깨어 있어요 (마지막 잠 ${fmtTime(sl.last.data.end)} 끝)`);
  } else {
    lines.push('지금: 깨어 있어요');
  }
  // 2) 다음 수유
  if (lastFeed) {
    const lastTxt = `마지막 ${fmtTime(lastFeed.ts)} · ${feedPlain(lastFeed)}`;
    const nx = nextTxt(fmtTime);
    lines.push(nx ? `다음 수유 예상: ${nx} (${lastTxt})` : `마지막 수유: ${lastTxt.replace(/^마지막 /, '')}`);
  }
  // 3) 수유
  if (s.feeds || st?.feedGap) {
    const p = [];
    if (s.feeds) {
      p.push(`${s.feeds}회`);
      if (s.formulaMl) p.push(`분유 총 ${fmtNum(s.formulaMl)}ml`);
      if (s.pumpedMl) p.push(`유축 총 ${fmtNum(s.pumpedMl)}ml`);
      if (s.breast) p.push(`모유 ${s.breast}회`);
    }
    lines.push(`수유: ${p.length ? p.join(' · ') : '없음'}`);
  }
  // 4) 식사 (이유식·식사·간식·우유·물) — 있을 때만
  const foodTypes = ['solid', 'meal', 'snack'];
  const foods = inRange.filter((e) => foodTypes.includes(e.type));
  const fp = [];
  for (const t of foodTypes) if (s.byType[t]) fp.push(`${typeMeta(t).label} ${s.byType[t]}번`);
  if (s.milkMl) fp.push(`우유 ${fmtNum(s.milkMl)}ml`);
  else if (s.byType.milk) fp.push(`우유 ${s.byType.milk}번`);
  const waterMl = inRange.filter((e) => e.type === 'water').reduce((a, e) => a + (isNum(e.data?.ml) ? e.data.ml : 0), 0);
  if (waterMl) fp.push(`물 ${fmtNum(waterMl)}ml`);
  else if (s.byType.water) fp.push(`물 ${s.byType.water}번`);
  if (fp.length) {
    const lf = foods[foods.length - 1];
    const det = lf ? describe(lf) : '';
    lines.push(`식사: ${fp.join(' · ')}${lf ? ` (마지막 ${fmtTime(lf.ts)}${det ? ` · ${det}` : ''})` : ''}`);
  }
  // 5) 기저귀 (+ 대변 색 경고)
  const dIn = diapers.filter((e) => e.ts >= from && e.ts < to && (isPee(e) || isPoop(e)));
  if (s.pee || s.poop) {
    const lastD = dIn[dIn.length - 1];
    lines.push(`기저귀: 소변 ${s.pee} · 대변 ${s.poop}${lastD ? ` (마지막 ${fmtTime(lastD.ts)} · ${diaperPlain(lastD, lvAll)})` : ''}`);
  } else {
    lines.push('기저귀: 기록 없음');
  }
  const worst = inRange.filter((e) => e.type === 'poop')
    .map((e) => ({ e, a: poopAlert(e, age) }))
    .filter((x) => x.a && x.a.level !== 'info')
    .sort((x, y) => LEVEL_RANK[x.a.level] - LEVEL_RANK[y.a.level])[0];
  if (worst) lines.push(`⚠ 대변 색 확인 필요: ${fmtTime(worst.e.ts)} ${labelOf(POOP_COLORS, worst.e.data.color)}`);
  // 6) 변기 (배변훈련)
  const pot = inRange.filter((e) => e.type === 'potty');
  if (pot.length) {
    const ok = pot.filter((e) => e.data?.result === 'pee' || e.data?.result === 'poop').length;
    const tr = pot.filter((e) => e.data?.result === 'try').length;
    const ac = pot.filter((e) => e.data?.result === 'accident').length;
    lines.push(`변기: 성공 ${ok} · 시도 ${tr} · 실수 ${ac}`);
  }
  // 7) 잠
  lines.push(s.sleeps ? `잠: ${s.sleeps}번 · 총 ${fmtElapsed(s.sleepMin)}` : '잠: 기록 없음');
  // 8) 약/체온 (중복 투약 방지 — 시각과 이름)
  lines.push(`약/체온: ${medsTemps.length ? mtText(fmtTime) : '없음'}`);
  // 9) 특이사항
  if (noteText) lines.push(`특이사항: ${noteText}`);
  lines.push('- uridaylog 함께 육아일지');
  return lines.join('\n');
}

// ---------- CSV ----------
function csvCell(v) {
  let s = v == null ? '' : String(v);
  // 스프레드시트 수식 주입 방지 (=, +, -, @ 로 시작하면 앞에 ' )
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** CSV 내보내기 문자열 (UTF-8 BOM + 헤더 '날짜,시간,종류,내용,누가,메모', 줄바꿈 CRLF, 기록마다 한 줄) */
export function toCSV(events, members = []) {
  const byId = new Map((members || []).map((m) => [m.id, m]));
  const rows = [['날짜', '시간', '종류', '내용', '누가', '메모']];
  for (const e of live(events)) {
    const m = byId.get(e.by);
    const note = e.type === 'note' ? '' : (e.type === 'med' ? '' : e.data?.note || '');
    const content = e.type === 'note' ? (e.data?.text || '') : describe(e);
    rows.push([dayKey(e.ts), fmtHM(e.ts), typeMeta(e.type).label, content, m ? memberName(m) : '', note]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
