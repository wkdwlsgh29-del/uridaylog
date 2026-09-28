// ============================================================
// '함께 육아일지' 화면 컨트롤러 — 렌더 + 이벤트 + PWA 설치 + 잠금화면 안내
// · 계산은 logic.js, 저장은 store.js, 공유·서비스워커 연결은 sync.js — 여기서 다시 구현하지 않는다.
// · 새벽 3시 한 손: 퀵 그리드 한 번 탭 = 기록 + 되돌리기 토스트. 무거운 다시 그리기는 기록할 때만,
//   30초 타이머는 경과 시간 글자만 바꾼다.
// · 사용자·가족이 입력한 글(이름·메모·음식)은 전부 esc() 로 이스케이프 — 공유 가족의 데이터가 섞여 들어온다.
// · 게임 요소는 협동만 (RESEARCH A): 사람별 횟수·순위는 어디에도 그리지 않는다.
// ============================================================

import { BRAND } from '../shared/js/brand.js';
import { parseDate, today, toISO, ageText, addMonths } from '../shared/js/date-utils.js';
import {
  LOG_META, ROLES, ROLE_BY_ID, EVENT_TYPES, ACTION_META, QUICK_ACTIONS, STAGES, BADGES,
  POOP_COLORS, POOP_TEXTURES, BREAST_SIDES, BURP_OPTIONS, FOOD_AMOUNTS, FOOD_REACTIONS, POTTY_RESULTS,
  BREAST_MIN_CHIPS, TUMMY_MIN_CHIPS, TIME_AGO_CHIPS, AMOUNT_STEP, LIMITS, NAME_PLACEHOLDER,
  HINT_COPY, SAFE_SLEEP, DISCLAIMER, STORAGE_NOTE, FEED_TYPES, NORMS,
} from './log-data.js';
import {
  stageFor, gridFor, visibleActions, live, statsBetween, feedState, diaperState, sleepState,
  quests, streakDays, earnedBadges, newBadges, team, hints, handoffText, toCSV, describe, fmtTime, fmtHM,
  fmtElapsed, fmtDur, fmtDate, fmtNum, typeMeta, memberName, memberEmoji, memberColor, lastMl, amountChips,
  startOfDay, addDaysTs, dayKey, poopAlert,
} from './logic.js';
import {
  KEY, load, save, wipe, setupFamily, updateFamily, upsertMember, me, memberById, setMe, eventById, addEvent,
  updateEvent, deleteEvent, restoreEvent, logAction, undoAction, absorb, normalizeState, defaultState,
} from './store.js';
import {
  canShare, createFamily, peekInvite, joinFamily, rotateInvite, removeMember, setAdmin, unlinkMember,
  createDeviceLink, leaveFamily, inviteLink, parseJoin, quickUrl, swConfig, writeSwConfig, clearSwData,
  startAutoSync, ERROR_COPY,
} from './sync.js';

const MIN = 60000;
const HOUR = 3600000;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => String(n).padStart(2, '0');

// ---------- 환경 감지 ----------
const UA = navigator.userAgent;
const isInApp = /Instagram|KAKAOTALK|NAVER|FBAV|FBAN|Line\//i.test(UA);
const isIOS = /iPhone|iPad|iPod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/i.test(UA);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// 알림 버튼(잠금화면 빠른 기록): 아이폰 웹앱은 알림 버튼을 지원하지 않는다 (RESEARCH §4)
const notifActionsOk = () => !isIOS && 'Notification' in window && 'serviceWorker' in navigator
  && (Notification.maxActions === undefined || Notification.maxActions >= 2);
// 알림 버튼 후보 — 잠 토글은 서버 없이(오프라인 수신함) 정확히 켜고 끌 수 없어서 뺀다
const NOTIF_TYPES = ['pee', 'poop', 'both', 'formula', 'pumped', 'burp', 'bath', 'tummy'];

// ---------- 상태 ----------
let state = load();
let autosync = null;
const ui = {
  tab: 'today', extraDays: 0, lastDay: '', lastNowSig: '', installPrompt: null, swReg: null,
  undoTimer: null, undo: null, tapAt: {},
};

function isSetUp() {
  return !!(state.meId && memberById(state, state.meId));
}

function ctx(t = Date.now()) {
  const st = stageFor(state.family.birth, t);
  return { now: t, st, stage: st.stage, age: st.ageDays, grid: gridFor(st.stage, st.ageDays, state.prefs) };
}

const mem = (id) => memberById(state, id);
const activeMembers = () => state.members.filter((m) => !m.revoked);
const whoShort = (id) => { const m = mem(id); return m ? `${memberEmoji(m)} ${memberName(m)}` : ''; };
const babyName = () => (state.family.name || '').trim() || '우리 아기';

// 이름 뒤 주어 조사: 하린 → 하린이가, 서아 → 서아가 (아기 이름 부르는 말투)
function nameSubj(name) {
  const w = String(name || '');
  const code = w.charCodeAt(w.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28) return `${w}이가`;
  return `${w}가`;
}
// 사람 이름 + 이/가 (엄마가, 이모님이)
function subj(name) {
  const w = String(name || '');
  const code = w.charCodeAt(w.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28) return `${w}이`;
  return `${w}가`;
}
// (으)로
function euro(name) {
  const w = String(name || '');
  const code = w.charCodeAt(w.length - 1);
  if (code >= 0xac00 && code <= 0xd7a3) { const j = (code - 0xac00) % 28; return `${w}${j === 0 || j === 8 ? '로' : '으로'}`; }
  return `${w}로`;
}

// ---------- 작은 도우미 ----------
const toastQ = [];
/** 위쪽 알림. queue=true 면 지금 보이는 알림이 끝난 뒤 차례로 (도감·고마워요 같은 소식이 즉시 피드백에 덮이지 않게) */
function showToast(msg, ms = 2600, { queue = false } = {}) {
  const el = $('toast');
  if (queue && el.classList.contains('show')) {
    if (toastQ.length < 4) toastQ.push([msg, ms]);
    return;
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.remove('show');
    if (toastQ.length) setTimeout(() => { if (!el.classList.contains('show') && toastQ.length) { const [m, t] = toastQ.shift(); showToast(m, t); } }, 350);
  }, ms);
}
/** 렌더 중에 생긴 소식 — 곧이어 나올 즉시 피드백 뒤로 */
function announce(msg, ms = 3800) {
  setTimeout(() => showToast(msg, ms, { queue: true }), 0);
}

/** 카드용 짧은 경과: 45분 / 2시간 20분 / 4시간 반 / 1일 3시간 */
function agoShort(min) {
  if (min == null || !Number.isFinite(min)) return '';
  const m = Math.max(0, Math.floor(min));
  if (m < 180) return fmtElapsed(m);
  if (m < 24 * 60) { const h = Math.floor(m / 60); return `${h}시간${m % 60 >= 30 ? ' 반' : ''}`; }
  return fmtElapsed(m);
}

function vibrate(ms = 15) {
  // 홈 화면 바로가기(?q=)처럼 사용자가 아직 화면을 누르지 않았으면 브라우저가 막는다 → 조용히 건너뜀
  if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
  try { navigator.vibrate?.(ms); } catch (e) { /* ignore */ }
}

async function copyText(text, okMsg = '복사했어요') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg);
    return true;
  } catch (e) { /* 아래 폴백 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) { showToast(okMsg); return true; }
  } catch (e) { /* ignore */ }
  window.prompt('아래 내용을 길게 눌러 복사하세요', text);
  return false;
}

/** 공유 시트 → 'shared' | 'copied' | 'cancel' */
async function shareText(text, title = '') {
  if (navigator.share) {
    try {
      await navigator.share(title ? { title, text } : { text });
      return 'shared';
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancel';
    }
  }
  return (await copyText(text, '복사했어요 — 카톡에 붙여 넣어 주세요')) ? 'copied' : 'cancel';
}

function download(filename, content, mime) {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (isInApp) showToast('저장이 안 되면 사파리/크롬에서 다시 눌러 주세요', 3500);
    return true;
  } catch (e) {
    showToast('파일을 만들지 못했어요');
    return false;
  }
}

function errMsg(e) {
  if (!e) return ERROR_COPY.server;
  if (e.code === 'forbidden' && /claim|차지|기기/.test(e.message || '')) return e.message;
  return e.message || ERROR_COPY[e.code] || ERROR_COPY.server;
}

// 'YYYY-MM-DDTHH:MM' ↔ epoch ms (기기 로컬 시각)
function toLocalInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fromLocalInput(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Number.isFinite(t) ? t : null;
}

// ---------- 저장 · 다시 그리기 ----------
let lastSwCfg = '';
function refreshSwConfig(force = false) {
  const cfg = JSON.stringify(swConfig(state));
  if (!force && cfg === lastSwCfg) return Promise.resolve();
  lastSwCfg = cfg;
  return writeSwConfig(state).catch(() => false);
}

/** 상태 바뀐 뒤: 저장 → 다시 그리기 → 공유 동기화 예약 → 서비스워커 설정 갱신 */
function commit({ rerender = true } = {}) {
  if (!save(state)) showToast('저장 공간이 부족해요 — 설정 > JSON 백업을 먼저 해 주세요', 4500);
  if (rerender) render();
  autosync?.kick();
  refreshSwConfig();
}

// ---------- 테마 (밤 모드) ----------
const darkMQ = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = state.prefs.theme;
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  try { localStorage.setItem('bl:theme', t); } catch (e) { /* ignore */ }
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  $('themeColor').setAttribute('content', bg || '#FBF6F0');
}
darkMQ.addEventListener?.('change', applyTheme);

// ============================================================
// 렌더
// ============================================================
function render() {
  const setup = isSetUp();
  $('onboard').classList.toggle('hidden', setup);
  $('main').classList.toggle('hidden', !setup);
  $('foot').classList.remove('hidden');
  renderBanners();
  if (!setup) return;
  const c = ctx();
  // 여러 카드가 같이 쓰는 무거운 계산은 한 번만 (기록이 1년치 쌓여도 탭 반응이 빠르게)
  c.earned = earnedBadges({ events: state.events, members: state.members, family: state.family, now: c.now, prefs: state.prefs });
  c.streak = streakDays(state.events, c.now);
  renderTop();
  renderBaby(c);
  renderBaton(c);
  renderNow(c);
  renderGrid(c);
  renderHints(c);
  renderToday(c);
  renderTimeline(c);
  renderTeam(c);
  ui.lastDay = dayKey(c.now);
  afterRender(c);
}

function renderBanners() {
  $('inappBanner').classList.toggle('hidden', !isInApp);
  $('revokedBanner').classList.toggle('hidden', !state.sync.revoked);
}

function syncView() {
  if (state.sync.revoked) return ['revoked', '연결 끊김'];
  if (!state.sync.token) return ['off', '이 기기만'];
  const s = autosync ? autosync.status() : 'ok';
  if (s === 'revoked') return ['revoked', '연결 끊김'];
  if (s === 'ok' && canShare()) return ['ok', '공유중'];
  return ['wait', '연결 대기'];
}

function renderTop() {
  const m = me(state);
  $('meChip').innerHTML = `<span>나 · ${esc(memberEmoji(m))} ${esc(memberName(m))}</span><span class="caret">▾</span>`;
  $('meChip').setAttribute('aria-label', `지금 기록하는 사람: ${memberName(m)} (바꾸기)`);
  const [cls, text] = syncView();
  $('syncPill').className = `sync-pill ${cls}`;
  $('syncText').textContent = text;
}

function renderBaby(c) {
  const { st } = c;
  const game = state.prefs.game;
  let ageTxt;
  if (st.ageDays == null) ageTxt = '생일을 알려 주세요';
  else if (st.ageDays === 99) ageTxt = '오늘 백일 🎉';
  else if (st.ageDays < 100) ageTxt = `생후 ${st.ageDays}일`;
  else ageTxt = ageText(parseDate(state.family.birth), today());
  const s = st.stage;
  const pill = game ? `Lv.${s.lv} ${esc(s.name)} ${s.emoji}` : `${s.emoji} ${esc(s.name)}`;
  let prog = '';
  if (game && st.ageDays != null) {
    const pct = Math.round(Math.max(0, Math.min(1, st.progress)) * 100);
    prog = st.next
      ? `<div class="bb-prog"><span class="bb-bar"><i style="width:${pct}%"></i></span><span>다음 단계 '${esc(st.next.name)}'까지 ${st.daysToNext}일</span></div>`
      : `<div class="bb-prog"><span class="bb-bar"><i style="width:100%"></i></span><span>마지막 단계까지 왔어요 — 함께 키운 팀 💛</span></div>`;
  }
  $('babyBar').innerHTML = `
    <div class="bb-row">
      <span class="bb-name">${esc(babyName())} <span>· ${esc(ageTxt)}</span></span>
      <span class="stage-pill">${pill}</span>
    </div>${prog}`;
}

// 다른 사람이 넘긴, 아직 내가 받지 않은 바통 (12시간 이내)
function pendingBatons(t) {
  const acked = new Set(state.events.filter((e) => !e.deleted && e.type === 'ack' && e.by === state.meId).map((e) => e.data?.target));
  return live(state.events).filter((e) => e.type === 'handoff' && e.by && e.by !== state.meId
    && t - e.ts < 12 * HOUR && e.ts <= t + 5 * MIN && !acked.has(e.id));
}

function renderBaton(c) {
  const list = pendingBatons(c.now);
  const e = list[list.length - 1];
  if (!e) { $('batonBanner').innerHTML = ''; return; }
  const who = memberName(mem(e.by));
  const range = e.data?.from && e.data?.to ? `${fmtHM(e.data.from)}~${fmtHM(e.data.to)} 요약` : '교대 요약';
  $('batonBanner').innerHTML = `
    <div class="baton">
      <button class="baton-main" data-baton-view="${esc(e.id)}">
        <span class="baton-title">📋 ${esc(subj(who))} 바통을 넘겼어요</span>
        <span class="baton-sub">${esc(fmtTime(e.ts))} · ${esc(range)} 보기 ›</span>
      </button>
      <button class="baton-ack" data-ack="${esc(e.id)}">✅ 받았어요</button>
    </div>`;
}

// ----- 지금 카드 -----
function nowSignature(c, fs, ds, ss) {
  return [dayKey(c.now), fs.level, fs.burpPending, fs.last?.id, fs.nextAt, fs.wakeHint, ss.ongoing?.id, ss.last?.id,
    ss.stale.length, ds.lastPee?.id, ds.lastPoop?.id, state.prefs.game].join('|');
}

const FOODISH = ['meal', 'snack', 'solid', 'milk', 'formula', 'breast', 'pumped'];

function renderNow(c) {
  const fs = feedState(state.events, c.now, c.stage, c.age);
  const ds = diaperState(state.events, c.now);
  const ss = sleepState(state.events, c.now);
  ui.lastNowSig = nowSignature(c, fs, ds, ss);

  // 🍼 수유 (돌 이후엔 '먹기' — 식사·간식·우유). 큰 글자 = 경과, 작은 줄 = "전 · 누가 · 무엇"
  let feedCard;
  const toddler = !c.stage.feedGap;
  const lastFood = toddler ? [...live(state.events)].reverse().find((e) => FOODISH.includes(e.type) && e.ts <= c.now + 2 * MIN) : fs.last;
  const bigAgo = (ts) => `<span data-live="short" data-ts="${ts}">${esc(agoShort((c.now - ts) / MIN))}</span>`;
  if (lastFood) {
    const m = typeMeta(lastFood.type);
    const d = lastFood.data || {};
    const what = FEED_TYPES.includes(lastFood.type) || lastFood.type === 'milk'
      ? (d.ml ? `${d.ml}ml` : BREAST_SIDES.find((x) => x.id === d.side)?.label || '')
      : (d.food || '');
    const lv = !toddler && fs.level && fs.level !== 'calm' ? ` lv-${fs.level}` : '';
    const next = !toddler && fs.nextAt
      ? `<div class="nc-foot">${fs.nextAt <= c.now ? '다음 수유 즈음' : `다음 ${esc(fmtHM(fs.nextAt))}쯤`}</div>` : '';
    const recent = c.now - lastFood.ts < MIN;
    feedCard = `
      <div class="nc${lv}">
        <div class="nc-label">${toddler ? '🍚 먹기' : '🍼 수유'}</div>
        <div class="nc-big">${bigAgo(lastFood.ts)}</div>
        <div class="nc-sub clamp2">${recent ? '' : '전 · '}${esc(memberName(mem(lastFood.by)))} · ${esc(m.label)}${what ? ` ${esc(what)}` : ''}</div>
        ${next}
      </div>`;
  } else {
    feedCard = `<div class="nc"><div class="nc-label">${toddler ? '🍚 먹기' : '🍼 수유'}</div><div class="nc-empty">아직 기록이 없어요</div></div>`;
  }

  // 🧷 지난 기저귀 — 소변·대변 각각 경과 (카드가 좁아 '전'은 제목에 담는다)
  const line = (emo, e) => (e
    ? `<div class="nc-line">${emo} <span data-live="short" data-ts="${e.ts}">${esc(agoShort((c.now - e.ts) / MIN))}</span></div>`
    : `<div class="nc-line">${emo} <small>기록 없음</small></div>`);
  const diaperCard = `
    <div class="nc">
      <div class="nc-label">🧷 지난 기저귀</div>
      ${line('💧', ds.lastPee)}
      ${line('💩', ds.lastPoop)}
      <div class="nc-foot">오늘 💧${ds.todayPee} 💩${ds.todayPoop}</div>
    </div>`;

  // 😴 잠
  let sleepCard;
  if (ss.ongoing) {
    sleepCard = `
      <div class="nc sleeping">
        <div class="nc-label">😴 자는 중</div>
        <div class="nc-big" data-live="dur" data-ts="${ss.ongoing.ts}">${esc(fmtDur(ss.elapsedMin))}</div>
        <div class="nc-sub">${esc(fmtHM(ss.ongoing.ts))}부터</div>
        <button class="nc-btn" data-wake="1">🌤 깼어요</button>
      </div>`;
  } else if (ss.stale.length) {
    const s0 = ss.stale[ss.stale.length - 1];
    sleepCard = `
      <div class="nc lv-soon">
        <div class="nc-label">😴 수면</div>
        <div class="nc-sub clamp2">끝나지 않은 잠 ${esc(fmtDate(s0.ts))} ${esc(fmtHM(s0.ts))}</div>
        <button class="nc-btn" data-edit="${esc(s0.id)}">끝 시각 고치기</button>
      </div>`;
  } else if (ss.last) {
    sleepCard = `
      <div class="nc">
        <div class="nc-label">😴 깬 지</div>
        <div class="nc-big">${bigAgo(ss.last.data.end)}</div>
        <div class="nc-sub clamp2">마지막 잠 ${esc(fmtHM(ss.last.ts))}~${esc(fmtHM(ss.last.data.end))}</div>
      </div>`;
  } else {
    sleepCard = `<div class="nc"><div class="nc-label">😴 수면</div><div class="nc-empty">아직 기록이 없어요</div></div>`;
  }
  $('nowCards').innerHTML = feedCard + diaperCard + sleepCard;
  renderBurp(c, fs);
}

// 트림 띠: 트림 단계에서 마지막 수유의 트림 여부를 아직 모를 때만
function renderBurp(c, fs) {
  const el = $('burpStrip');
  if (!fs.burpPending || !fs.last) { el.innerHTML = ''; return; }
  const e = fs.last;
  const d = describe(e);
  el.innerHTML = `
    <div class="burp-strip">
      <div class="bs-text">😮‍💨 트림했나요?<small>${esc(fmtHM(e.ts))} ${esc(typeMeta(e.type).label)}${d ? ` ${esc(d)}` : ''}</small></div>
      <button class="opt" data-burp="yes" data-id="${esc(e.id)}">✓ 했어요</button>
      <button class="opt" data-burp="no" data-id="${esc(e.id)}">안 했어요</button>
    </div>`;
}

// ----- 퀵 그리드 -----
function lastByType(t) {
  const out = {};
  for (const e of live(state.events)) if (e.ts <= t + 2 * MIN) out[e.type] = e;
  return out;
}

function cellHTML(id, c, ss, lastMap, cls = 'qbtn') {
  const meta = typeMeta(id);
  let emo = meta.emoji;
  let label = meta.label;
  let sub = '';
  let on = false;
  const ago = (e, maxH = 48) => (e && c.now - e.ts < maxH * HOUR
    ? `<span data-live="short" data-ts="${e.ts}">${esc(agoShort((c.now - e.ts) / MIN))}</span> 전` : '');
  switch (id) {
    case 'sleep':
      if (ss.ongoing) {
        on = true;
        emo = meta.endEmoji || '🌤';
        label = meta.endLabel || '깼어요';
        sub = `<span data-live="dur" data-ts="${ss.ongoing.ts}">${esc(fmtDur(ss.elapsedMin))}</span> 자는 중`;
      } else {
        label = meta.startLabel || '재우기';
        sub = ss.last ? `깬 지 <span data-live="short" data-ts="${ss.last.data.end}">${esc(agoShort(ss.elapsedMin))}</span>` : '';
      }
      break;
    case 'formula': case 'pumped': case 'milk': {
      const ml = state.prefs.lastMl?.[id] ?? lastMl(state.events, id);
      sub = ml ? `지난번 ${ml}ml` : '';
      break;
    }
    case 'breast': {
      const e = lastMap.breast;
      const side = BREAST_SIDES.find((s) => s.id === e?.data?.side);
      sub = side ? `지난번 ${side.label}` : '';
      break;
    }
    case 'both':
      sub = '소변+대변';
      break;
    case 'temp': {
      const e = lastMap.temp;
      sub = e && c.now - e.ts < 24 * HOUR && e.data?.c ? `${e.data.c.toFixed(1)}℃` : '';
      break;
    }
    default:
      sub = ago(lastMap[id]);
  }
  return `<button class="${cls}${on ? ' on' : ''}" data-act="${esc(id)}" aria-label="${esc(label)}${meta.input === 'tap' ? ' 바로 기록' : ''}">
    <span class="q-emo">${emo}</span><span class="q-label">${esc(label)}</span><span class="q-sub">${sub}</span></button>`;
}

function renderGrid(c) {
  const ss = sleepState(state.events, c.now);
  const lastMap = lastByType(c.now);
  $('grid').innerHTML = c.grid.map((id) => cellHTML(id, c, ss, lastMap)).join('');
}

// ----- 힌트 -----
const HINT_ICON = { urgent: '🚨', check: '💡', info: '🌿' };
const HINT_LINK = { fever: '해열제 안심 계산기 →' };
function renderHints(c) {
  const off = state.prefs.hintsOff || {};
  const today = dayKey(c.now);
  const list = hints(c.stage, state.events, c.now, state.family).filter((h) => !(h.level === 'info' && off[h.id] === today));
  $('hints').innerHTML = list.map((h) => `
    <div class="hint ${h.level}" role="${h.level === 'urgent' ? 'alert' : 'note'}">
      <span class="h-ico">${HINT_ICON[h.level] || '🌿'}</span>
      <div class="h-body">${esc(h.text)}${h.link ? `<br /><a href="${esc(h.link)}">${esc(HINT_LINK[h.id] || '자세히 보기 →')}</a>` : ''}</div>
      ${h.level === 'info' ? `<button class="hint-x" data-hint-x="${esc(h.id)}" aria-label="오늘은 그만 보기">✕</button>` : ''}
    </div>`).join('');
}

// ----- 오늘 카드 -----
function renderToday(c) {
  const from = startOfDay(c.now);
  const s = statsBetween(state.events, from, addDaysTs(c.now, 1), c.now);
  const chips = [];
  if (s.feeds) chips.push(`🍼 수유 ${s.feeds}회${s.bottleMl ? ` · ${fmtNum(s.bottleMl)}ml` : ''}`);
  if (s.breast && !s.bottleMl) chips.push(`🤱 모유 ${s.breast}회`);
  if (s.pee) chips.push(`💧 ${s.pee}`);
  if (s.poop) chips.push(`💩 ${s.poop}`);
  if (s.sleepMin) chips.push(`😴 ${fmtElapsed(s.sleepMin)}`);
  for (const t of ['solid', 'meal', 'snack']) if (s.byType[t]) chips.push(`${typeMeta(t).emoji} ${typeMeta(t).label} ${s.byType[t]}`);
  if (s.milkMl) chips.push(`🥛 ${fmtNum(s.milkMl)}ml`);
  if (s.byType.tummy) chips.push(`🐢 터미타임 ${s.byType.tummy}`);
  if (s.byType.bath) chips.push('🛁 목욕');
  let html = `<h2>오늘 <span style="font-weight:600;color:var(--ink-soft);font-size:13px">${esc(fmtDate(c.now))}</span></h2>`;
  html += chips.length
    ? `<div class="sum-chips">${chips.map((x) => `<span class="sum-chip">${esc(x)}</span>`).join('')}</div>`
    : '<div class="sum-empty">오늘 기록이 아직 없어요. 위 버튼을 한 번 누르면 바로 기록돼요 👆</div>';

  if (state.prefs.game) {
    const qs = quests(c.stage, state.events, c.now);
    const earned = c.earned || earnedBadges({ events: state.events, members: state.members, family: state.family, now: c.now, prefs: state.prefs });
    const fresh = newBadges(earned, state.prefs).length;
    const allDone = qs.length && qs.every((q) => q.done);
    html += `
      <div class="quest-head">
        <h3>🤝 오늘의 팀 미션</h3>
        <button class="dex-btn" data-dex="1">📖 도감 ${earned.size}/${BADGES.length}${fresh ? '<span class="new">NEW</span>' : ''}</button>
      </div>
      <ul class="quests">${qs.map((q) => `
        <li class="quest${q.done ? ' done' : ''}">
          <span class="qe">${q.done ? '✅' : esc(q.emoji)}</span>
          <span class="ql">${esc(q.label)}<span class="qbar"><i style="width:${Math.round((q.count / q.target) * 100)}%"></i></span></span>
          <span class="qc">${q.done ? '완료' : `${q.count}/${q.target}`}</span>
        </li>`).join('')}</ul>
      ${allDone ? '<div class="perfect">⭐ 오늘 팀 미션 완료! 다들 멋져요</div>' : ''}`;
    const streak = c.streak ?? streakDays(state.events, c.now);
    const total = live(state.events).length;
    const streakTxt = streak > 0 ? `🔥 함께 기록 ${streak}일째` : (total ? '🌿 쉬어가도 괜찮아요 — 하나 기록하면 다시 시작해요' : '');
    html += `<div class="streak-line">${esc([streakTxt, total ? `우리 팀 기록 ${fmtNum(total)}개` : ''].filter(Boolean).join(' · '))}</div>`;
  }
  $('todayCard').innerHTML = html;
}

// ----- 타임라인 -----
function reactionIndex() {
  const thx = new Map();
  const acks = new Map();
  for (const e of state.events) {
    if (e.deleted || (e.type !== 'thanks' && e.type !== 'ack')) continue;
    const t = e.data?.target;
    if (!t) continue;
    const m = e.type === 'thanks' ? thx : acks;
    if (!m.has(t)) m.set(t, []);
    m.get(t).push(e);
  }
  return { thx, acks };
}

// 소변+대변 한 쌍(같은 시각·같은 사람, '둘 다' 버튼)을 한 행으로 묶기
function groupRows(list) {
  const used = new Set();
  const rows = [];
  for (const e of list) {
    if (used.has(e.id)) continue;
    if (e.type === 'pee' || e.type === 'poop') {
      const other = list.find((x) => !used.has(x.id) && x !== e && x.ts === e.ts && (x.by ?? null) === (e.by ?? null)
        && x.type === (e.type === 'pee' ? 'poop' : 'pee'));
      if (other) {
        used.add(e.id); used.add(other.id);
        const pee = e.type === 'pee' ? e : other;
        const poop = e.type === 'poop' ? e : other;
        rows.push({ kind: 'both', ts: e.ts, by: e.by, main: poop, ids: [pee.id, poop.id], events: [pee, poop] });
        continue;
      }
    }
    used.add(e.id);
    rows.push({ kind: e.type, ts: e.ts, by: e.by, main: e, ids: [e.id], events: [e] });
  }
  return rows;
}

function rowHTML(r, c, rx) {
  const e = r.main;
  const meta = r.kind === 'both' ? ACTION_META.both : typeMeta(e.type);
  const mine = r.by && r.by === state.meId;
  const m = mem(r.by);
  const color = memberColor(m, state.members);
  const thx = (rx.thx.get(e.id) || []).concat(r.kind === 'both' ? (rx.thx.get(r.ids[0]) || []) : []);
  const myThx = thx.some((t) => t.by === state.meId);
  const shared = !!state.sync.token;
  const pending = shared && r.events.some((x) => x.dirty && !x.rejected);
  const rejected = r.events.some((x) => x.rejected);
  let text;
  let side = '';
  let cls = 'tl-row';
  if (e.type === 'handoff') {
    cls += ' baton-row';
    const range = e.data?.from && e.data?.to ? ` (${fmtHM(e.data.from)}~${fmtHM(e.data.to)})` : '';
    const ackers = (rx.acks.get(e.id) || []).map((a) => a.by).filter((v, i, a) => a.indexOf(v) === i);
    const ackTxt = ackers.length ? ` · ${ackers.map((id) => memberName(mem(id))).join('·')} 확인 ✓` : '';
    text = `<b>${esc(subj(memberName(m)))} 바통을 넘겼어요</b>${esc(range)}<span class="tl-who">${esc(ackTxt.replace(/^ · /, '') || '아직 확인 전')}</span>`;
    if (!mine && r.by && !ackers.includes(state.meId)) side = `<button class="ack-btn" data-ack="${esc(e.id)}">받았어요</button>`;
  } else {
    let det = r.kind === 'both' ? describe(r.events[1]) : describe(e);
    if (e.type === 'sleep' && !e.data?.end && c.now - e.ts < 24 * HOUR) {
      cls += ' ongoing';
      det = `자는 중 · <span data-live="dur" data-ts="${e.ts}">${esc(fmtDur((c.now - e.ts) / MIN))}</span>`;
    } else det = esc(det);
    const note = e.type !== 'note' && e.type !== 'med' && e.data?.note ? ` · 📝 ${esc(e.data.note)}` : '';
    const label = r.kind === 'both' ? '소변+대변' : meta.label;
    const whoBits = [m ? `${esc(memberEmoji(m))} ${esc(memberName(m))}` : ''];
    if (e.data?.src && e.data.src !== 'app') whoBits.push(e.data.src === 'notif' ? '🔔 알림' : e.data.src === 'say' ? '🎙 음성' : '🔒 잠금화면');
    if (thx.length) whoBits.push(`<span class="th">💛${thx.length > 1 ? thx.length : ''}</span>`);
    if (pending) whoBits.push('⏳ 보내는 중');
    if (rejected) whoBits.push('<span class="warn">⚠ 서버가 받지 않았어요 — 눌러서 고치기</span>');
    text = `<b>${esc(label)}</b> <span class="det">${det}</span>${note}<span class="tl-who">${whoBits.filter(Boolean).join(' · ')}</span>`;
    if (r.by && !mine) {
      side = `<button class="thx-btn${myThx ? ' on' : ''}" data-thx="${esc(e.id)}" aria-label="${myThx ? '고마워요 취소' : `${memberName(m)}에게 고마워요`}" aria-pressed="${myThx}">${myThx ? '💛' : '🤍'}</button>`;
    }
    if (rejected) cls += ' rejected';
  }
  return `<li class="${cls}" style="--mc:${esc(color)}">
    <button class="tl-main" data-edit="${esc(r.ids.join(','))}">
      <span class="tl-time">${esc(fmtHM(r.ts))}</span>
      <span class="tl-emo${r.kind === 'both' ? ' sm' : ''}">${meta.emoji}</span>
      <span class="tl-text">${text}</span>
    </button>${side ? `<span class="tl-side">${side}</span>` : ''}</li>`;
}

function renderTimeline(c) {
  const all = live(state.events);
  const rx = reactionIndex();
  const base = ui.tab === 'today' ? 0 : 1;
  const days = [];
  for (let k = base; k <= base + ui.extraDays; k++) days.push(k);
  let html = '';
  let any = false;
  for (const k of days) {
    const from = addDaysTs(c.now, -k);
    const to = k === 0 ? Infinity : addDaysTs(c.now, -k + 1);
    const list = all.filter((e) => e.ts >= from && e.ts < to).reverse();
    if (days.length > 1 || k > 1) html += `<div class="tl-day">${k === 0 ? '오늘' : k === 1 ? '어제' : ''} ${esc(fmtDate(from))}</div>`;
    if (!list.length) {
      html += `<div class="tl-empty">${k === 0 ? '아직 오늘 기록이 없어요.<br />위 버튼을 한 번 누르면 바로 기록돼요 👆' : '이 날은 기록이 없어요'}</div>`;
      continue;
    }
    any = true;
    html += `<ul class="tl-list">${groupRows(list).map((r) => rowHTML(r, c, rx)).join('')}</ul>`;
  }
  $('timeline').innerHTML = html;
  const oldest = addDaysTs(c.now, -(base + ui.extraDays));
  const hasOlder = all.length && all[0].ts < oldest;
  $('tlMore').classList.toggle('hidden', !hasOlder || ui.extraDays >= 60);
  void any;
}

// ----- 팀 카드 (가족 합계 + 고마움만 — 사람별 횟수 없음) -----
function renderTeam(c) {
  const from = startOfDay(c.now);
  const t = team(state.events, state.members, from, addDaysTs(c.now, 1), state.meId);
  const people = activeMembers().map((m) => `${esc(memberEmoji(m))} ${esc(memberName(m))}`).join(' · ');
  const lines = [];
  if (t.night) lines.push(`🌙 밤사이(22~6시) 함께 남긴 기록 <b>${t.night}</b>개`);
  if (state.prefs.game) {
    const streak = c.streak ?? streakDays(state.events, c.now);
    if (streak > 0) lines.push(`🔥 함께 기록 <b>${streak}</b>일째`);
  }
  lines.push(`💛 이번 주 서로 주고받은 고마움 <b>${t.weekThanks}</b>개`);
  $('teamCard').innerHTML = `
    <h2>🤝 오늘 함께한 우리 팀</h2>
    <div class="team-big">${t.total ? `오늘 우리 팀 기록 <b>${t.total}</b>개 — 다들 수고 많았어요` : '오늘은 아직 조용해요 — 첫 기록을 남겨 볼까요?'}</div>
    <ul class="team-lines">${lines.map((l) => `<li>${l}</li>`).join('')}<li>함께하는 사람: ${people}</li></ul>
    ${t.lastThanksToMe ? `<div class="team-thx">${esc(t.lastThanksToMe.text)}</div>` : ''}
    <div class="team-note">${t.weekThanks ? '"누가 더"가 아니라 "함께" — 기록마다 누가 했는지는 정보로만 남아요.' : '다른 사람 기록 옆 🤍를 누르면 고마움을 전할 수 있어요.'}</div>
    <button class="btn btn-ghost btn-block" data-handoff="1" style="margin-top:12px">📋 바통 넘기기 (교대 요약)</button>`;
}

// ----- 30초 타이머: 경과 시간 글자만 -----
function updateLive(t = Date.now()) {
  for (const el of document.querySelectorAll('[data-live]')) {
    const ts = Number(el.dataset.ts);
    if (!Number.isFinite(ts)) continue;
    const min = (t - ts) / MIN;
    el.textContent = el.dataset.live === 'dur' ? fmtDur(min) : el.dataset.live === 'short' ? agoShort(min) : fmtElapsed(min);
  }
}

function tick() {
  if (!isSetUp() || document.visibilityState === 'hidden') return;
  const t = Date.now();
  if (dayKey(t) !== ui.lastDay) { render(); return; }
  const c = ctx(t);
  const sig = nowSignature(c, feedState(state.events, t, c.stage, c.age), diaperState(state.events, t), sleepState(state.events, t));
  if (sig !== ui.lastNowSig) renderNow(c);
  updateLive(t);
}

// ============================================================
// 렌더 뒤 확인: 레벨업 · 새 버튼 · 도감 · 받은 고마움/확인
// ============================================================
function afterRender(c) {
  let dirty = false;
  const p = state.prefs;
  // 처음 쓰는 기기: 지금까지 것은 조용히 '본 것'으로 (알림 폭탄 방지)
  if (!p.seenStage) {
    p.seenStage = c.stage.id;
    p.seenUnlocks = c.grid.filter((id) => EVENT_TYPES[id]?.fromDay != null);
    p.seenBadges = [...earnedBadges({ events: state.events, members: state.members, family: state.family, now: c.now, prefs: p })];
    p.seenThanks = seenReactionIds();
    save(state);
    return;
  }
  // 레벨업 (앞으로만)
  if (p.seenStage !== c.stage.id) {
    const prevIdx = STAGES.findIndex((s) => s.id === p.seenStage);
    p.seenStage = c.stage.id;
    p.seenUnlocks = [...new Set([...(p.seenUnlocks || []), ...c.grid])];
    dirty = true;
    if (prevIdx >= 0 && prevIdx < c.st.index && c.age != null) showLevelUp(STAGES[prevIdx], c);
    save(state);
    return;   // 도감·고마워요 소식은 레벨업 창을 닫은 뒤 다음 렌더에서
  } else {
    // 단계 중간에 열리는 버튼 (예: 뒤집기 단계의 이유식은 120일부터)
    const seen = new Set(p.seenUnlocks || []);
    const fresh = c.grid.filter((id) => EVENT_TYPES[id]?.fromDay != null && !seen.has(id));
    if (fresh.length) {
      p.seenUnlocks = [...seen, ...fresh];
      dirty = true;
      announce(`🔓 새 버튼이 열렸어요: ${fresh.map((id) => `${typeMeta(id).emoji} ${typeMeta(id).label}`).join(' · ')}`, 4000);
    }
  }
  // 도감 새 카드 (게임 켰을 때만, 막지 않는 알림 — 모달이 떠 있으면 닫힌 뒤에)
  if (p.game && !modalBusy) {
    const earned = c.earned || earnedBadges({ events: state.events, members: state.members, family: state.family, now: c.now, prefs: p });
    const fresh = newBadges(earned, p);
    if (fresh.length) {
      const seen = new Set(p.seenBadgesShown || []);
      const toShow = fresh.filter((id) => !seen.has(id));
      if (toShow.length) {
        p.seenBadgesShown = [...seen, ...toShow].slice(-100);
        dirty = true;
        const names = toShow.map((id) => BADGES.find((b) => b.id === id)).filter(Boolean).map((b) => `${b.emoji} ${b.name}`);
        announce(`📖 도감에 새 카드: ${names.join(' · ')}`, 4200);
        confetti(40);
      }
    }
  }
  // 받은 고마워요 · 바통 확인
  const fresh = freshReactions();
  if (fresh.length) {
    p.seenThanks = [...(p.seenThanks || []), ...fresh.map((e) => e.id)].slice(-600);
    dirty = true;
    const lastThx = fresh.filter((e) => e.type === 'thanks').pop();
    const lastAck = fresh.filter((e) => e.type === 'ack').pop();
    if (lastThx) {
      const t = team(state.events, state.members, startOfDay(c.now), addDaysTs(c.now, 1), state.meId);
      announce(t.lastThanksToMe?.text || `💛 ${subj(memberName(mem(lastThx.by)))} 고마워했어요`, 4000);
    } else if (lastAck) {
      announce(`✅ ${subj(memberName(mem(lastAck.by)))} 바통을 받았어요`, 3500);
    }
  }
  if (dirty) save(state);
}

// 내 기록에 다른 사람이 보낸 고마워요·확인 id 목록
function reactionsToMe() {
  const mine = new Set(state.events.filter((e) => e.by && e.by === state.meId).map((e) => e.id));
  return state.events.filter((e) => !e.deleted && (e.type === 'thanks' || e.type === 'ack') && e.by !== state.meId && mine.has(e.data?.target));
}
function seenReactionIds() {
  return reactionsToMe().map((e) => e.id).slice(-600);
}
function freshReactions() {
  const seen = new Set(state.prefs.seenThanks || []);
  return reactionsToMe().filter((e) => !seen.has(e.id)).sort((a, b) => a.ts - b.ts);
}

// ============================================================
// 기록하기
// ============================================================
function flash(el) {
  if (!el) return;
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 750);
}

/** 퀵 그리드·더보기 버튼 */
function onAction(actionId, el) {
  const t = Date.now();
  if (ui.tapAt[actionId] && t - ui.tapAt[actionId] < 700) return;   // 실수로 두 번 톡톡 → 한 번만
  ui.tapAt[actionId] = t;
  const meta = EVENT_TYPES[actionId] || ACTION_META[actionId];
  if (!meta) return;
  switch (meta.input) {
    case 'tap': case 'toggle': quickLog(actionId, el); break;
    case 'amount': openAmountSheet(actionId); break;
    case 'breast': openBreastSheet(); break;
    case 'food': openFoodSheet(actionId); break;
    case 'temp': openTempSheet(); break;
    case 'med': openMedSheet(); break;
    case 'potty': openPottySheet(); break;
    case 'note': openNoteSheet(); break;
    default: quickLog(actionId, el);
  }
}

/** 바로 기록 (logAction) → 저장 → 되돌리기 토스트 */
function quickLog(actionId, el, { ts, data } = {}) {
  const res = logAction(state, actionId, { ts, data }, Date.now());
  commit();
  vibrate();
  if (el) {
    // 다시 그려져서 el 이 바뀌었을 수 있다 → 새 버튼을 찾아 반짝
    flash(document.querySelector(`#grid [data-act="${actionId}"]`) || null);
  }
  showUndoFor(res, actionId);
  return res;
}

/** 되돌리기 토스트 문구 → [큰 줄, 작은 줄] */
function undoLabel(res, actionId) {
  const e = res.events[0];
  if (!e) return ['기록했어요', ''];
  const who = memberName(mem(e.by));
  if (res.kind === 'sleepStart') return ['😴 재우기 시작', `${fmtHM(e.ts)} · ${who}`];
  if (res.kind === 'sleepEnd') {
    const mins = Math.max(...res.events.map((x) => ((x.data?.end || x.ts) - x.ts) / MIN));
    return ['🌤 깼어요', `${mins < 1 ? '1분 안 되게' : fmtElapsed(mins)} 잤어요 · ${fmtHM(res.events[0].data?.end || Date.now())}`];
  }
  if (actionId === 'both') return ['💧💩 소변+대변 기록했어요', `${fmtHM(e.ts)} · ${who}`];
  const m = typeMeta(e.type);
  const d = describe(e);
  return [`${m.emoji} ${m.label}${d ? ` ${d}` : ''} 기록했어요`, `${fmtHM(e.ts)} · ${who}`];
}

function showUndoFor(res, actionId) {
  const ids = res.events.filter(Boolean).map((e) => e.id);
  const isPoop = res.events.some((e) => e?.type === 'poop');
  showUndo(undoLabel(res, actionId), {
    undo: () => {
      undoAction(state, res, Date.now());
      commit();
      showToast('되돌렸어요');
    },
    editLabel: isPoop ? '색·시간' : '시간 수정',
    edit: () => openEditSheet(ids),
  });
}

function showUndo(text, { undo, edit, editLabel = '시간 수정' } = {}) {
  const el = $('undo');
  const [main, sub] = Array.isArray(text) ? text : [text, ''];
  $('undoText').innerHTML = `${esc(main)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
  $('undoBtn').classList.toggle('hidden', !undo);
  $('undoEdit').classList.toggle('hidden', !edit);
  $('undoEdit').textContent = editLabel;
  ui.undo = { undo, edit };
  el.classList.add('show');
  clearTimeout(ui.undoTimer);
  ui.undoTimer = setTimeout(hideUndo, 5000);
}
function hideUndo() {
  clearTimeout(ui.undoTimer);
  $('undo').classList.remove('show');
  ui.undo = null;
}

// 시트에서 기록 (양·시간 등을 고른 뒤)
function logFromSheet(type, ts, data) {
  const res = logAction(state, type, { ts, data }, Date.now());
  closeSheet();
  commit();
  vibrate();
  showUndoFor(res, type);
  return res;
}

// ============================================================
// 바텀 시트 (하나를 돌려 씀) + 안드로이드 뒤로가기로 닫기
// ============================================================
const sheet = { open: false, pushed: false, onClose: null };
let popIgnore = 0;

function openSheet(title, html, { onClick = null, onInput = null, onChange = null, onClose = null, onMount = null, history: useHistory = true } = {}) {
  hideUndo();
  $('sheetTitle').textContent = title;
  const body = $('sheetBody');
  body.innerHTML = html;
  body.onclick = onClick;
  body.oninput = onInput;
  body.onchange = onChange;
  sheet.onClose = onClose;
  if (!sheet.open) {
    sheet.open = true;
    $('sheetDim').classList.remove('hidden');
    document.documentElement.style.overflow = 'hidden';
    sheet.pushed = false;
    if (useHistory) { try { history.pushState({ blSheet: true }, ''); sheet.pushed = true; } catch (e) { sheet.pushed = false; } }
  }
  body.scrollTop = 0;
  onMount?.(body);
}

function hideSheet() {
  if (!sheet.open) return;
  sheet.open = false;
  $('sheetDim').classList.add('hidden');
  document.documentElement.style.overflow = '';
  const body = $('sheetBody');
  body.innerHTML = '';
  body.onclick = body.oninput = body.onchange = null;
  const cb = sheet.onClose;
  sheet.onClose = null;
  cb?.();
}

function closeSheet() {
  if (!sheet.open) return;
  const pushed = sheet.pushed;
  sheet.pushed = false;
  hideSheet();
  if (pushed && history.state && history.state.blSheet) { popIgnore++; history.back(); }
}

window.addEventListener('popstate', () => {
  if (popIgnore > 0) { popIgnore--; return; }
  if (sheet.open) { sheet.pushed = false; hideSheet(); }
});

// ----- 시트 폼 조각 -----
/** 선택 칩 묶음: data-grp/data-val. toggle=true 면 다시 누르면 선택 해제 */
function optsHTML(grp, items, cur, { cls = 'opts', toggle = false } = {}) {
  return `<div class="${cls}" role="group">${items.map((it) => {
    const on = cur != null && String(it.id) === String(cur);
    return `<button type="button" class="opt${on ? ' on' : ''}${it.cls ? ` ${it.cls}` : ''}" data-grp="${esc(grp)}" data-val="${esc(it.id)}"${toggle ? ' data-toggle="1"' : ''} aria-pressed="${on}">${it.html ?? esc(it.label)}</button>`;
  }).join('')}</div>`;
}

/** 칩 클릭 처리 → 눌린 그룹 이름 (칩이 아니면 null) */
function pickOpt(e, f) {
  const b = e.target.closest('[data-grp]');
  if (!b) return null;
  const g = b.dataset.grp;
  const v = b.dataset.val;
  const cur = f[g] == null ? null : String(f[g]);
  f[g] = b.dataset.toggle && cur === v ? null : v;
  for (const x of $('sheetBody').querySelectorAll(`[data-grp="${CSS.escape(g)}"]`)) {
    const on = f[g] != null && x.dataset.val === String(f[g]);
    x.classList.toggle('on', on);
    x.setAttribute('aria-pressed', String(on));
  }
  return g;
}

// 시각 줄: 지금 / N분 전 / 직접
const TIME_ITEMS = [{ id: '0', label: '지금' }, ...TIME_AGO_CHIPS.map((m) => ({ id: String(m), label: `${m}분 전` })), { id: 'custom', label: '직접' }];
function timeRowHTML() {
  return `<div class="sec"><div class="sec-title">언제</div>
    ${optsHTML('at', TIME_ITEMS, '0', { cls: 'time-row' })}
    <div class="time-custom hidden" id="timeCustom"><input class="field" type="time" id="timeInput" aria-label="직접 시각" /></div></div>`;
}
function onTimePick(g, f) {
  if (g !== 'at') return;
  const box = $('timeCustom');
  if (!box) return;
  const custom = f.at === 'custom';
  box.classList.toggle('hidden', !custom);
  if (custom && !$('timeInput').value) $('timeInput').value = fmtHM(Date.now());
}
/** 고른 시각 → epoch ms (직접 입력이 지금보다 뒤면 어제로 본다 — 자정 넘겨 늦게 기록할 때) */
function resolveTime(f, t = Date.now()) {
  if (f.at === 'custom') {
    const v = $('timeInput')?.value || '';
    const m = /^(\d{1,2}):(\d{2})/.exec(v);
    if (!m) return t;
    const d = new Date(t);
    let ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2]).getTime();
    if (ts > t + 2 * MIN) ts = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, +m[1], +m[2]).getTime();
    return ts;
  }
  const ago = Number(f.at) || 0;
  return ago ? t - ago * MIN : undefined;   // undefined = 지금 (store 가 now 로)
}

const BURP_ITEMS = [{ id: '', label: '아직' }, ...BURP_OPTIONS.map((b) => ({ id: b.id, label: b.label }))];

// ----- 분유·유축·우유 양 시트 -----
function openAmountSheet(type) {
  const c = ctx();
  const meta = EVENT_TYPES[type];
  const last = state.prefs.lastMl?.[type] ?? lastMl(state.events, type);
  const chips = amountChips(c.stage, type, last);
  const f = { ml: String(last ?? chips[Math.floor(chips.length / 2)]), burp: '', at: '0' };
  const showBurp = c.stage.burp && type !== 'milk';
  const html = `
    <div class="sec">
      <div class="amount-box">
        <button type="button" class="step-btn" data-step="-${AMOUNT_STEP}" aria-label="${AMOUNT_STEP}ml 줄이기">−${AMOUNT_STEP}</button>
        <label class="amount-val"><input id="mlInput" type="number" inputmode="numeric" min="1" max="500" step="${AMOUNT_STEP}" value="${esc(f.ml)}" aria-label="양 (ml)" /><span class="unit">ml</span></label>
        <button type="button" class="step-btn" data-step="${AMOUNT_STEP}" aria-label="${AMOUNT_STEP}ml 늘리기">+${AMOUNT_STEP}</button>
      </div>
    </div>
    <div class="sec">${optsHTML('ml', chips.map((v) => ({ id: String(v), cls: v === last ? 'stacked' : '', html: v === last ? `${v}<span class="last-tag">지난번</span>` : String(v) })), f.ml, { cls: 'opts cols-4' })}</div>
    ${showBurp ? `<div class="sec"><div class="sec-title">트림</div>${optsHTML('burp', BURP_ITEMS, f.burp, { cls: 'seg' })}</div>` : ''}
    ${timeRowHTML()}
    <div class="sheet-actions"><button class="btn btn-primary btn-block" data-save="1">기록하기</button></div>
    ${type === 'formula' ? `<p class="sheet-note">${esc(HINT_COPY.formulaAmount)}</p>` : ''}
    ${type === 'milk' ? `<p class="sheet-note">${esc('생우유는 돌 이후, 하루 500ml 안팎이 참고량이에요 (질병관리청)')}</p>` : ''}`;
  const setMl = (v) => {
    const n = Math.max(LIMITS.ml[0], Math.min(LIMITS.ml[1], Math.round(Number(v) || 0)));
    f.ml = String(n);
    $('mlInput').value = f.ml;
    for (const x of $('sheetBody').querySelectorAll('[data-grp="ml"]')) x.classList.toggle('on', x.dataset.val === f.ml);
  };
  openSheet(`${meta.emoji} ${meta.label}`, html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g === 'ml') { $('mlInput').value = f.ml; return; }
      if (g) { onTimePick(g, f); return; }
      const st = e.target.closest('[data-step]');
      if (st) { setMl((Number($('mlInput').value) || 0) + Number(st.dataset.step)); return; }
      if (e.target.closest('[data-save]')) {
        const ml = Math.round(Number($('mlInput').value));
        if (!(ml >= LIMITS.ml[0] && ml <= LIMITS.ml[1])) { showToast('양은 1~500ml 사이로 적어 주세요'); return; }
        const data = { ml };
        if (showBurp && f.burp) data.burp = f.burp;
        logFromSheet(type, resolveTime(f), data);
      }
    },
    onInput: (e) => {
      if (e.target.id === 'mlInput') {
        f.ml = String(Math.round(Number(e.target.value) || 0));
        for (const x of $('sheetBody').querySelectorAll('[data-grp="ml"]')) x.classList.toggle('on', x.dataset.val === f.ml);
      }
    },
  });
}

// ----- 모유 시트 -----
function openBreastSheet() {
  const c = ctx();
  const lastB = [...live(state.events)].reverse().find((e) => e.type === 'breast');
  const lastSide = lastB?.data?.side;
  const suggest = lastSide === 'L' ? 'R' : lastSide === 'R' ? 'L' : 'L';
  const f = { side: suggest, min: null, burp: '', at: '0' };
  const sideLabel = BREAST_SIDES.find((s) => s.id === lastSide)?.label;
  const html = `
    <div class="sec"><div class="sec-title">방향 ${sideLabel ? `<span class="sub">지난번 ${esc(sideLabel)} → 이번엔 ${esc(BREAST_SIDES.find((s) => s.id === suggest).label)}?</span>` : ''}</div>
      ${optsHTML('side', BREAST_SIDES, f.side, { cls: 'seg' })}</div>
    <div class="sec"><div class="sec-title">시간 <span class="sub">(선택)</span></div>
      ${optsHTML('min', BREAST_MIN_CHIPS.map((m) => ({ id: String(m), label: `${m}분` })), f.min, { cls: 'opts cols-4', toggle: true })}</div>
    ${c.stage.burp ? `<div class="sec"><div class="sec-title">트림</div>${optsHTML('burp', BURP_ITEMS, f.burp, { cls: 'seg' })}</div>` : ''}
    ${timeRowHTML()}
    <div class="sheet-actions"><button class="btn btn-primary btn-block" data-save="1">기록하기</button></div>
    ${c.stage.burp ? `<p class="sheet-note">${esc(HINT_COPY.burp)}</p>` : ''}`;
  openSheet('🤱 모유', html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g) { onTimePick(g, f); return; }
      if (e.target.closest('[data-save]')) {
        const data = { side: f.side || 'both' };
        if (f.min) data.min = Number(f.min);
        if (c.stage.burp && f.burp) data.burp = f.burp;
        logFromSheet('breast', resolveTime(f), data);
      }
    },
  });
}

// ----- 이유식·식사·간식 시트 -----
function recentValues(types, key, n = 12) {
  const out = [];
  for (const e of [...live(state.events)].reverse()) {
    if (!types.includes(e.type)) continue;
    const v = (e.data?.[key] || '').trim();
    if (v && !out.includes(v)) out.push(v);
    if (out.length >= n) break;
  }
  return out;
}

function openFoodSheet(type) {
  const meta = EVENT_TYPES[type];
  const f = { amount: null, reaction: null, at: '0' };
  const foods = recentValues(['solid', 'meal', 'snack'], 'food');
  const html = `
    <div class="sec"><div class="sec-title">무엇을 <span class="sub">(선택)</span></div>
      <input class="field" id="foodInput" list="foodList" maxlength="${LIMITS.food}" placeholder="${type === 'solid' ? '예: 소고기 애호박 미음' : '예: 김밥, 바나나'}" autocomplete="off" />
      <datalist id="foodList">${foods.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
      ${foods.length ? `<div class="opts" style="margin-top:8px">${foods.slice(0, 6).map((x) => `<button type="button" class="opt" data-food="${esc(x)}" style="min-height:40px;font-size:13.5px">${esc(x)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="sec"><div class="sec-title">얼마나</div>${optsHTML('amount', FOOD_AMOUNTS, f.amount, { cls: 'opts cols-4', toggle: true })}</div>
    <div class="sec"><div class="sec-title">반응</div>${optsHTML('reaction', FOOD_REACTIONS.map((r) => ({ id: r.id, label: `${r.emoji} ${r.label}` })), f.reaction, { cls: 'opts cols-2', toggle: true })}</div>
    ${timeRowHTML()}
    <div class="sheet-actions"><button class="btn btn-primary btn-block" data-save="1">기록하기</button></div>
    ${type === 'solid' ? `<a class="sheet-link" href="../meal-planner/">🥣 이유식 식단표 만들기 →</a><p class="sheet-note">${esc('새 재료는 하나씩, 반응을 기록해 두면 알레르기를 찾기 쉬워요. ' + HINT_COPY.solidStart)}</p>` : ''}`;
  openSheet(`${meta.emoji} ${meta.label}`, html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g) { onTimePick(g, f); return; }
      const fb = e.target.closest('[data-food]');
      if (fb) { $('foodInput').value = fb.dataset.food; return; }
      if (e.target.closest('[data-save]')) {
        const data = {};
        const food = $('foodInput').value.trim();
        if (food) data.food = food;
        if (f.amount) data.amount = f.amount;
        if (f.reaction) data.reaction = f.reaction;
        const res = logFromSheet(type, resolveTime(f), data);
        if (f.reaction === 'allergy') showToast('⚠️ 알레르기 의심 반응은 소아청소년과에 꼭 알려 주세요', 4500);
        void res;
      }
    },
  });
}

// ----- 체온 시트 -----
function openTempSheet() {
  const c = ctx();
  const f = { at: '0' };
  const html = `
    <div class="sec">
      <div class="amount-box">
        <button type="button" class="step-btn" data-tstep="-0.1" aria-label="0.1도 내리기">−0.1</button>
        <label class="amount-val"><input id="tempInput" type="number" inputmode="decimal" min="34" max="42.5" step="0.1" placeholder="36.8" aria-label="체온 (℃)" /><span class="unit">℃</span></label>
        <button type="button" class="step-btn" data-tstep="0.1" aria-label="0.1도 올리기">+0.1</button>
      </div>
    </div>
    <div class="sec"><div class="opts cols-3">${['36.5', '37.0', '37.5', '38.0', '38.5', '39.0'].map((v) => `<button type="button" class="opt" data-tval="${v}">${v}℃</button>`).join('')}</div></div>
    <div id="tempWarn"></div>
    ${timeRowHTML()}
    <div class="sheet-actions"><button class="btn btn-primary btn-block" data-save="1">기록하기</button></div>`;
  const warn = () => {
    const v = Number(String($('tempInput').value).replace(',', '.'));
    let w = '';
    if (v >= NORMS.feverC) {
      w = c.age != null && c.age < NORMS.feverUrgentUnderDays
        ? `<p class="sheet-note danger">🚨 ${esc(HINT_COPY.feverInfant)}</p>`
        : `<p class="sheet-note warn">${esc(HINT_COPY.fever)}</p>`;
      w += '<a class="sheet-link" href="../fever/">🌡️ 해열제 안심 계산기 →</a>';
    }
    $('tempWarn').innerHTML = w;
  };
  const setT = (v) => {
    const n = Math.round(Math.max(34, Math.min(42.5, v)) * 10) / 10;
    $('tempInput').value = n.toFixed(1);
    warn();
  };
  openSheet('🌡️ 체온', html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g) { onTimePick(g, f); return; }
      const st = e.target.closest('[data-tstep]');
      if (st) { setT((Number($('tempInput').value) || 36.8) + Number(st.dataset.tstep)); return; }
      const tv = e.target.closest('[data-tval]');
      if (tv) { setT(Number(tv.dataset.tval)); return; }
      if (e.target.closest('[data-save]')) {
        const v = Number(String($('tempInput').value).replace(',', '.'));
        if (!(v >= LIMITS.tempC[0] && v <= LIMITS.tempC[1])) { showToast('체온은 34.0~42.5℃ 사이로 적어 주세요'); return; }
        logFromSheet('temp', resolveTime(f), { c: Math.round(v * 10) / 10 });
      }
    },
    onInput: (e) => { if (e.target.id === 'tempInput') warn(); },
  });
}

// ----- 약 시트 -----
function openMedSheet() {
  const f = { at: '0' };
  const names = recentValues(['med'], 'name', 8);
  const html = `
    <div class="sec"><div class="sec-title">약 이름 <span class="sub">(선택)</span></div>
      <input class="field" id="medName" list="medList" maxlength="${LIMITS.medName}" placeholder="예: 해열제(챔프) 5ml" autocomplete="off" />
      <datalist id="medList">${names.map((x) => `<option value="${esc(x)}"></option>`).join('')}</datalist>
      ${names.length ? `<div class="opts" style="margin-top:8px">${names.slice(0, 5).map((x) => `<button type="button" class="opt" data-med="${esc(x)}" style="min-height:40px;font-size:13.5px">${esc(x)}</button>`).join('')}</div>` : ''}
    </div>
    <div class="sec"><div class="sec-title">메모 <span class="sub">(선택)</span></div>
      <input class="field" id="medNote" maxlength="${LIMITS.medNote}" placeholder="예: 열 38.4℃라서" autocomplete="off" /></div>
    ${timeRowHTML()}
    <div class="sheet-actions"><button class="btn btn-primary btn-block" data-save="1">기록하기</button></div>
    <p class="sheet-note">약 이름과 시각을 남겨 두면 교대할 때 두 번 먹이는 일을 막을 수 있어요.</p>
    <a class="sheet-link" href="../fever/">🌡️ 해열제 안심 계산기 (용량·다음 복용 시각) →</a>`;
  openSheet('💊 약', html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g) { onTimePick(g, f); return; }
      const mb = e.target.closest('[data-med]');
      if (mb) { $('medName').value = mb.dataset.med; return; }
      if (e.target.closest('[data-save]')) {
        const data = {};
        const n = $('medName').value.trim();
        const note = $('medNote').value.trim();
        if (n) data.name = n;
        if (note) data.note = note;
        logFromSheet('med', resolveTime(f), data);
      }
    },
  });
}

// ----- 변기 시트 (결과를 누르면 바로 기록) -----
function openPottySheet() {
  const f = { at: '0' };
  const t0 = startOfDay(Date.now());
  const stickers = live(state.events).filter((e) => e.type === 'potty' && e.ts >= t0 && (e.data?.result === 'pee' || e.data?.result === 'poop')).length;
  const html = `
    ${state.prefs.game ? `<p class="sheet-note" style="margin-top:4px;text-align:center;font-size:15px">오늘 스티커 ${stickers ? '⭐'.repeat(Math.min(stickers, 10)) : '아직 없어요'}</p>` : ''}
    <div class="sec"><div class="opts cols-2">${POTTY_RESULTS.map((r) => `<button type="button" class="opt" data-potty="${r.id}" style="min-height:72px;font-size:16px">${r.emoji} ${esc(r.label)}</button>`).join('')}</div></div>
    ${timeRowHTML()}
    <p class="sheet-note">${esc('실수해도 괜찮아요 — 혼내지 않고 성공만 크게 칭찬해 주세요')}</p>`;
  openSheet('🚽 변기', html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g) { onTimePick(g, f); return; }
      const b = e.target.closest('[data-potty]');
      if (b) {
        const r = POTTY_RESULTS.find((x) => x.id === b.dataset.potty);
        logFromSheet('potty', resolveTime(f), { result: r.id });
        if (r.success && state.prefs.game) {
          confetti(80);
          showToast(`🎉 스티커 +1 ⭐ 오늘 ${stickers + 1}개!`, 3000);
        }
      }
    },
  });
}

// ----- 메모 시트 -----
function openNoteSheet() {
  const f = { at: '0' };
  const html = `
    <div class="sec"><textarea class="field" id="noteText" maxlength="${LIMITS.noteText}" placeholder="예: 오후에 좀 보챘어요 · 분유 1통 남았어요"></textarea>
      <div class="counter"><span id="noteCount">0</span>/${LIMITS.noteText}</div></div>
    ${timeRowHTML()}
    <div class="sheet-actions"><button class="btn btn-primary btn-block" data-save="1">기록하기</button></div>
    <p class="sheet-note">메모는 교대 요약의 '특이사항'에 들어가요.</p>`;
  openSheet('📝 메모', html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g) { onTimePick(g, f); return; }
      if (e.target.closest('[data-save]')) {
        const text = $('noteText').value.trim();
        if (!text) { showToast('내용을 적어 주세요'); return; }
        logFromSheet('note', resolveTime(f), { text });
      }
    },
    onInput: (e) => { if (e.target.id === 'noteText') $('noteCount').textContent = Array.from(e.target.value).length; },
  });
}

// ----- 더보기 (전체 기록 종류) -----
function openMoreSheet() {
  const c = ctx();
  const ss = sleepState(state.events, c.now);
  const lastMap = lastByType(c.now);
  const all = visibleActions(c.age);
  const html = `
    <div class="more-grid">${all.map((id) => cellHTML(id, c, ss, lastMap)).join('')}</div>
    <p class="sheet-note">자주 쓰는 버튼은 <b>설정 → 퀵버튼 편집</b>에서 첫 화면에 올릴 수 있어요.</p>`;
  openSheet('⋯ 모든 기록', html, {
    onClick: (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const id = b.dataset.act;
      const meta = EVENT_TYPES[id] || ACTION_META[id];
      if (meta.input === 'tap' || meta.input === 'toggle') { closeSheet(); quickLog(id, null); }
      else onAction(id, b);   // 다른 시트로 바꿔 열림
    },
  });
}

// ============================================================
// 기록 고치기 시트 (시간·내용·누가·메모·지우기)
// ============================================================
function openEditSheet(ids) {
  const group = ids.map((id) => eventById(state, id)).filter(Boolean);
  if (!group.length) return;
  const e = group.find((x) => x.type === 'poop') || group[0];
  const t = Date.now();
  const c = ctx(t);
  const isBoth = group.length > 1;
  const meta = isBoth ? ACTION_META.both : typeMeta(e.type);
  const d = e.data || {};
  const f = {
    by: e.by || '',
    ml: d.ml != null ? String(d.ml) : null,
    burp: d.burp || '',
    side: d.side || 'both',
    min: d.min != null ? String(d.min) : null,
    color: d.color || null,
    texture: d.texture || null,
    amount: d.amount || null,
    reaction: d.reaction || null,
    result: d.result || null,
  };
  const origTs = toLocalInput(e.ts);
  const origEnd = d.end ? toLocalInput(d.end) : '';
  const members = state.members.filter((m) => !m.revoked || m.id === e.by);
  let fields = '';
  switch (e.type) {
    case 'formula': case 'pumped': case 'milk': case 'water': {
      const chips = amountChips(c.stage, e.type === 'water' ? 'water' : e.type, d.ml);
      fields += `<div class="sec"><div class="sec-title">양 (ml)</div>
        <input class="field" id="edMl" type="number" inputmode="numeric" min="1" max="500" value="${esc(f.ml ?? '')}" placeholder="${e.type === 'water' ? '선택' : '예: 120'}" />
        <div style="margin-top:8px">${optsHTML('ml', chips.map((v) => ({ id: String(v), label: String(v) })), f.ml, { cls: 'opts cols-4' })}</div></div>`;
      if (e.type === 'formula' || e.type === 'pumped') fields += `<div class="sec"><div class="sec-title">트림</div>${optsHTML('burp', BURP_ITEMS, f.burp, { cls: 'seg' })}</div>`;
      break;
    }
    case 'breast':
      fields += `<div class="sec"><div class="sec-title">방향</div>${optsHTML('side', BREAST_SIDES, f.side, { cls: 'seg' })}</div>
        <div class="sec"><div class="sec-title">시간</div>${optsHTML('min', [...new Set([...BREAST_MIN_CHIPS, ...(d.min ? [d.min] : [])])].sort((a, b) => a - b).map((m) => ({ id: String(m), label: `${m}분` })), f.min, { cls: 'opts cols-4', toggle: true })}</div>
        <div class="sec"><div class="sec-title">트림</div>${optsHTML('burp', BURP_ITEMS, f.burp, { cls: 'seg' })}</div>`;
      break;
    case 'poop':
      fields += `<div class="sec"><div class="sec-title">색 <span class="sub">화면에 따라 색이 달라 보일 수 있어요</span></div>
        ${optsHTML('color', POOP_COLORS.map((p) => ({ id: p.id, html: `<span class="swatch" style="background:${p.hex}"></span>${esc(p.label)}` })), f.color, { cls: 'opts cols-3', toggle: true })}
        <div id="poopNote"></div></div>
        <div class="sec"><div class="sec-title">굳기</div>${optsHTML('texture', POOP_TEXTURES, f.texture, { cls: 'opts cols-4', toggle: true })}</div>`;
      break;
    case 'tummy':
      fields += `<div class="sec"><div class="sec-title">시간</div>${optsHTML('min', [...new Set([...TUMMY_MIN_CHIPS, ...(d.min ? [d.min] : [])])].sort((a, b) => a - b).map((m) => ({ id: String(m), label: `${m}분` })), f.min, { cls: 'opts cols-4', toggle: true })}</div>`;
      break;
    case 'solid': case 'meal': case 'snack':
      fields += `<div class="sec"><div class="sec-title">무엇을</div><input class="field" id="edFood" maxlength="${LIMITS.food}" value="${esc(d.food || '')}" autocomplete="off" /></div>
        <div class="sec"><div class="sec-title">얼마나</div>${optsHTML('amount', FOOD_AMOUNTS, f.amount, { cls: 'opts cols-4', toggle: true })}</div>
        <div class="sec"><div class="sec-title">반응</div>${optsHTML('reaction', FOOD_REACTIONS.map((r) => ({ id: r.id, label: `${r.emoji} ${r.label}` })), f.reaction, { cls: 'opts cols-2', toggle: true })}</div>`;
      break;
    case 'temp':
      fields += `<div class="sec"><div class="sec-title">체온 (℃)</div><input class="field" id="edTemp" type="number" inputmode="decimal" step="0.1" min="34" max="42.5" value="${d.c != null ? esc(d.c.toFixed(1)) : ''}" /></div>`;
      break;
    case 'med':
      fields += `<div class="sec"><div class="sec-title">약 이름</div><input class="field" id="edMedName" maxlength="${LIMITS.medName}" value="${esc(d.name || '')}" autocomplete="off" /></div>
        <div class="sec"><div class="sec-title">메모</div><input class="field" id="edMedNote" maxlength="${LIMITS.medNote}" value="${esc(d.note || '')}" autocomplete="off" /></div>`;
      break;
    case 'potty':
      fields += `<div class="sec"><div class="sec-title">결과</div>${optsHTML('result', POTTY_RESULTS.map((r) => ({ id: r.id, label: `${r.emoji} ${r.label}` })), f.result, { cls: 'opts cols-2' })}</div>`;
      break;
    case 'note':
      fields += `<div class="sec"><div class="sec-title">내용</div><textarea class="field" id="edText" maxlength="${LIMITS.noteText}">${esc(d.text || '')}</textarea></div>`;
      break;
    case 'handoff':
      fields += `<div class="sec"><p class="sheet-note">교대 요약 범위: ${d.from && d.to ? `${esc(fmtDate(d.from))} ${esc(fmtTime(d.from))} ~ ${esc(fmtTime(d.to))}` : '—'}</p>
        <button class="btn btn-ghost btn-block" data-view-baton="1" style="margin-top:10px">요약 다시 보기</button></div>`;
      break;
    default:
      break;
  }
  const timeSec = e.type === 'sleep'
    ? `<div class="sec"><div class="sec-title">잠든 시각</div><input class="field" id="edTs" type="datetime-local" value="${esc(origTs)}" /></div>
       <div class="sec"><div class="sec-title">깬 시각</div>
         <div class="field-row"><input class="field" id="edEnd" type="datetime-local" value="${esc(origEnd)}" ${origEnd ? '' : 'disabled'} />
         <button type="button" class="opt${origEnd ? '' : ' on'}" id="edOngoing" aria-pressed="${!origEnd}">자는 중</button></div></div>`
    : `<div class="sec"><div class="sec-title">시각</div><input class="field" id="edTs" type="datetime-local" value="${esc(origTs)}" /></div>`;
  const whoSec = e.type === 'handoff' ? '' : `<div class="sec"><div class="sec-title">누가</div>${optsHTML('by', members.map((m) => ({ id: m.id, label: `${memberEmoji(m)} ${memberName(m)}` })), f.by, { cls: 'opts' })}</div>`;
  const noteSec = ['note', 'med', 'handoff'].includes(e.type) ? '' : `<div class="sec"><div class="sec-title">메모 <span class="sub">(선택)</span></div><input class="field" id="edNote" maxlength="${LIMITS.note}" value="${esc(d.note || '')}" autocomplete="off" /></div>`;
  const rejectedNote = group.some((x) => x.rejected) ? '<p class="sheet-note warn">⚠ 서버가 이 기록을 받지 않았어요. 내용을 확인하고 저장하면 다시 보내요.</p>' : '';
  const html = `${rejectedNote}${timeSec}${fields}${whoSec}${noteSec}
    <div class="sheet-actions">
      <button class="btn btn-primary btn-block" data-save="1">저장</button>
      <button class="btn btn-danger btn-block" data-del="1">🗑 이 기록 지우기</button>
    </div>`;
  const poopNote = () => {
    const box = $('poopNote');
    if (!box) return;
    const a = f.color ? poopAlert({ type: 'poop', data: { color: f.color } }, c.age) : null;
    box.innerHTML = a ? `<p class="sheet-note ${a.level === 'urgent' ? 'danger' : a.level === 'check' ? 'warn' : ''}">${esc(a.text)}</p>` : '';
  };
  openSheet(`${meta.emoji} ${isBoth ? '소변+대변' : meta.label} 고치기`, html, {
    onMount: poopNote,
    onClick: (ev) => {
      const g = pickOpt(ev, f);
      if (g === 'ml') { const el = $('edMl'); if (el) el.value = f.ml ?? ''; return; }
      if (g === 'color') { poopNote(); return; }
      if (g) return;
      if (ev.target.closest('#edOngoing')) {
        const b = $('edOngoing');
        const on = !b.classList.contains('on');
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        const end = $('edEnd');
        end.disabled = on;
        if (!on && !end.value) end.value = toLocalInput(Date.now());
        return;
      }
      if (ev.target.closest('[data-view-baton]')) { openBatonView(e.id); return; }
      if (ev.target.closest('[data-del]')) {
        const now = Date.now();
        for (const x of group) deleteEvent(state, x.id, now);
        closeSheet();
        commit();
        showUndo(`🗑 ${isBoth ? '소변+대변' : meta.label} 기록을 지웠어요`, {
          undo: () => { const n2 = Date.now(); for (const x of group) restoreEvent(state, x.id, n2); commit(); showToast('되살렸어요'); },
        });
        return;
      }
      if (ev.target.closest('[data-save]')) saveEdit();
    },
    onInput: (ev) => {
      if (ev.target.id === 'edMl') {
        f.ml = ev.target.value;
        for (const x of $('sheetBody').querySelectorAll('[data-grp="ml"]')) x.classList.toggle('on', x.dataset.val === String(Number(f.ml)));
      }
    },
  });

  function saveEdit() {
    const now = Date.now();
    const tsVal = $('edTs').value;
    const newTs = tsVal === origTs ? e.ts : fromLocalInput(tsVal);
    if (newTs == null) { showToast('시각을 확인해 주세요'); return; }
    if (newTs > now + 5 * MIN) { showToast('아직 오지 않은 시각이에요'); return; }
    const want = {};
    switch (e.type) {
      case 'formula': case 'pumped': case 'milk': case 'water': {
        const raw = $('edMl').value.trim();
        const ml = raw === '' ? null : Math.round(Number(raw));
        if (ml != null && !(ml >= LIMITS.ml[0] && ml <= LIMITS.ml[1])) { showToast('양은 1~500ml 사이로 적어 주세요'); return; }
        if (ml == null && e.type !== 'water') { showToast('양을 적어 주세요'); return; }
        want.ml = ml;
        if (e.type === 'formula' || e.type === 'pumped') want.burp = f.burp || null;
        break;
      }
      case 'breast': want.side = f.side || 'both'; want.min = f.min ? Number(f.min) : null; want.burp = f.burp || null; break;
      case 'poop': want.color = f.color || null; want.texture = f.texture || null; break;
      case 'tummy': want.min = f.min ? Number(f.min) : null; break;
      case 'solid': case 'meal': case 'snack':
        want.food = $('edFood').value.trim() || null; want.amount = f.amount || null; want.reaction = f.reaction || null; break;
      case 'temp': {
        const v = Number(String($('edTemp').value).replace(',', '.'));
        if (!(v >= LIMITS.tempC[0] && v <= LIMITS.tempC[1])) { showToast('체온은 34.0~42.5℃ 사이로 적어 주세요'); return; }
        want.c = Math.round(v * 10) / 10;
        break;
      }
      case 'med': want.name = $('edMedName').value.trim() || null; want.note = $('edMedNote').value.trim() || null; break;
      case 'potty': want.result = f.result; break;
      case 'note': {
        const text = $('edText').value.trim();
        if (!text) { showToast('내용을 적어 주세요'); return; }
        want.text = text;
        break;
      }
      case 'sleep': {
        const ongoing = $('edOngoing').classList.contains('on');
        if (ongoing) want.end = null;
        else {
          const ev = $('edEnd').value;
          const end = ev === origEnd && d.end ? d.end : fromLocalInput(ev);
          if (end == null) { showToast('깬 시각을 확인해 주세요'); return; }
          if (end < newTs) { showToast('깬 시각이 잠든 시각보다 빨라요'); return; }
          if (end > now + 5 * MIN) { showToast('깬 시각이 아직 오지 않았어요'); return; }
          if (end - newTs > 24 * HOUR) { showToast('24시간이 넘는 잠이에요 — 시각을 확인해 주세요'); return; }
          want.end = end;
        }
        break;
      }
      default: break;
    }
    const noteEl = $('edNote');
    if (noteEl) want.note = noteEl.value.trim() || null;
    // 바뀐 것만 patch (안 바뀌었으면 updatedAt 을 올리지 않는다)
    const dataPatch = {};
    for (const [k, v] of Object.entries(want)) {
      const cur = d[k] ?? null;
      if (String(cur) !== String(v ?? null)) dataPatch[k] = v;
    }
    const byNew = f.by || null;
    let changed = false;
    for (const x of group) {
      const patch = {};
      if (newTs !== x.ts && (x === e || x.ts === e.ts)) patch.ts = newTs;
      if (e.type !== 'handoff' && byNew !== (x.by ?? null) && (x === e || (x.by ?? null) === (e.by ?? null))) patch.by = byNew;
      if (x === e && Object.keys(dataPatch).length) patch.data = dataPatch;
      if (x.rejected && !Object.keys(patch).length) patch.data = {};   // 거부된 기록: 저장만 눌러도 다시 보내기
      if (Object.keys(patch).length) { updateEvent(state, x.id, patch, now); changed = true; }
    }
    closeSheet();
    if (changed) { commit(); showToast('고쳤어요'); }
  }
}

// ============================================================
// 교대 요약 · 바통
// ============================================================
function openHandoffSheet() {
  const t = Date.now();
  const myLast = [...live(state.events)].reverse().find((e) => e.by === state.meId && e.ts < t - 10 * MIN && e.type !== 'handoff');
  const ranges = [
    { id: '3', label: '최근 3시간' }, { id: '6', label: '6시간' }, { id: '12', label: '12시간' }, { id: '24', label: '24시간' },
  ];
  if (myLast) ranges.push({ id: 'mine', label: '내 마지막 기록 뒤부터' });
  const f = { range: '12' };
  const compute = () => {
    const now = Date.now();
    const from = f.range === 'mine' && myLast ? myLast.ts : now - Number(f.range) * HOUR;
    const c = ctx(now);
    return { from, to: now, text: handoffText({ family: state.family, members: state.members, events: state.events, from, to: now, now, stage: c.stage, ageDays: c.age }) };
  };
  const draw = () => { $('handoffPre').textContent = compute().text; };
  const html = `
    <div class="sec"><div class="sec-title">범위</div>${optsHTML('range', ranges, f.range, { cls: 'opts' })}</div>
    <div class="sec"><div class="sec-title">미리 보기 <span class="sub">카톡에 이대로 붙어요</span></div><div class="pre" id="handoffPre"></div></div>
    <div class="sheet-actions">
      <button class="btn btn-primary btn-block" data-baton="1">📋 바통 넘기기 · 카톡으로 보내기</button>
      <button class="btn btn-ghost btn-block" data-copy="1">복사만 하기</button>
    </div>
    <p class="sheet-note">바통을 넘기면 가족 앱에도 '바통' 기록이 남고, 받는 사람이 <b>받았어요</b>를 누르면 확인 표시가 돼요. 사람별 횟수는 넣지 않아요.</p>`;
  openSheet('📋 교대 요약', html, {
    onMount: draw,
    onClick: async (e) => {
      if (pickOpt(e, f)) { draw(); return; }
      if (e.target.closest('[data-copy]')) {
        const { text } = compute();
        await copyText(text, '요약을 복사했어요 — 카톡에 붙여 넣어 주세요');
        state.prefs.handoffCount = (state.prefs.handoffCount || 0) + 1;
        save(state);
        return;
      }
      if (e.target.closest('[data-baton]')) {
        const { from, to, text } = compute();
        const r = await shareText(text, `${babyName()} 교대 요약`);
        if (r === 'cancel') { showToast('보내기를 취소했어요'); return; }
        addEvent(state, { type: 'handoff', data: { from, to } }, Date.now());
        state.prefs.handoffCount = (state.prefs.handoffCount || 0) + 1;
        closeSheet();
        commit();
        showToast('📋 바통을 넘겼어요 — 수고 많았어요 💛', 3000);
      }
    },
  });
}

function openBatonView(id) {
  const e = eventById(state, id);
  if (!e) return;
  const from = e.data?.from ?? e.ts - 12 * HOUR;
  const to = e.data?.to ?? e.ts;
  const c = ctx(to);
  const text = handoffText({ family: state.family, members: state.members, events: state.events, from, to, now: to, stage: c.stage, ageDays: c.age });
  const acked = state.events.some((x) => !x.deleted && x.type === 'ack' && x.by === state.meId && x.data?.target === id);
  const canAck = e.by && e.by !== state.meId && !acked;
  openSheet(`📋 ${subj(memberName(mem(e.by)))} 넘긴 바통`, `
    <div class="pre">${esc(text)}</div>
    <div class="sheet-actions">
      ${canAck ? `<button class="btn btn-primary btn-block" data-ack="${esc(id)}">✅ 받았어요</button>` : `<p class="sheet-note">${acked ? '✅ 받았다고 표시했어요' : ''}</p>`}
      <button class="btn btn-ghost btn-block" data-copy="1">복사</button>
    </div>`, {
    onClick: (ev) => {
      if (ev.target.closest('[data-copy]')) { copyText(text); return; }
      const a = ev.target.closest('[data-ack]');
      if (a) { closeSheet(); ackBaton(a.dataset.ack); }
    },
  });
}

function ackBaton(id) {
  const e = eventById(state, id);
  if (!e) return;
  if (state.events.some((x) => !x.deleted && x.type === 'ack' && x.by === state.meId && x.data?.target === id)) return;
  addEvent(state, { type: 'ack', data: { target: id } }, Date.now());
  commit();
  vibrate();
  showToast(`✅ 바통 받았어요 — ${memberName(mem(e.by))}에게 💛도 보내 볼까요?`, 3500);
}

function toggleThanks(targetId) {
  const target = eventById(state, targetId);
  if (!target || !target.by || target.by === state.meId) return;
  const mine = state.events.filter((e) => !e.deleted && e.type === 'thanks' && e.by === state.meId && e.data?.target === targetId);
  const now = Date.now();
  if (mine.length) {
    for (const x of mine) deleteEvent(state, x.id, now);
    commit();
    showToast('고마워요를 취소했어요');
    return;
  }
  addEvent(state, { type: 'thanks', data: { target: targetId } }, now);
  commit();
  vibrate(10);
  showToast(`💛 ${memberName(mem(target.by))}에게 고마움을 전했어요`);
}

// ============================================================
// 단계(레벨) · 도감 · 레벨업
// ============================================================
function openStageSheet() {
  const c = ctx();
  if (c.age == null) { openSettingsSheet(); return; }
  const game = state.prefs.game;
  const items = STAGES.map((s, i) => {
    const cls = i < c.st.index ? 'past' : i === c.st.index ? 'cur' : 'lock';
    const unl = s.unlocks.length ? `새 버튼: ${s.unlocks.map((id) => `${typeMeta(id).emoji} ${typeMeta(id).label}`).join(' · ')}` : '';
    const when = s.fromDay === 0 ? '태어나서부터' : `생후 ${s.fromDay}일부터`;
    return `<li class="rm ${cls}">
      <span class="rm-emo">${i > c.st.index ? '🔒' : s.emoji}</span>
      <div class="rm-body">
        <div class="rm-name">${game ? `Lv.${s.lv} ` : ''}${esc(s.name)} ${i === c.st.index ? '<span class="chip chip-brand">지금</span>' : i < c.st.index ? '✓' : ''}</div>
        <div class="rm-sub">${esc(when)} · ${esc(s.title)}${unl ? `<br />${esc(unl)}` : ''}</div>
      </div></li>`;
  }).join('');
  const tips = c.stage.tips.map((x) => `<li>${esc(x)}</li>`).join('');
  openSheet(`${c.stage.emoji} ${game ? `Lv.${c.stage.lv} ` : ''}${c.stage.name}`, `
    <p class="sheet-note" style="margin-top:4px">${esc(c.stage.intro)}${c.st.next ? ` · 다음 단계 '${esc(c.st.next.name)}'까지 ${c.st.daysToNext}일` : ''}</p>
    <div class="sec"><div class="sec-title">이 시기 참고</div><ul class="dots">${tips}</ul></div>
    <div class="sec"><div class="sec-title">성장 로드맵 <span class="sub">레벨은 기록 수가 아니라 아기 나이로 올라가요</span></div><ul class="roadmap">${items}</ul></div>
    <p class="sheet-note">😴 ${esc(SAFE_SLEEP)}</p>`);
}

function openDexSheet() {
  const c = ctx();
  const earned = earnedBadges({ events: state.events, members: state.members, family: state.family, now: c.now, prefs: state.prefs });
  const fresh = new Set(newBadges(earned, state.prefs));
  const card = (b) => {
    const got = earned.has(b.id);
    return `<div class="dex-card${got ? '' : ' lock'}">${fresh.has(b.id) ? '<span class="d-new">NEW</span>' : ''}
      <div class="d-emo">${got ? b.emoji : '🔒'}</div><div class="d-name">${esc(b.name)}</div><div class="d-desc">${esc(b.desc)}</div></div>`;
  };
  const baby = BADGES.filter((b) => b.kind === 'baby');
  const teamB = BADGES.filter((b) => b.kind !== 'baby');
  openSheet(`📖 도감 ${earned.size}/${BADGES.length}`, `
    <div class="sec"><div class="sec-title">👶 아기의 처음</div><div class="dex">${baby.map(card).join('')}</div></div>
    <div class="sec"><div class="sec-title">🤝 우리 팀</div><div class="dex">${teamB.map(card).join('')}</div></div>
    <p class="sheet-note">도감은 누가 더 했는지가 아니라, 아기와 우리 팀의 '처음'을 모아요.</p>`, {
    onClose: () => {
      if (fresh.size) {
        state.prefs.seenBadges = [...new Set([...(state.prefs.seenBadges || []), ...fresh])];
        save(state);
        render();
      }
    },
  });
}

function showLevelUp(prev, c) {
  const game = state.prefs.game;
  const prevGrid = gridFor(prev, c.age, state.prefs);
  const unlocks = c.grid.filter((id) => !prevGrid.includes(id));
  const retires = prevGrid.filter((id) => !c.grid.includes(id));
  const lbl = (id) => `${typeMeta(id).emoji} ${typeMeta(id).label}`;
  const list = [
    unlocks.length ? `<div><b>새로 열린 기록:</b> ${esc(unlocks.map(lbl).join(' · '))}</div>` : '',
    retires.length ? `<div><b>이제 덜 쓰는 버튼:</b> ${esc(retires.map(lbl).join(' · '))} (더보기에 있어요)</div>` : '',
    `<div>${esc(c.stage.intro)}</div>`,
  ].join('');
  ask({
    top: `<div class="evolve"><span class="from">${prev.emoji}</span><span class="arrow">→</span><span class="to">${c.stage.emoji}</span></div>`,
    title: game ? '🎉 레벨 업!' : '새 단계가 시작됐어요',
    body: `${nameSubj(babyName())} '${game ? `Lv.${c.stage.lv} ` : ''}${c.stage.name}' 단계에 올라왔어요`,
    html: `<div class="m-list">${list}</div>`,
    buttons: [{ label: '좋아요', value: true, kind: 'primary' }],
    dismiss: true,
  }).then(() => {
    if (game) confetti(90);   // 글을 다 읽고 누른 뒤에 축하 (모달 글자를 가리지 않게)
    render();
  });
}

// ============================================================
// 모달 (확인 · 선택 · 레벨업) — 하나씩 차례로
// ============================================================
const modalQ = [];
let modalBusy = false;
function ask(opts) {
  return new Promise((resolve) => { modalQ.push({ opts, resolve }); pumpModal(); });
}
function pumpModal() {
  if (modalBusy || !modalQ.length) return;
  modalBusy = true;
  const { opts, resolve } = modalQ.shift();
  const el = $('modal');
  const kinds = { primary: 'btn-primary', ghost: 'btn-ghost', danger: 'btn-danger' };
  el.innerHTML = `${opts.top || ''}${opts.emoji ? `<div class="m-emoji">${opts.emoji}</div>` : ''}
    <h3>${esc(opts.title || '')}</h3>${opts.body ? `<p>${esc(opts.body)}</p>` : ''}${opts.html || ''}
    <div class="m-btns">${(opts.buttons || []).map((b, i) => `<button class="btn ${kinds[b.kind] || 'btn-ghost'}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
  $('modalDim').classList.remove('hidden');
  const done = (v) => {
    $('modalDim').classList.add('hidden');
    el.innerHTML = '';
    el.onclick = null;
    $('modalDim').onclick = null;
    modalBusy = false;
    resolve(v);
    setTimeout(pumpModal, 60);
  };
  el.onclick = (e) => {
    const b = e.target.closest('[data-i]');
    if (b) done(opts.buttons[Number(b.dataset.i)].value);
  };
  $('modalDim').onclick = (e) => { if (e.target === $('modalDim') && 'dismiss' in opts) done(opts.dismiss); };
  setTimeout(() => el.querySelector('.btn')?.focus({ preventScroll: true }), 30);
}

function confetti(n = 70) {
  if (!state.prefs.game) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  const colors = ['#E86A4E', '#E8A93D', '#5E9C82', '#4A7FB5', '#C2577E', '#F3C94E'];
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.style.left = `${Math.random() * 100}%`;
    p.style.background = colors[i % colors.length];
    p.style.animationDuration = `${1.6 + Math.random() * 1.4}s`;
    p.style.animationDelay = `${Math.random() * 0.4}s`;
    p.style.setProperty('--dx', `${Math.round(Math.random() * 160 - 80)}px`);
    p.style.setProperty('--rot', `${Math.round(Math.random() * 720 - 360)}deg`);
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3600);
}

// ============================================================
// 나(기록하는 사람) 바꾸기 · 구성원
// ============================================================
function openMeSheet(adding = false) {
  const list = activeMembers();
  const f = { role: 'grandma' };
  const linked = state.sync.token && state.sync.memberId ? mem(state.sync.memberId) : null;
  const html = `
    <ul class="mlist">${list.map((m) => `
      <li><button class="mrow${m.id === state.meId ? ' on' : ''}" data-me="${esc(m.id)}">
        <span class="m-emo">${esc(memberEmoji(m))}</span>
        <span class="m-body"><span class="m-name">${esc(memberName(m))}</span><span class="m-sub" style="display:block">${esc(ROLE_BY_ID[m.role]?.label || '')}${m.isAdmin ? ' · 👑' : ''}</span></span>
        ${m.id === state.meId ? '<span class="m-tag ok">지금 기록 중</span>' : ''}
      </button></li>`).join('')}</ul>
    ${linked ? `<p class="sheet-note">이 기기는 <b>${esc(euro(memberName(linked)))}</b> 가족에 연결돼 있어요. 다른 사람을 고르면 그 사람 이름으로 대신 기록해요 (예: 할머니 폰이 없을 때).</p>` : '<p class="sheet-note">한 폰을 여럿이 쓸 때, 지금 기록하는 사람을 골라 주세요.</p>'}
    <div class="sec" id="addBox"${adding ? '' : ' hidden'}>
      <div class="sec-title">새 사람</div>
      <div class="role-chips">${ROLES.map((r) => `<button type="button" class="opt${r.id === f.role ? ' on' : ''}" data-grp="role" data-val="${r.id}">${r.emoji} ${esc(r.label)}</button>`).join('')}</div>
      <input class="field" id="addName" maxlength="${LIMITS.memberName}" placeholder="${esc(NAME_PLACEHOLDER.default)}" style="margin-top:10px" autocomplete="off" />
      <button class="btn btn-primary btn-block" data-add-save="1" style="margin-top:10px">추가하고 이 사람으로 기록</button>
    </div>
    ${adding ? '' : '<button class="btn btn-ghost btn-block" data-add="1" style="margin-top:14px">+ 사람 추가</button>'}`;
  openSheet('누가 기록하나요?', html, {
    onClick: (e) => {
      const g = pickOpt(e, f);
      if (g === 'role') {
        $('addName').placeholder = f.role === 'sitter' ? NAME_PLACEHOLDER.sitter : NAME_PLACEHOLDER.default;
        return;
      }
      const b = e.target.closest('[data-me]');
      if (b) {
        setMe(state, b.dataset.me);
        closeSheet();
        commit();
        showToast(`이제 ${euro(memberName(me(state)))} 기록해요`);
        return;
      }
      if (e.target.closest('[data-add]')) { openMeSheet(true); return; }
      if (e.target.closest('[data-add-save]')) {
        const r = ROLE_BY_ID[f.role] || ROLE_BY_ID.other;
        const m = upsertMember(state, { role: r.id, name: $('addName').value.trim() || r.label, emoji: r.emoji }, Date.now());
        setMe(state, m.id);
        closeSheet();
        commit();
        showToast(`${memberName(m)} 추가! 이제 ${euro(memberName(m))} 기록해요`);
      }
    },
  });
}

function openMemberSheet(id) {
  const m = mem(id);
  if (!m) return;
  const f = { role: m.role };
  const shared = !!state.sync.token && !state.sync.revoked;
  const iAmAdmin = shared && state.sync.isAdmin;
  const self = m.id === state.sync.memberId || (!shared && m.id === state.meId);
  const emojis = [...new Set([m.emoji, ...ROLES.map((r) => r.emoji), '👩‍🦰', '🧔', '👱‍♀️', '🧑', '👩‍🍼', '👨‍🍼'])].filter(Boolean);
  const html = `
    <div class="sec"><div class="sec-title">이름</div><input class="field" id="mName" maxlength="${LIMITS.memberName}" value="${esc(m.name)}" autocomplete="off" /></div>
    <div class="sec"><div class="sec-title">역할</div><div class="role-chips">${ROLES.map((r) => `<button type="button" class="opt${r.id === f.role ? ' on' : ''}" data-grp="role" data-val="${r.id}">${r.emoji} ${esc(r.label)}</button>`).join('')}</div></div>
    <div class="sec"><div class="sec-title">이모지</div><div class="opts">${emojis.map((x) => `<button type="button" class="opt${x === m.emoji ? ' on' : ''}" data-grp="emoji" data-val="${esc(x)}" style="font-size:22px;min-width:52px">${esc(x)}</button>`).join('')}</div></div>
    <div class="sheet-actions"><button class="btn btn-primary btn-block" data-save="1">저장</button></div>
    ${iAmAdmin && !self ? `
      <div class="divider"></div>
      <div class="sec"><div class="sec-title">관리 (👑 관리자)</div>
        <div class="sheet-actions" style="margin-top:0">
          <button class="btn btn-ghost btn-block" data-admin="${m.isAdmin ? 0 : 1}">${m.isAdmin ? '관리자 해제' : '👑 관리자로 지정'}</button>
          ${m.claimed ? '<button class="btn btn-ghost btn-block" data-unlink="1">기기 연결만 끊기 (폰을 잃어버렸을 때)</button>' : ''}
          <button class="btn btn-danger btn-block" data-remove="1">가족에서 내보내기</button>
        </div>
        <p class="sheet-note">내보내도 그동안의 기록은 남아요. 그 사람의 기기 연결은 끊겨요.</p></div>` : ''}`;
  f.emoji = m.emoji;
  openSheet(`${m.emoji} ${memberName(m)}`, html, {
    onClick: async (e) => {
      if (pickOpt(e, f)) return;
      if (e.target.closest('[data-save]')) {
        upsertMember(state, { id: m.id, name: $('mName').value.trim(), role: f.role, emoji: f.emoji }, Date.now());
        commit();
        openSettingsSheet();
        showToast('저장했어요');
        return;
      }
      const busy = async (btn, fn, okMsg) => {
        btn.disabled = true;
        try { await fn(); save(state); render(); showToast(okMsg); openSettingsSheet(); } catch (err) { showToast(errMsg(err), 3500); btn.disabled = false; }
      };
      const ad = e.target.closest('[data-admin]');
      if (ad) { await busy(ad, () => setAdmin(state, m.id, ad.dataset.admin === '1'), ad.dataset.admin === '1' ? '관리자로 지정했어요' : '관리자를 해제했어요'); return; }
      const ul = e.target.closest('[data-unlink]');
      if (ul) {
        const ok = await ask({ emoji: '📵', title: `${memberName(m)}의 기기 연결을 끊을까요?`, body: '가족에서 내보내지는 않아요. 새 폰에서 초대 링크로 다시 이 사람을 고르면 돼요.', buttons: [{ label: '끊기', value: true, kind: 'danger' }, { label: '취소', value: false }], dismiss: false });
        if (ok) await busy(ul, () => unlinkMember(state, m.id), '기기 연결을 끊었어요');
        return;
      }
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        const ok = await ask({ emoji: '🚪', title: `${memberName(m)}님을 가족에서 내보낼까요?`, body: '그동안의 기록은 남고, 그 사람의 기기 연결은 끊겨요.', buttons: [{ label: '내보내기', value: true, kind: 'danger' }, { label: '취소', value: false }], dismiss: false });
        if (ok) await busy(rm, () => removeMember(state, m.id), '내보냈어요');
      }
    },
  });
}

// ============================================================
// 가족 공유: 초대 · 참여 · 상태
// ============================================================
function inviteMessage(link) {
  return `${babyName()} 육아일지에 초대해요 👶\n링크를 눌러 '나는 누구'만 고르면 끝!\n(아이폰은 사파리로 열어 주세요)\n${link}`;
}

function openInviteSheet() {
  const shared = !!state.sync.token && !state.sync.revoked;
  if (!canShare()) {
    openSheet('👨‍👩‍👧 가족 초대', `
      <div class="honest">🌱 <b>가족 공유는 곧 열려요.</b><br />지금은 기록이 이 기기(브라우저)에만 저장돼요. 공유가 열리면 초대 링크 하나로 엄마·아빠·시터가 같은 기록을 보게 돼요.</div>
      <p class="sheet-note">그때까지는 한 폰을 같이 쓰면서 오른쪽 위 <b>나 ·</b> 버튼으로 기록하는 사람을 바꿔 주세요. 폰을 바꿀 땐 <b>설정 → JSON 백업</b>으로 옮길 수 있어요.</p>`);
    return;
  }
  if (!shared) {
    const n = live(state.events).length;
    openSheet('👨‍👩‍👧 가족 초대', `
      <div class="honest">가족 공유를 켜면 <b>초대 링크</b>가 만들어져요. 링크를 받은 가족은 가입 없이 '나는 누구'만 고르면 같은 기록을 함께 써요.</div>
      <ul class="dots" style="margin-top:12px">
        <li>지금 이 기기의 기록 ${n}개와 구성원이 가족 공간으로 올라가요.</li>
        <li>기록은 초대받은 가족만 볼 수 있어요. 누가 기록했는지는 정보로만 보여요.</li>
        <li>인터넷이 끊겨도 기록은 이 기기에 먼저 저장되고, 연결되면 보내져요.</li>
      </ul>
      <div class="sheet-actions"><button class="btn btn-primary btn-block" data-create="1">가족 공유 켜기</button></div>`, {
      onClick: async (e) => {
        const b = e.target.closest('[data-create]');
        if (!b) return;
        b.disabled = true;
        b.textContent = '만드는 중…';
        try {
          await createFamily(state, Date.now());
          markAllSeen();
          commit();
          showToast('가족 공유를 켰어요 🎉');
          openInviteSheet();
        } catch (err) {
          showToast(errMsg(err), 3500);
          b.disabled = false;
          b.textContent = '가족 공유 켜기';
        }
      },
    });
    return;
  }
  const code = state.sync.invite;
  const link = code ? inviteLink(code) : '';
  const admin = state.sync.isAdmin;
  const adminNames = state.members.filter((m) => m.isAdmin && !m.revoked).map((m) => memberName(m)).join('·');
  const html = `
    ${link ? `
      <div class="sec"><div class="sec-title">초대 링크</div><div class="invite-link">${esc(link)}</div></div>
      <div class="sheet-actions">
        <button class="btn btn-primary btn-block" data-share="1">💬 카카오톡 등으로 보내기</button>
        <button class="btn btn-ghost btn-block" data-copy="1">링크 복사</button>
      </div>
      <p class="sheet-note">💡 아이폰은 링크를 <b>사파리로</b> 여세요 (카톡 안에서 열면 따로 저장돼요). 홈 화면 앱에서는 링크를 붙여 넣으면 돼요.</p>`
    : `<div class="honest">${admin ? '초대 링크를 새로 만들어 보내 주세요.' : `초대 링크는 관리자(👑 ${esc(adminNames || '만든 사람')})가 보낼 수 있어요.`}</div>`}
    ${admin ? `<button class="btn btn-ghost btn-block" data-rotate="1" style="margin-top:10px">${link ? '🔄 새 초대 링크 만들기 (옛 링크는 막혀요)' : '초대 링크 만들기'}</button>` : ''}
    <div class="divider"></div>
    <div class="sec"><div class="sec-title">📱 내 다른 기기에서도 쓰기</div>
      <p class="sheet-note" style="margin-top:0">사파리에서 쓰다가 홈 화면 앱으로 옮길 때, 태블릿에서도 쓸 때 — 1회용 연결 코드(15분)를 만들어 새 기기에서 붙여 넣으세요.</p>
      <div id="devBox"></div>
      <button class="btn btn-ghost btn-block" data-dev="1" style="margin-top:8px">연결 코드 만들기</button>
    </div>`;
  openSheet('👨‍👩‍👧 가족 초대', html, {
    onClick: async (e) => {
      if (e.target.closest('[data-share]')) { await shareText(inviteMessage(link), '육아일지 초대'); return; }
      if (e.target.closest('[data-copy]')) { copyText(link, '초대 링크를 복사했어요'); return; }
      const rot = e.target.closest('[data-rotate]');
      if (rot) {
        if (link) {
          const ok = await ask({ emoji: '🔄', title: '새 초대 링크를 만들까요?', body: '지금 링크로는 더 이상 참여할 수 없어요. 이미 참여한 가족은 그대로예요.', buttons: [{ label: '새로 만들기', value: true, kind: 'primary' }, { label: '취소', value: false }], dismiss: false });
          if (!ok) return;
        }
        rot.disabled = true;
        try { await rotateInvite(state); save(state); openInviteSheet(); showToast('새 초대 링크를 만들었어요'); } catch (err) { showToast(errMsg(err), 3500); rot.disabled = false; }
        return;
      }
      const dv = e.target.closest('[data-dev]');
      if (dv) {
        dv.disabled = true;
        try {
          const r = await createDeviceLink(state);
          const until = r.expiresAt ? fmtHM(r.expiresAt) : '15분 뒤';
          $('devBox').innerHTML = `<div class="code-big">${esc(r.code)}</div>
            <div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
              <button class="btn btn-ghost btn-sm" data-devcopy="${esc(r.code)}">코드 복사</button>
              <button class="btn btn-ghost btn-sm" data-devlink="${esc(r.link)}">링크 복사</button></div>
            <p class="sheet-note">${esc(until)}까지 한 번만 쓸 수 있어요. 새 기기에서 <b>초대 링크를 받았어요</b> → 붙여넣기.</p>`;
        } catch (err) { showToast(errMsg(err), 3500); }
        dv.disabled = false;
        return;
      }
      const dc = e.target.closest('[data-devcopy]');
      if (dc) { copyText(dc.dataset.devcopy, '코드를 복사했어요'); return; }
      const dl = e.target.closest('[data-devlink]');
      if (dl) copyText(dl.dataset.devlink, '연결 링크를 복사했어요');
    },
  });
}

// 참여 직후·공유 시작 직후: 이미 있던 도감·고마워요는 '본 것'으로 (알림 폭탄 방지)
function markAllSeen() {
  const c = ctx();
  const p = state.prefs;
  p.seenStage = p.seenStage || c.stage.id;
  p.seenBadges = [...earnedBadges({ events: state.events, members: state.members, family: state.family, now: c.now, prefs: p })];
  p.seenThanks = seenReactionIds();
}

function openJoinSheet(prefill = '') {
  if (!canShare()) {
    openSheet('💌 초대 링크로 참여', `
      <div class="honest">🌱 <b>가족 공유는 곧 열려요.</b> 지금은 초대 링크로 참여할 수 없어요.</div>
      <p class="sheet-note">먼저 이 기기에서 시작해 두면, 공유가 열렸을 때 기록을 그대로 합칠 수 있어요.</p>`);
    return;
  }
  const inviteCode = parseJoin(prefill)?.code || '';
  const iosTip = isIOS && !isStandalone && inviteCode ? `
    <p class="sheet-note">📲 <b>홈 화면에 추가해서 쓰실 거면:</b> ① 사파리 공유 → 홈 화면에 추가 ② 앱을 열고 <b>초대 링크를 받았어요</b>에 이 코드를 붙여넣기
      <button class="btn btn-ghost btn-sm" data-copycode="${esc(inviteCode)}" style="margin-top:8px;width:100%">코드 복사 (${esc(inviteCode)})</button></p>` : '';
  const html = `
    <div class="sec"><div class="sec-title">초대 링크나 코드</div>
      <div class="field-row"><input class="field" id="joinInput" value="${esc(prefill)}" placeholder="링크 또는 16자리 코드 붙여넣기" autocomplete="off" autocapitalize="characters" />
      <button class="btn btn-primary btn-sm" data-peek="1">확인</button></div></div>
    ${iosTip}
    <div id="joinBody"></div>`;
  openSheet('💌 초대 링크로 참여', html, {
    history: false,
    onMount: () => {
      if (prefill) doPeek();
      $('joinInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doPeek(); } });
    },
    onClick: async (e) => {
      if (e.target.closest('[data-peek]')) { doPeek(); return; }
      const cc = e.target.closest('[data-copycode]');
      if (cc) { copyText(cc.dataset.copycode, '코드를 복사했어요'); return; }
      if (joinCtl.onClick) joinCtl.onClick(e);
    },
  });
}

const joinCtl = { onClick: null };
async function doPeek() {
  const input = $('joinInput');
  const body = $('joinBody');
  if (!input || !body) return;
  const text = input.value.trim();
  if (!text) { showToast('링크나 코드를 붙여 넣어 주세요'); return; }
  body.innerHTML = '<p class="sheet-note">확인하는 중…</p>';
  let info;
  try {
    info = await peekInvite(text);
  } catch (err) {
    body.innerHTML = `<p class="sheet-note warn">${esc(errMsg(err))}</p>`;
    return;
  }
  if (!$('joinBody')) return;
  const famName = info.family?.name || '우리 아기';
  const f = { claim: null, role: null };
  // 이미 이 가족과 공유 중인 기기가 초대 링크를 다시 연 경우 (카톡에서 링크를 또 누름 등)
  if (state.sync.token && !state.sync.revoked && info.kind !== 'device' && famName === (state.family.name || '우리 아기')) {
    pendingJoin = '';
    stripJoinHash();
    body.innerHTML = `<div class="honest">👍 이 기기는 이미 <b>${esc(famName)} 육아일지</b>와 공유 중이에요.</div>
      <p class="sheet-note">다른 가족에 참여하려면 설정 → 공유 → 이 기기 공유 끊기를 먼저 해 주세요.</p>`;
    joinCtl.onClick = null;
    return;
  }
  if (info.kind === 'device') {
    const m = info.member || info.members[0] || {};
    body.innerHTML = `
      <div class="honest">📱 이 기기를 <b>${esc(famName)} 육아일지</b>의 <b>${esc(m.emoji || '')} ${esc(euro(m.name || '가족'))}</b> 연결해요.</div>
      <div class="sheet-actions"><button class="btn btn-primary btn-block" data-join="1">연결하기</button></div>`;
  } else {
    const names = info.members.filter((m) => m.claimed).map((m) => m.name).join('·');
    body.innerHTML = `
      <div class="honest"><b>${esc(famName)} 육아일지</b>${names ? ` (${esc(names)} 참여중)` : ''}</div>
      ${info.members.length ? `<div class="sec"><div class="sec-title">저는 이 사람이에요</div>
        <div class="opts cols-2">${info.members.map((m) => `<button type="button" class="opt" data-grp="claim" data-val="${esc(m.id)}" ${m.claimed ? 'disabled' : ''}>${esc(m.emoji || '🙂')} ${esc(m.name)}${m.claimed ? '<small style="display:block;font-size:11px;font-weight:600">이미 연결됨</small>' : ''}</button>`).join('')}</div>
        ${info.members.some((m) => m.claimed) ? '<p class="sheet-note">이미 연결된 사람의 새 기기라면: 그 사람 폰의 <b>가족 초대 → 내 다른 기기에서도 쓰기</b> 코드를 붙여 넣어 주세요.</p>' : ''}</div>` : ''}
      <div class="sec"><div class="sec-title">처음 참여해요</div>
        <div class="role-chips">${ROLES.map((r) => `<button type="button" class="opt" data-grp="role" data-val="${r.id}">${r.emoji} ${esc(r.label)}</button>`).join('')}</div>
        <input class="field" id="joinName" maxlength="${LIMITS.memberName}" placeholder="${esc(NAME_PLACEHOLDER.default)}" style="margin-top:10px" autocomplete="off" /></div>
      <div class="sheet-actions"><button class="btn btn-primary btn-block" data-join="1">참여하기</button></div>`;
  }
  joinCtl.onClick = async (e) => {
    const g = pickOpt(e, f);
    if (g === 'claim') {
      f.role = null;
      for (const x of $('sheetBody').querySelectorAll('[data-grp="role"]')) x.classList.remove('on');
      return;
    }
    if (g === 'role') {
      f.claim = null;
      for (const x of $('sheetBody').querySelectorAll('[data-grp="claim"]')) x.classList.remove('on');
      const nm = $('joinName');
      if (nm) nm.placeholder = f.role === 'sitter' ? NAME_PLACEHOLDER.sitter : NAME_PLACEHOLDER.default;
      return;
    }
    const jb = e.target.closest('[data-join]');
    if (!jb) return;
    if (info.kind !== 'device' && !f.claim && !f.role) { showToast('나를 골라 주세요 (기존 사람 또는 처음 참여)'); return; }
    const opts = {};
    if (info.kind !== 'device') {
      if (f.claim) opts.claim = f.claim;
      else {
        const r = ROLE_BY_ID[f.role];
        opts.me = { role: r.id, name: $('joinName').value.trim() || r.label, emoji: r.emoji };
      }
    }
    await runJoin(text, opts, famName, jb);
  };
}

async function runJoin(code, opts, famName, btn) {
  // 이미 다른 가족과 공유 중 → 먼저 끊기
  if (state.sync.token && !state.sync.revoked) {
    const ok = await ask({ emoji: '🔀', title: '지금 공유 중인 가족이 있어요', body: `이 기기의 공유를 끊고 '${famName}' 가족에 참여할까요? 이 기기 기록은 남아요.`, buttons: [{ label: '끊고 참여하기', value: true, kind: 'primary' }, { label: '취소', value: false }], dismiss: false });
    if (!ok) return;
    try { await leaveFamily(state); } catch (e) { /* 계속 */ }
  }
  // 이 기기에 있는 기록 → 합칠지 (연결이 끊긴 기기도 묻는다 — 다른 가족에 옛 기록이 몰래 올라가지 않게.
  // 같은 가족에 다시 참여하는 경우는 sync.joinFamily 가 알아서 합친다)
  const localCount = live(state.events).length;
  let merge = false;
  if (localCount > 0) {
    const v = await ask({
      emoji: '🧩', title: `이 기기 기록 ${localCount}개를 가족 기록에 합칠까요?`,
      body: '합치면 내가 남긴 기록이 새 가족에 그대로 올라가요.',
      buttons: [{ label: '합치기', value: 'merge', kind: 'primary' }, { label: '버리고 참여', value: 'drop', kind: 'danger' }, { label: '취소', value: null }],
      dismiss: null,
    });
    if (!v) return;
    if (v === 'drop') {
      const sure = await ask({ emoji: '⚠️', title: `기록 ${localCount}개를 버릴까요?`, body: '버리면 되돌릴 수 없어요. 필요하면 먼저 설정 → JSON 백업을 해 두세요.', buttons: [{ label: '버리고 참여', value: true, kind: 'danger' }, { label: '취소', value: false }], dismiss: false });
      if (!sure) return;
    }
    merge = v === 'merge';
  }
  if (btn) { btn.disabled = true; btn.textContent = '참여하는 중…'; }
  try {
    await joinFamily(state, code, { ...opts, merge }, Date.now());
    markAllSeen();
    pendingJoin = '';
    stripJoinHash();
    closeSheet();
    commit();
    showToast(`${state.family.name || famName} 육아일지에 참여했어요 🎉`, 3200);
  } catch (err) {
    let msg = errMsg(err);
    if ((err?.code === 'forbidden' || err?.status === 403) && (!err.message || err.message === ERROR_COPY.forbidden)) {
      msg = '이미 다른 기기가 연결된 사람이에요. 그 사람 폰의 [가족 초대 → 내 다른 기기에서도 쓰기] 코드를 붙여 넣어 주세요';
    }
    if (err?.code === 'already_shared') msg = ERROR_COPY.already_shared;
    showToast(msg, 4500);
    if (btn) { btn.disabled = false; btn.textContent = '다시 시도'; }
  }
}

function stripJoinHash() {
  if (/#(join|dev)=/.test(location.hash)) {
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  }
}

function openSyncSheet() {
  const [cls] = syncView();
  const pending = state.events.filter((e) => e.dirty && !e.rejected).length;
  const rejected = state.events.filter((e) => e.rejected && !e.deleted).length;
  const last = state.sync.lastSyncAt ? `마지막 동기화 ${fmtElapsed((Date.now() - state.sync.lastSyncAt) / MIN)} 전` : '';
  let body;
  if (cls === 'revoked') {
    body = `<div class="honest">🔌 <b>이 기기의 가족 연결이 끊겼어요.</b> 기록은 이 기기에 그대로 있어요. 초대 링크를 다시 받아 참여하면 끊긴 사이의 기록도 함께 올라가요.</div>
      <div class="sheet-actions"><button class="btn btn-primary btn-block" data-rejoin="1">다시 참여하기</button></div>`;
  } else if (cls === 'off') {
    body = `<div class="honest">⚪ <b>이 기기에만 저장 중이에요.</b><br />${canShare() ? '가족 공유를 켜면 엄마·아빠·시터 폰에서 같은 기록을 봐요.' : '가족 공유는 곧 열려요. 그동안은 설정 → JSON 백업으로 기록을 지켜 주세요.'}</div>
      ${canShare() ? '<div class="sheet-actions"><button class="btn btn-primary btn-block" data-invite="1">가족 공유 켜기</button></div>' : ''}`;
  } else if (cls === 'ok') {
    body = `<div class="honest">🟢 <b>가족과 공유 중이에요.</b> ${esc(last)}</div>
      ${pending ? `<p class="sheet-note">보낼 기록 ${pending}개 — 곧 보내져요.</p>` : ''}
      <div class="sheet-actions"><button class="btn btn-ghost btn-block" data-syncnow="1">지금 동기화</button></div>`;
  } else {
    body = `<div class="honest">🟠 <b>연결 대기 중이에요.</b> 인터넷이 돌아오면 자동으로 보내요.<br />보내지 못한 기록 ${pending}개는 이 기기에 안전하게 있어요.</div>
      <div class="sheet-actions"><button class="btn btn-ghost btn-block" data-syncnow="1">다시 시도</button></div>`;
  }
  if (rejected) body += `<p class="sheet-note warn">⚠ 서버가 받지 않은 기록 ${rejected}개 — 기록 목록에서 눌러 고치면 다시 보내요.</p>`;
  openSheet('공유 상태', body, {
    onClick: async (e) => {
      if (e.target.closest('[data-rejoin]')) { openJoinSheet(''); return; }
      if (e.target.closest('[data-invite]')) { openInviteSheet(); return; }
      const b = e.target.closest('[data-syncnow]');
      if (b) {
        b.disabled = true;
        b.textContent = '동기화 중…';
        await autosync?.now();
        openSyncSheet();
      }
    },
  });
}

// ============================================================
// 잠금화면 기록 안내 (RESEARCH D — 솔직하게: 잠금화면 1~2탭은 단축어 설정 시, 앱 첫 화면은 언제나 1탭)
// ============================================================
const LOCK_TYPES = ['pee', 'poop', 'both', 'formula', 'sleep', 'burp'];
const LOCK_LABEL = { pee: '소변 기록', poop: '대변 기록', both: '소변+대변 기록', formula: '분유 기록', sleep: '잠 기록 (재우기/깼어요)', burp: '트림 기록' };

function openLockSheet(tab = isAndroid ? 'android' : 'ios') {
  const shared = !!state.sync.token && !state.sync.revoked;
  const urlFor = (t) => {
    if (t === 'formula') {
      const ml = state.prefs.lastMl?.formula ?? lastMl(state.events, 'formula');
      return quickUrl(state, t, ml ? { ml } : {});
    }
    return quickUrl(state, t);
  };
  const copyRows = (types) => types.map((t) => {
    const u = urlFor(t);
    return `<div class="copy-row"><span class="cr-label">${typeMeta(t === 'both' ? 'both' : t).emoji} ${esc(typeMeta(t).label)}</span><code>${esc(u)}</code>
      <button class="btn btn-ghost btn-sm" data-copyurl="${esc(u)}">복사</button></div>`;
  }).join('');
  const needShare = `
    <div class="honest">🔒 잠금화면 기록은 <b>'가족 공유'를 켜면</b> 쓸 수 있어요 (아이폰은 단축어가 서버로 바로 기록해요).</div>
    ${canShare() ? '<div class="sheet-actions"><button class="btn btn-primary btn-block" data-invite="1">가족 공유 켜기</button></div>' : '<p class="sheet-note">🌱 가족 공유는 곧 열려요. 그동안은 앱을 홈 화면에 추가해 두면 <b>앱 첫 화면에서 언제나 한 번 탭</b>으로 기록돼요.</p>'}`;
  const secretWarn = '<p class="sheet-note danger">🔑 이 주소는 비밀번호와 같아요 — 다른 사람에게 보내지 마세요. 유출됐다면 관리자에게 <b>설정 → 가족 멤버 → 기기 연결 끊기</b>를 부탁하고 다시 참여해 주세요.</p>';

  // ---- 아이폰 ----
  let ios = '';
  const links = BRAND.iosShortcuts || {};
  const hasLinks = LOCK_TYPES.some((t) => links[t]);
  if (!shared) ios = needShare;
  else if (hasLinks) {
    ios = `
      <ol class="steps">
        <li><b>[내 코드 복사]</b>를 눌러요.<div style="margin-top:6px"><button class="btn btn-primary btn-sm" data-copyurl="${esc(state.sync.token)}" data-msg="내 코드를 복사했어요 — 단축어 코드 칸에 붙여 넣어 주세요">🔑 내 코드 복사</button></div></li>
        <li>아래 버튼을 누르면 '단축어' 앱이 열려요. 코드 칸에 <b>붙여넣기</b> → <b>단축어 추가</b>.
          <div class="opts cols-2" style="margin-top:6px">${LOCK_TYPES.filter((t) => links[t]).map((t) => `<a class="opt" href="${esc(links[t])}" target="_blank" rel="noopener" style="text-decoration:none">${typeMeta(t).emoji} ${esc(typeMeta(t).label)} 버튼 받기</a>`).join('')}</div></li>
        <li>단축어 앱에서 방금 받은 단축어를 <b>한 번 눌러 실행</b>해요. 연결을 허용할지 물으면 <b>'항상 허용'</b>. "✓ 기록" 알림이 오면 준비 끝!</li>
        ${lockStepsIOS()}
      </ol>${secretWarn}`;
  } else {
    ios = `
      <div class="sec"><div class="sec-title">1) 내 개인 주소 <span class="sub">단축어에 붙여 넣을 주소</span></div>
        ${copyRows(LOCK_TYPES)}
        <div class="copy-row"><span class="cr-label">🎙 말로 기록</span><code>${esc(quickUrl(state, 'say'))}&amp;say=</code><button class="btn btn-ghost btn-sm" data-copyurl="${esc(`${quickUrl(state, 'say')}&say=`)}">복사</button></div>
        ${secretWarn}</div>
      <div class="sec"><div class="sec-title">2) 단축어 만들기 <span class="sub">버튼 하나당 한 번</span></div>
        <ol class="steps">
          <li><b>단축어</b> 앱 → 오른쪽 위 <b>'+'</b></li>
          <li><b>'URL의 콘텐츠 가져오기'</b> 동작 추가 → URL 칸에 위 <b>개인 주소</b> 붙여넣기</li>
          <li>동작의 화살표(더 보기)를 눌러 <b>방법: POST</b></li>
          <li><b>'+'</b> → <b>'시스템 알림 보기'</b> 추가 (내용: URL의 콘텐츠)</li>
          <li>단축어 이름을 <b>"소변 기록"</b>처럼 정하고 완료</li>
          <li>한 번 눌러 실행 → 허용을 물으면 <b>'항상 허용'</b>. "✓ 소변 기록" 알림이 오면 성공!</li>
        </ol>
        <p class="sheet-note">🎙 말로 기록: 'URL의 콘텐츠 가져오기' 앞에 <b>'텍스트 받아쓰기'</b>를 넣고, URL 끝 <b>say=</b> 뒤에 '받아쓴 텍스트'를 넣어요. "분유 120", "쉬했어", "잠들었어"처럼 말하면 돼요.</p></div>
      <div class="sec"><div class="sec-title">3) 잠금화면에 놓기</div><ol class="steps">${lockStepsIOS()}</ol></div>`;
  }

  // ---- 갤럭시·안드로이드 ----
  const qa = (state.prefs.quickActions || ['pee', 'poop']).filter((t) => NOTIF_TYPES.includes(t)).slice(0, 2);
  const notifOk = notifActionsOk();
  const notifOn = !!state.prefs.quickNotif && notifOk && Notification.permission === 'granted';
  const android = `
    <div class="sec"><div class="sec-title">① 앱 아이콘 길게 누르기 <span class="sub">잠금 해제 필요</span></div>
      <p class="sheet-note" style="margin-top:0">홈 화면에 추가한 앱 아이콘을 <b>길게 누르면</b> 💧소변 · 💩대변 · 🍼분유 · 😴잠 바로가기가 나와요. 끌어서 홈 화면에 따로 놓을 수도 있어요.</p>
      ${isStandalone ? '' : '<button class="btn btn-ghost btn-block" data-install="1" style="margin-top:10px">📲 먼저 홈 화면에 추가하기</button>'}</div>
    <div class="sec"><div class="sec-title">② 알림 버튼 (베타) <span class="sub">앱 설치 없이</span></div>
      ${notifOk ? `
        <p class="sheet-note" style="margin-top:0">알림창에 <b>버튼 2개</b>가 붙어요. 잠금화면에서 누르면 바로 기록돼요 (기종마다 확인이 필요해요). 알림을 밀어서 지우면 앱을 열 때 다시 생겨요.</p>
        <div class="sec-title" style="margin-top:10px">버튼 2개 고르기</div>
        <div class="opts cols-4">${NOTIF_TYPES.map((t) => `<button type="button" class="opt${qa.includes(t) ? ' on' : ''}" data-qa="${t}" aria-pressed="${qa.includes(t)}" style="font-size:13px;flex-direction:column;gap:0"><span style="font-size:20px">${typeMeta(t).emoji}</span>${esc(typeMeta(t).label)}</button>`).join('')}</div>
        <div class="sheet-actions">${notifOn
          ? '<button class="btn btn-ghost btn-block" data-notif-off="1">알림 버튼 끄기</button><button class="btn btn-ghost btn-block" data-notif-on="1">알림 다시 띄우기</button>'
          : '<button class="btn btn-primary btn-block" data-notif-on="1">🔔 잠금화면 알림 버튼 켜기</button>'}</div>
        ${shared ? '' : '<p class="sheet-note">가족 공유 전에는 알림 버튼 기록이 이 기기에 모였다가 앱을 열면 들어가요.</p>'}`
      : '<p class="sheet-note" style="margin-top:0">이 브라우저는 알림 버튼을 지원하지 않아요. 크롬에서 홈 화면에 추가한 뒤 다시 열어 주세요.</p>'}</div>
    <div class="sec"><div class="sec-title">③ HTTP Shortcuts 앱 + 빠른 설정 타일 <span class="sub">가장 확실해요</span></div>
      ${shared ? `
        <ol class="steps">
          <li>Play 스토어에서 <b>'HTTP Shortcuts'</b>(무료·광고 없음)를 설치해요.</li>
          <li>앱에서 <b>'+'</b> → 새 바로가기 → 이름 <b>"소변 기록"</b></li>
          <li><b>방법: POST</b>, URL에 아래 개인 주소를 붙여 넣어요.</li>
          <li><b>응답 처리</b>에서 표시 방식을 <b>'토스트'</b>로 (창으로 두면 잠금화면에서 안 돼요) → 저장</li>
          <li>화면 위에서 내려 <b>빠른 설정창 → 연필(편집)</b> → <b>'바로가기 시작'</b> 타일을 끌어다 놓고 완료. 타일에는 바로가기 <b>하나만</b> 연결해 주세요.</li>
          <li>잠긴 상태에서 빠른 설정창을 내려 타일을 누르면 끝! "✓ 기록" 메시지가 떠요. 나머지는 홈 화면 <b>위젯</b>으로 놓아두세요.</li>
        </ol>
        ${copyRows(['pee', 'poop', 'formula', 'sleep', 'burp'])}${secretWarn}` : needShare}</div>`;

  const html = `
    <div class="ptabs" role="tablist">
      <button class="ptab${tab === 'ios' ? ' active' : ''}" data-ptab="ios" role="tab">🍎 아이폰</button>
      <button class="ptab${tab === 'android' ? ' active' : ''}" data-ptab="android" role="tab">🤖 갤럭시·안드로이드</button>
    </div>
    <div class="honest">솔직하게 말하면: <b>잠금화면에서는 1~2탭</b> (단축어·알림 설정 시), <b>앱 첫 화면에서는 언제나 1탭</b>이에요. 기종마다 한 번 시험해 보세요.</div>
    <div id="lockBody">${tab === 'ios' ? ios : android}</div>
    ${!isStandalone ? '<button class="btn btn-ghost btn-block" data-install="1" style="margin-top:16px">📲 홈 화면에 추가하기</button>' : ''}`;
  openSheet('🔒 잠금화면에서 기록하기', html, {
    onClick: async (e) => {
      const pt = e.target.closest('[data-ptab]');
      if (pt) { openLockSheet(pt.dataset.ptab); return; }
      const cu = e.target.closest('[data-copyurl]');
      if (cu) { copyText(cu.dataset.copyurl, cu.dataset.msg || '주소를 복사했어요 — 단축어에 붙여 넣어 주세요'); return; }
      if (e.target.closest('[data-invite]')) { openInviteSheet(); return; }
      if (e.target.closest('[data-install]')) { onInstall(); return; }
      const q = e.target.closest('[data-qa]');
      if (q) {
        let list = (state.prefs.quickActions || []).filter((t) => NOTIF_TYPES.includes(t));
        const t = q.dataset.qa;
        if (list.includes(t)) list = list.filter((x) => x !== t);
        else list = [...list, t].slice(-2);
        state.prefs.quickActions = list;
        save(state);
        await refreshSwConfig();
        if (state.prefs.quickNotif && list.length === 2) showQuickNotif();
        openLockSheet('android');
        return;
      }
      if (e.target.closest('[data-notif-on]')) { await enableQuickNotif(); openLockSheet('android'); return; }
      if (e.target.closest('[data-notif-off]')) { await disableQuickNotif(); openLockSheet('android'); }
    },
  });
}

function lockStepsIOS() {
  return `
    <li>화면을 잠그고 잠금화면을 <b>길게 누른 뒤 '사용자화' → '잠금 화면'</b> (iOS 18 이상)</li>
    <li>아래 손전등(또는 카메라) 버튼의 <b>'−'</b>로 빼고, 빈 자리 <b>'+'</b> → <b>'단축어'</b> → <b>'소변 기록'</b> → <b>'완료'</b>. 버튼 자리는 2개예요.</li>
    <li>더 많이: <b>제어 센터 '+' → '제어 항목 추가' → '단축어'</b>. 잠긴 상태에서 쓰려면 <b>설정 > Face ID 및 암호 > '잠겨 있을 때 접근 허용' > 제어 센터</b>를 켜요.</li>
    <li>동작 버튼이 있는 아이폰: <b>설정 > 동작 버튼</b> → '단축어'까지 넘기기 → 선택</li>
    <li>손이 바쁠 땐: <b>"시리야, 소변 기록"</b></li>
    <li>뒷면 탭(설정 > 손쉬운 사용 > 터치 > 뒷면 탭)은 <b>잠금을 푼 상태에서만</b> 돼요.</li>
    <li>잠금을 풀라고 나오면 단축어 앱에서 한 번 실행해서 <b>'항상 허용'</b>을 눌러 주세요.</li>`;
}

// ----- 안드로이드 알림 버튼 (서비스워커가 버튼을 받아 기록) -----
async function swReady() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 4000))]);
  } catch (e) { return null; }
}

/** 서비스워커에 알림을 띄워 달라고 하고, 실제로 떴는지 확인 → true/false */
async function showQuickNotif() {
  const reg = await swReady();
  if (!reg || !reg.active) return false;
  await refreshSwConfig(true);
  reg.active.postMessage({ type: 'bl-quick-show' });
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try { if ((await reg.getNotifications({ tag: 'bl-quick' })).length) return true; } catch (e) { return true; }
  }
  return false;
}

async function enableQuickNotif() {
  if (!notifActionsOk()) return;
  let perm = Notification.permission;
  if (perm !== 'granted') {
    try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; }
  }
  if (perm !== 'granted') { showToast('알림 권한이 꺼져 있어요 — 브라우저 설정에서 알림을 허용해 주세요', 4000); return; }
  if ((state.prefs.quickActions || []).filter((t) => NOTIF_TYPES.includes(t)).length !== 2) state.prefs.quickActions = ['pee', 'poop'];
  state.prefs.quickNotif = true;
  save(state);
  if (await showQuickNotif()) showToast('🔔 알림창에 기록 버튼을 띄웠어요');
  else showToast('알림이 안 보여요 — 휴대폰 설정 > 알림에서 크롬(또는 이 앱) 알림을 켜 주세요', 4500);
}

async function closeQuickNotifs() {
  // ready 는 서비스워커가 없으면 영영 안 끝나서, 이미 있는 등록만 본다
  let reg = null;
  try { reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null; } catch (e) { reg = null; }
  try {
    const list = (await reg?.getNotifications({ tag: 'bl-quick' })) || [];
    for (const n of list) n.close();
  } catch (e) { /* ignore */ }
}

async function disableQuickNotif() {
  state.prefs.quickNotif = false;
  save(state);
  await closeQuickNotifs();
  showToast('알림 버튼을 껐어요');
}

// 앱을 열 때 알림을 밀어서 지웠으면 다시 띄운다
async function ensureQuickNotif() {
  if (!state.prefs.quickNotif || !notifActionsOk() || Notification.permission !== 'granted') return;
  const reg = await swReady();
  if (!reg) return;
  try {
    const list = await reg.getNotifications({ tag: 'bl-quick' });
    if (!list.length) showQuickNotif();
  } catch (e) { /* ignore */ }
}

// ============================================================
// 설정
// ============================================================
function openSettingsSheet() {
  const c = ctx();
  const p = state.prefs;
  const shared = !!state.sync.token && !state.sync.revoked;
  const grid = c.grid;
  const all = visibleActions(c.age);
  const members = state.members;
  const html = `
    <div class="sec"><div class="sec-title">👶 아기 정보</div>
      <label class="field-label" for="setName">이름</label>
      <input class="field" id="setName" maxlength="${LIMITS.babyName}" value="${esc(state.family.name)}" placeholder="예: 하린" autocomplete="off" />
      <label class="field-label" for="setBirth" style="margin-top:10px">생년월일</label>
      <input class="field" id="setBirth" type="date" value="${esc(state.family.birth)}" max="${toISO(today())}" />
      <button class="btn btn-ghost btn-block" data-baby-save="1" style="margin-top:10px">아기 정보 저장</button></div>

    <div class="sec"><div class="sec-title">👨‍👩‍👧 가족 멤버 <span class="sub">${shared ? '연결됨 = 자기 폰으로 기록' : '이 기기에서 함께 기록'}</span></div>
      <ul class="mlist">${members.map((m) => `
        <li><button class="mrow${m.revoked ? ' revoked' : ''}" data-member="${esc(m.id)}" ${m.revoked ? 'disabled' : ''}>
          <span class="m-emo">${esc(memberEmoji(m))}</span>
          <span class="m-body"><span class="m-name">${esc(memberName(m))}${m.isAdmin ? ' 👑' : ''}</span><span class="m-sub" style="display:block">${esc(ROLE_BY_ID[m.role]?.label || '')}${m.id === state.meId ? ' · 나' : ''}</span></span>
          ${m.revoked ? '<span class="m-tag">나감</span>' : shared ? (m.claimed ? '<span class="m-tag ok">연결됨</span>' : '<span class="m-tag">기록만</span>') : ''}
        </button></li>`).join('')}</ul>
      <button class="btn btn-ghost btn-block" data-add-member="1" style="margin-top:8px">+ 사람 추가</button></div>

    <div class="sec"><div class="sec-title">🔘 퀵버튼 편집 <span class="sub">${esc(c.stage.name)} 단계 · 체크한 버튼이 첫 화면에</span></div>
      <ul class="check-list">${all.map((id) => `<li><button class="check-item${grid.includes(id) ? ' on' : ''}" data-grid="${id}" aria-pressed="${grid.includes(id)}"><span class="ck">✓</span>${typeMeta(id).emoji} ${esc(typeMeta(id).label)}</button></li>`).join('')}</ul>
      <button class="btn btn-ghost btn-block" data-grid-reset="1" style="margin-top:8px">단계 기본값으로</button></div>

    <div class="sec">
      <div class="set-row"><div><div class="sr-label">🎮 게임 요소 보기</div><div class="sr-sub">팀 미션·연속 기록·도감·레벨업 축하</div></div>
        <button class="switch${p.game ? ' on' : ''}" data-game="1" role="switch" aria-checked="${p.game}" aria-label="게임 요소 보기"></button></div>
    </div>

    <div class="sec"><div class="sec-title">🌙 화면</div>
      ${optsHTML('theme', [{ id: 'auto', label: '자동' }, { id: 'light', label: '☀️ 밝게' }, { id: 'dark', label: '🌙 밤 모드' }], p.theme, { cls: 'seg' })}</div>

    <div class="sec"><div class="sec-title">💾 데이터</div>
      <div class="row2" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button class="btn btn-ghost btn-sm" data-csv="1">CSV 내보내기</button>
        <button class="btn btn-ghost btn-sm" data-json="1">JSON 백업</button>
      </div>
      <button class="btn btn-ghost btn-block btn-sm" data-restore="1" style="margin-top:8px">백업 파일 불러오기 (합치기)</button>
      <p class="sheet-note">${esc(STORAGE_NOTE)}</p></div>

    <div class="sec"><div class="sec-title">🔗 공유</div>
      ${shared ? `
        ${state.sync.isAdmin ? '<button class="btn btn-ghost btn-block btn-sm" data-invite="1">초대 링크 보기 · 새로 만들기</button>' : '<button class="btn btn-ghost btn-block btn-sm" data-invite="1">가족 초대</button>'}
        <button class="btn btn-ghost btn-block btn-sm" data-leave="1" style="margin-top:8px">이 기기 공유 끊기</button>`
      : `<button class="btn btn-ghost btn-block btn-sm" data-invite="1">${canShare() ? '가족 공유 켜기' : '가족 공유 (곧 열려요)'}</button>
         <button class="btn btn-ghost btn-block btn-sm" data-join="1" style="margin-top:8px">초대 링크로 참여하기</button>`}</div>

    <div class="sec"><button class="btn btn-danger btn-block btn-sm" data-wipe="1">이 기기 기록 모두 지우기</button></div>
    <p class="sheet-note">${esc(DISCLAIMER)}</p>`;
  const f = { theme: p.theme };
  openSheet('⚙️ 설정', html, {
    onClick: async (e) => {
      const g = pickOpt(e, f);
      if (g === 'theme') { state.prefs.theme = f.theme; save(state); applyTheme(); return; }
      if (e.target.closest('[data-baby-save]')) {
        const birth = $('setBirth').value;
        if (birth && (birth > toISO(today()) || birth < toISO(addMonths(today(), -12 * 7)))) { showToast('생년월일을 확인해 주세요'); return; }
        updateFamily(state, { name: $('setName').value.trim(), birth: birth || undefined }, Date.now());
        commit();
        showToast('아기 정보를 저장했어요');
        return;
      }
      const mb = e.target.closest('[data-member]');
      if (mb) { openMemberSheet(mb.dataset.member); return; }
      if (e.target.closest('[data-add-member]')) { openMeSheet(true); return; }
      const gb = e.target.closest('[data-grid]');
      if (gb) {
        const id = gb.dataset.grid;
        let list = gridFor(c.stage, c.age, state.prefs).slice();
        if (list.includes(id)) {
          if (list.length <= 1) { showToast('버튼이 하나는 있어야 해요'); return; }
          list = list.filter((x) => x !== id);
        } else {
          if (list.length >= 12) { showToast('첫 화면 버튼은 12개까지예요'); return; }
          list.push(id);
        }
        state.prefs.grid = { ...(state.prefs.grid || {}), [c.stage.id]: list };
        gb.classList.toggle('on', list.includes(id));
        gb.setAttribute('aria-pressed', String(list.includes(id)));
        commit();
        return;
      }
      if (e.target.closest('[data-grid-reset]')) {
        const gridPrefs = { ...(state.prefs.grid || {}) };
        delete gridPrefs[c.stage.id];
        state.prefs.grid = gridPrefs;
        commit();
        openSettingsSheet();
        showToast('단계 기본 버튼으로 돌렸어요');
        return;
      }
      const gm = e.target.closest('[data-game]');
      if (gm) {
        state.prefs.game = !state.prefs.game;
        gm.classList.toggle('on', state.prefs.game);
        gm.setAttribute('aria-checked', String(state.prefs.game));
        commit();
        return;
      }
      if (e.target.closest('[data-csv]')) {
        download(`${babyName()}_육아일지_${dayKey(Date.now())}.csv`, toCSV(state.events, state.members), 'text/csv;charset=utf-8');
        return;
      }
      if (e.target.closest('[data-json]')) { exportJSON(); return; }
      if (e.target.closest('[data-restore]')) { $('restoreFile').click(); return; }
      if (e.target.closest('[data-invite]')) { openInviteSheet(); return; }
      if (e.target.closest('[data-join]')) { openJoinSheet(''); return; }
      if (e.target.closest('[data-leave]')) {
        const ok = await ask({ emoji: '🔌', title: '이 기기의 공유를 끊을까요?', body: '이 기기 기록은 그대로 남고, 가족 기록도 다른 기기에 남아요. 다시 참여하려면 초대 링크가 필요해요.', buttons: [{ label: '끊기', value: true, kind: 'danger' }, { label: '취소', value: false }], dismiss: false });
        if (!ok) return;
        await leaveFamily(state);
        commit();
        openSettingsSheet();
        showToast('이 기기의 공유를 끊었어요');
        return;
      }
      if (e.target.closest('[data-wipe]')) wipeAll();
    },
  });
}

function exportJSON() {
  // 기기 토큰·초대 코드는 비밀번호와 같아서 백업 파일에 넣지 않는다
  const safe = { ...state, sync: { familyId: state.sync.familyId, rev: 0 } };
  const out = { app: 'uridaylog-baby-log', v: 1, exportedAt: new Date().toISOString(), state: safe };
  download(`${babyName()}_육아일지_백업_${dayKey(Date.now())}.json`, JSON.stringify(out), 'application/json');
}

async function handleRestore(file) {
  if (!file) return;
  let b;
  try {
    const raw = JSON.parse(await file.text());
    b = normalizeState(raw && raw.state ? raw.state : raw);
  } catch (e) {
    showToast('백업 파일을 읽지 못했어요');
    return;
  }
  const now = Date.now();
  const fresh = !isSetUp();
  let added = 0;
  let updated = 0;
  const idx = new Map(state.events.map((e) => [e.id, e]));
  for (const e of b.events) {
    const l = idx.get(e.id);
    const copy = { ...e, dirty: true, rev: 0 };
    delete copy.rejected;
    if (!l) { state.events.push(copy); idx.set(e.id, copy); added++; }
    else if ((e.updatedAt || 0) > (l.updatedAt || 0)) { Object.assign(l, copy); updated++; }
  }
  for (const m of b.members) {
    if (!state.members.some((x) => x.id === m.id)) state.members.push({ ...m, dirty: true, claimed: false, isAdmin: false });
  }
  if (!state.family.birth && b.family.birth) updateFamily(state, { name: state.family.name || b.family.name, birth: b.family.birth }, now);
  if (!isSetUp()) state.meId = b.meId && state.members.some((m) => m.id === b.meId) ? b.meId : (state.members[0]?.id ?? null);
  if (fresh) {
    state.prefs = { ...b.prefs, seenStage: null };
    applyTheme();
  }
  commit();
  closeSheet();
  showToast(`백업을 합쳤어요 — 새 기록 ${added}개${updated ? ` · 고친 기록 ${updated}개` : ''}`, 3500);
}

async function wipeAll() {
  const ok1 = await ask({ emoji: '🗑', title: '이 기기의 기록을 모두 지울까요?', body: state.sync.token ? '가족 공유 중이라면 이 기기만 공유가 끊기고, 가족 기록은 다른 기기에 남아요.' : '가족 공유를 켜지 않았다면 기록이 영영 사라져요. 먼저 JSON 백업을 권해요.', buttons: [{ label: '지우기', value: true, kind: 'danger' }, { label: '취소', value: false }], dismiss: false });
  if (!ok1) return;
  const ok2 = await ask({ emoji: '⚠️', title: '정말 지울까요?', body: '되돌릴 수 없어요.', buttons: [{ label: '네, 모두 지워요', value: true, kind: 'danger' }, { label: '취소', value: false }], dismiss: false });
  if (!ok2) return;
  if (state.sync.token && !state.sync.revoked) { try { await leaveFamily(state); } catch (e) { /* 계속 */ } }
  await closeQuickNotifs();
  // 순서 중요: 옛 state 를 다시 저장하는 코드가 끼어들지 않게 지우기 직전에 새 상태로 바꾼다
  state = defaultState();
  wipe();
  await clearSwData();
  try { localStorage.removeItem('bl:theme'); } catch (e) { /* ignore */ }
  lastSwCfg = '';
  closeSheet();
  applyTheme();
  render();
  showToast('이 기기의 기록을 모두 지웠어요');
}

// ============================================================
// 홈 화면 추가 (PWA)
// ============================================================
function onInstall() {
  if (ui.installPrompt) {
    const p = ui.installPrompt;
    ui.installPrompt = null;
    p.prompt();
    p.userChoice.then((choice) => {
      if (choice.outcome === 'accepted') { $('installBtn').classList.add('hidden'); showToast('홈 화면에 추가됐어요!'); }
    }).catch(() => {});
    return;
  }
  const body = isIOS
    ? `<ol class="steps">
        <li>Safari 하단(또는 상단)의 <b>공유 버튼 ⬆︎</b>을 눌러주세요.</li>
        <li>목록에서 <b>"홈 화면에 추가"</b>를 선택하고 <b>추가</b>를 누르면 끝!</li>
      </ol>
      <p class="sheet-note">⚠️ 아이폰은 사파리·홈 화면 앱·카톡 안 브라우저의 저장 공간이 <b>따로따로</b>예요. 홈 화면 앱을 처음 열면 <b>초대 링크를 받았어요</b>에 초대 링크(또는 <b>가족 초대 → 내 다른 기기에서도 쓰기</b> 코드)를 붙여 넣어 이어서 쓰세요. 공유 전이라면 설정 → JSON 백업으로 옮길 수 있어요.</p>`
    : `<ol class="steps">
        <li>브라우저 <b>⋮ 메뉴</b>를 눌러주세요.</li>
        <li><b>"홈 화면에 추가"</b>(또는 "앱 설치")를 선택하면 끝!</li>
      </ol>
      <p class="sheet-note">홈 화면 아이콘으로 열면 앱처럼 전체 화면으로 열리고, 아이콘을 길게 누르면 소변·대변·분유·잠 바로가기가 나와요.</p>`;
  openSheet('📲 홈 화면에 추가하는 법', body);
}

// ============================================================
// 서비스워커 · 매니페스트 바로가기(?q=) · 해시(#join=)
// ============================================================
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => { ui.swReg = reg; }).catch(() => { /* http 미리보기 등에선 무시 */ });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'bl-inbox') autosync?.now();
  });
}

/** 홈 화면 아이콘 길게 누르기 바로가기 (manifest shortcuts: ./?q=pee) — 한 번만 처리하고 주소에서 지운다 */
function handleQuickParam() {
  const params = new URLSearchParams(location.search);
  const q = params.get('q');
  if (!q) return;
  params.delete('q');
  const qs = params.toString();
  try { history.replaceState(history.state, '', location.pathname + (qs ? `?${qs}` : '') + location.hash); } catch (e) { /* ignore */ }
  if (!isSetUp() || !QUICK_ACTIONS.includes(q)) return;
  // 같은 바로가기가 곧바로 두 번 열리는 경우(앱 복귀 등) 막기
  try {
    const k = `bl:q:${q}`;
    const lastQ = Number(sessionStorage.getItem(k) || 0);
    if (Date.now() - lastQ < 8000) return;
    sessionStorage.setItem(k, String(Date.now()));
  } catch (e) { /* ignore */ }
  onAction(q, null);
}

// 초대 링크(#join=)·기기 연결 링크(#dev=): 참여에 성공할 때까지 주소에 남겨 둔다 — 카톡 인앱 브라우저의
// '다른 브라우저로 열기'나 새로고침이 코드를 그대로 들고 가도록. 참여 시트는 방문 기록을 쌓지 않아서(history:false)
// 닫아도 뒤로가기로 해시 주소에 다시 가지 않는다. 코드는 pendingJoin 에 들고 있다가 '초대 링크를 받았어요'에 채운다.
let pendingJoin = '';
function handleHash() {
  if (!/#(join|dev)=/.test(location.hash)) return;
  if (pendingJoin === location.href && sheet.open) return;
  pendingJoin = location.href;
  openJoinSheet(pendingJoin);
}

// ============================================================
// 이벤트 연결
// ============================================================
function bindMain() {
  $('grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) onAction(b.dataset.act, b);
  });
  $('moreBtn').addEventListener('click', openMoreSheet);
  $('nowCards').addEventListener('click', (e) => {
    if (e.target.closest('[data-wake]')) { onAction('sleep', e.target.closest('[data-wake]')); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) openEditSheet([ed.dataset.edit]);
  });
  $('burpStrip').addEventListener('click', (e) => {
    const b = e.target.closest('[data-burp]');
    if (!b) return;
    updateEvent(state, b.dataset.id, { data: { burp: b.dataset.burp } }, Date.now());
    commit();
    vibrate(10);
    showToast(b.dataset.burp === 'yes' ? '😮‍💨 트림 ✓ 기록했어요' : '트림 안 함으로 기록했어요');
  });
  $('hints').addEventListener('click', (e) => {
    const x = e.target.closest('[data-hint-x]');
    if (!x) return;
    state.prefs.hintsOff = { ...(state.prefs.hintsOff || {}), [x.dataset.hintX]: dayKey(Date.now()) };
    save(state);
    renderHints(ctx());
  });
  $('todayCard').addEventListener('click', (e) => {
    if (e.target.closest('[data-dex]')) openDexSheet();
  });
  $('timeline').addEventListener('click', (e) => {
    const th = e.target.closest('[data-thx]');
    if (th) { toggleThanks(th.dataset.thx); return; }
    const ak = e.target.closest('[data-ack]');
    if (ak) { ackBaton(ak.dataset.ack); return; }
    const ed = e.target.closest('[data-edit]');
    if (ed) {
      const ids = ed.dataset.edit.split(',');
      const ev = eventById(state, ids[0]);
      if (ev?.type === 'handoff') openBatonView(ev.id);
      else openEditSheet(ids);
    }
  });
  $('tlTabs').addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    ui.tab = t.dataset.tab;
    ui.extraDays = 0;
    for (const x of $('tlTabs').querySelectorAll('.tab')) x.classList.toggle('active', x === t);
    renderTimeline(ctx());
  });
  $('tlMore').addEventListener('click', () => { ui.extraDays += 3; renderTimeline(ctx()); });
  $('teamCard').addEventListener('click', (e) => { if (e.target.closest('[data-handoff]')) openHandoffSheet(); });
  $('batonBanner').addEventListener('click', (e) => {
    const v = e.target.closest('[data-baton-view]');
    if (v) { openBatonView(v.dataset.batonView); return; }
    const a = e.target.closest('[data-ack]');
    if (a) ackBaton(a.dataset.ack);
  });
  $('babyBar').addEventListener('click', openStageSheet);
  $('meChip').addEventListener('click', () => openMeSheet(false));
  $('syncPill').addEventListener('click', openSyncSheet);
  $('toolHandoff').addEventListener('click', openHandoffSheet);
  $('toolLock').addEventListener('click', () => openLockSheet());
  $('toolInvite').addEventListener('click', openInviteSheet);
  $('toolSettings').addEventListener('click', openSettingsSheet);
  $('installBtn').addEventListener('click', onInstall);
  $('revokedJoin').addEventListener('click', () => openJoinSheet(''));
  $('inappCopy').addEventListener('click', () => copyText(location.href.split('#')[0] + (location.hash || ''), '링크를 복사했어요 — 사파리/크롬 주소창에 붙여 넣어 주세요'));

  // 시트 · 모달 · 토스트
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetDim').addEventListener('click', (e) => { if (e.target === $('sheetDim')) closeSheet(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.open && $('modalDim').classList.contains('hidden')) closeSheet();
  });
  $('undoBtn').addEventListener('click', () => { const u = ui.undo; hideUndo(); u?.undo?.(); });
  $('undoEdit').addEventListener('click', () => { const u = ui.undo; hideUndo(); u?.edit?.(); });
  $('restoreFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    handleRestore(file);
  });
}

// ----- 첫 실행 폼 -----
function bindOnboard() {
  const f = { role: null };
  $('obRoles').innerHTML = ROLES.map((r) => `<button type="button" class="opt" data-role="${r.id}" role="radio" aria-checked="false">${r.emoji} ${esc(r.label)}</button>`).join('');
  $('obMeName').placeholder = NAME_PLACEHOLDER.default;
  const bi = $('obBirth');
  bi.max = toISO(today());
  bi.min = toISO(addMonths(today(), -12 * 7));
  $('obRoles').addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (!b) return;
    f.role = b.dataset.role;
    for (const x of $('obRoles').querySelectorAll('[data-role]')) {
      x.classList.toggle('on', x === b);
      x.setAttribute('aria-checked', String(x === b));
    }
    $('obMeName').placeholder = f.role === 'sitter' ? NAME_PLACEHOLDER.sitter : NAME_PLACEHOLDER.default;
  });
  $('onboardForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const birth = bi.value;
    if (!birth) { showToast('생년월일을 입력해 주세요'); bi.focus(); return; }
    if (birth > toISO(today()) || birth < bi.min) { showToast('생년월일을 확인해 주세요'); return; }
    if (!f.role) { showToast("'나는'에서 한 명을 골라 주세요"); return; }
    const r = ROLE_BY_ID[f.role];
    setupFamily(state, { name: $('obName').value.trim(), birth, me: { role: r.id, name: $('obMeName').value.trim() || r.label, emoji: r.emoji } }, Date.now());
    commit();
    window.scrollTo({ top: 0 });
    showToast('준비 끝! 첫 기록을 남겨 보세요 👇', 3000);
  });
  $('obJoin').addEventListener('click', () => openJoinSheet(pendingJoin));
  $('obRestore').addEventListener('click', () => $('restoreFile').click());
}

// ----- 다른 탭에서 저장한 기록 합치기 -----
function bindStorage() {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    const other = load();
    const sameFamily = (other.sync?.familyId || null) === (state.sync?.familyId || null) && (other.sync?.token || null) === (state.sync?.token || null);
    if (!sameFamily || (!isSetUp() && other.meId)) {
      state = other;
      applyTheme();
      render();
      return;
    }
    if (absorb(state, other)) { save(state); render(); }
  });
}

// ============================================================
// 시작
// ============================================================
function init() {
  $('brandIg').href = BRAND.instagramUrl;
  $('footIg').href = BRAND.instagramUrl;
  $('footIgHandle').textContent = BRAND.instagram;
  $('disclaimer').textContent = `${DISCLAIMER} 의학적 판단을 대신하지 않아요.\n${STORAGE_NOTE}\n참고 기준: ${LOG_META.standard} (${LOG_META.year})`;
  applyTheme();
  bindOnboard();
  bindMain();
  bindStorage();
  registerSW();

  // 홈 화면 추가 버튼
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.installPrompt = e;
    if (!isStandalone) $('installBtn').classList.remove('hidden');
  });
  if (!isStandalone && isIOS) $('installBtn').classList.remove('hidden');

  render();

  // 자동 동기화 (공유 안 할 때도 서비스워커 수신함은 가져온다)
  autosync = startAutoSync(() => state, (s, info) => {
    if (s !== state) return;
    if (info.imported) announce(`🔔 알림·잠금화면에서 남긴 기록 ${info.imported}개를 가져왔어요`, 3200);
    if (info.changed || info.status === 'revoked') render();
    else if (isSetUp()) renderTop();
  });
  refreshSwConfig(true);

  handleQuickParam();
  handleHash();
  window.addEventListener('hashchange', handleHash);
  setInterval(tick, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isSetUp()) { render(); ensureQuickNotif(); }
  });
  ensureQuickNotif();
}

init();
