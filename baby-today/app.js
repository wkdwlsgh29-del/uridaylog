import { BRAND } from '../shared/js/brand.js';
import { parseDate, today, diffDays, fmt, toISO, ageText, addMonths } from '../shared/js/date-utils.js';
import { CANVAS_FONT, roundRect, drawPill, downloadCanvas } from '../shared/js/canvas-utils.js';
import { TODAY_META, WONDER_LEAPS, WW_NOTE, SLEEP_TABLE, FEEDING, CORRECTED_NOTE } from './today-data.js';

const $ = (id) => document.getElementById(id);
const UA = navigator.userAgent;
const isInApp = /Instagram|KAKAOTALK|NAVER|FBAV|FBAN/i.test(UA);

const state = { birth: null, due: null, wake: '07:00', weight: null };

// ---------- 계산 유틸 ----------
function monthsBetween(a, b) {
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (addMonths(a, m) > b) m -= 1;
  return Math.max(0, m);
}

function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

function minToHM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function fmtLen(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}시간 ${m}분` : `${h}시간`) : `${m}분`;
}

// 이른둥이 여부: 예정일이 출생일보다 3주(21일) 이상 뒤면 교정 나이 적용
function isPreterm() {
  return state.due && diffDays(state.birth, state.due) >= 21;
}

// ---------- 원더윅스 ----------
function wwStatus() {
  const base = state.due || state.birth;
  const w = diffDays(base, today()) / 7;
  if (w < 0) return null;
  const last = WONDER_LEAPS[WONDER_LEAPS.length - 1];
  if (w > last.fussyEnd) return { phase: 'grad', w };
  for (const leap of WONDER_LEAPS) {
    if (w >= leap.fussyStart && w <= leap.fussyEnd) {
      const progress = (w - leap.fussyStart) / (leap.fussyEnd - leap.fussyStart);
      return { phase: 'storm', leap, w, progress };
    }
    if (w < leap.fussyStart) {
      const dday = Math.ceil((leap.fussyStart - w) * 7);
      return { phase: 'sunny', leap, w, dday };
    }
  }
  return { phase: 'grad', w };
}

function renderWW() {
  const s = wwStatus();
  const baseNote = state.due ? '' : `<div class="ww-desc">💡 출산예정일을 입력하면 더 정확해요 — 원더윅스는 예정일 기준이거든요.</div>`;
  let html = '';
  if (!s) {
    html = '<div class="ww-sub">아직 출생 전이에요.</div>';
  } else if (s.phase === 'grad') {
    html = `
      <div class="ww-status">
        <span class="ww-emoji sunny">🎓</span>
        <div>
          <div class="ww-title">원더윅스 10회 도약 모두 졸업!</div>
          <div class="ww-sub">이제 도약보다 아이만의 속도로 자라는 시기예요.</div>
        </div>
      </div>`;
  } else if (s.phase === 'storm') {
    const pct = Math.round(s.progress * 100);
    html = `
      <div class="ww-status">
        <span class="ww-emoji storm">⛈️</span>
        <div>
          <div class="ww-title">지금 ${s.leap.no}번째 도약 구간이에요</div>
          <div class="ww-sub">「${s.leap.title}」 — 보채고 잠 설쳐도 정상이에요. 구간의 ${pct}% 지점을 지나는 중!</div>
        </div>
      </div>
      <div class="ww-desc">${s.leap.desc}. 끝나면 새 능력이 눈에 보일 거예요 ✨</div>
      <div class="ww-bar"><i style="left:0; width:${pct}%"></i></div>
      <div class="ww-bar-label"><span>${s.leap.fussyStart}주</span><span>${s.leap.fussyEnd}주</span></div>
      ${baseNote}`;
  } else {
    html = `
      <div class="ww-status">
        <span class="ww-emoji sunny">☀️</span>
        <div>
          <div class="ww-title">지금은 맑음 — 다음 도약까지 D-${s.dday}</div>
          <div class="ww-sub">${s.leap.no}번째 도약 「${s.leap.title}」이 ${s.leap.fussyStart}주쯤 시작돼요.</div>
        </div>
      </div>
      <div class="ww-desc">다가올 능력: ${s.leap.desc}</div>
      ${baseNote}`;
  }
  $('wwCard').innerHTML = `
    <div class="card-head"><h3>🌊 원더윅스</h3><span class="chip chip-mute">${state.due ? '예정일 기준' : '출생일 기준'} ${(s && s.w >= 0) ? Math.floor(s.w) + '주차' : ''}</span></div>
    <div style="margin-top:12px">${html}</div>`;
}

// ---------- 수면 플랜 ----------
function sleepBracket() {
  const base = isPreterm() ? state.due : state.birth;
  const m = monthsBetween(base, today());
  return { bracket: SLEEP_TABLE.find((b) => m >= b.fromM && m < b.toM) || SLEEP_TABLE[SLEEP_TABLE.length - 1], m };
}

function buildSchedule() {
  const { bracket } = sleepBracket();
  const wake = hmToMin(state.wake);
  const rows = [{ t: wake, ico: '🌅', what: '기상', len: '' }];
  let t = wake;
  const n = bracket.napCount;
  for (let k = 0; k < n; k++) {
    const win = Math.round(bracket.wwMin + (bracket.wwMax - bracket.wwMin) * (k / n));
    const start = t + win;
    rows.push({ t: start, ico: '😴', what: `낮잠 ${k + 1}`, len: `약 ${fmtLen(bracket.napMin)} · 깨어있은 지 ${fmtLen(win)} 뒤`, nap: true });
    t = start + bracket.napMin;
  }
  const bedWin = bracket.wwMax;
  rows.push({ t: t + bedWin, ico: '🌙', what: '밤잠 취침', len: `마지막 잠텀 ${fmtLen(bedWin)}`, bed: true });
  return { rows, bracket };
}

function renderSleep() {
  const { rows, bracket } = buildSchedule();
  const { m } = sleepBracket();
  $('sleepMeta').textContent = `${isPreterm() ? '교정 ' : ''}${m}개월 기준`;
  $('sleepPlan').innerHTML = rows.map((r) => `
    <div class="sleep-row ${r.bed ? 'bed' : ''}">
      <span class="sleep-time">${minToHM(r.t)}</span>
      <span class="sleep-ico">${r.ico}</span>
      <div>
        <div class="sleep-what">${r.what}</div>
        ${r.len ? `<div class="sleep-len">${r.len}</div>` : ''}
      </div>
    </div>`).join('');
  $('sleepNote').textContent =
    `이 시기 권장: 잠텀 ${fmtLen(bracket.wwMin)}~${fmtLen(bracket.wwMax)} · 낮잠 ${bracket.naps} · 하루 총 수면 ${bracket.total}. ` +
    `아기 컨디션에 따라 ±30분은 자연스러워요. 졸린 신호(눈 비비기, 하품)가 먼저예요!`;
}

// ---------- 수유 ----------
function renderFeed() {
  if (!state.weight) { $('feedCard').classList.add('hidden'); return; }
  $('feedCard').classList.remove('hidden');
  const w = state.weight;
  const dailyMin = Math.min(Math.round(w * FEEDING.perKgMin / 10) * 10, FEEDING.dailyMax);
  const dailyMax = Math.min(Math.round(w * FEEDING.perKgMax / 10) * 10, FEEDING.dailyMax);
  const m = monthsBetween(state.birth, today());
  const fb = FEEDING.feedsByMonth.find((f) => m >= f.fromM && m < f.toM);
  const feeds = fb ? fb.feeds : 4;
  const perMin = Math.round(dailyMin / feeds / 10) * 10;
  const perMax = Math.round(dailyMax / feeds / 10) * 10;
  $('feedCard').innerHTML = `
    <div class="card-head"><h3>🍼 분유량 참고 (완분 기준)</h3><span class="chip chip-mute">${w}kg</span></div>
    <div class="feed-nums">
      <div class="feed-num"><div class="v">${dailyMin}~${dailyMax}ml</div><div class="k">하루 권장 총량</div></div>
      <div class="feed-num"><div class="v">${perMin}~${perMax}ml</div><div class="k">회당 (하루 ${feeds}회 기준)</div></div>
    </div>
    <div class="feed-note">${FEEDING.note}</div>`;
}

// ---------- 대시보드 ----------
function renderAll() {
  const t = today();
  $('sumAge').textContent = `오늘 ${ageText(state.birth, t)}`;
  $('sumDplus').textContent = `D+${diffDays(state.birth, t) + 1} · ${fmt(t)}`;
  $('sumCorrected').innerHTML = isPreterm()
    ? `이른둥이 교정 나이로는 <strong>${ageText(state.due, t)}</strong> 예요 (수면·발달 기준은 교정 나이로!)`
    : '';
  renderWW();
  renderSleep();
  renderFeed();

  const tips = [WW_NOTE];
  if (isPreterm()) tips.push(CORRECTED_NOTE);
  if (!state.weight) tips.push('몸무게를 입력하면 분유량 참고 카드도 보여드려요.');
  tips.push('낮잠 시간표는 기상 시각만 바꿔도 다시 계산돼요 — 아침마다 열어보세요.');
  $('tipsList').innerHTML = tips.map((x) => `<li>${x}</li>`).join('');
}

// ---------- 이미지 저장 ----------
function drawCard() {
  const { rows } = buildSchedule();
  const { m } = sleepBracket();
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#FBF6F0';
  x.fillRect(0, 0, W, H);

  x.fillStyle = '#2B2019';
  x.font = `800 58px ${CANVAS_FONT}`;
  x.fillText('오늘의 낮잠 플랜', 60, 116);
  x.fillStyle = '#7A6A5D';
  x.font = `600 30px ${CANVAS_FONT}`;
  x.fillText(`${fmt(today())} · ${isPreterm() ? '교정 ' : ''}${m}개월 · 기상 ${state.wake}`, 60, 166);

  const s = wwStatus();
  if (s && (s.phase === 'storm' || s.phase === 'sunny')) {
    drawPill(x, 60, 236,
      s.phase === 'storm' ? `⛈ 지금 ${s.leap.no}번째 도약 구간` : `☀️ 다음 도약까지 D-${s.dday}`,
      s.phase === 'storm' ? '#EEE9FB' : '#E9F3EE',
      s.phase === 'storm' ? '#6B4FA8' : '#41775F', 30);
  }

  const top = 300, rowH = Math.min(118, Math.floor(900 / rows.length));
  rows.forEach((r, i) => {
    const y = top + i * (rowH + 12);
    x.fillStyle = '#FFFFFF';
    x.strokeStyle = '#EFE4D8';
    x.lineWidth = 2;
    roundRect(x, 60, y, W - 120, rowH, 20);
    x.fill(); x.stroke();
    x.fillStyle = r.bed ? '#6B4FA8' : '#2B2019';
    x.font = `800 40px ${CANVAS_FONT}`;
    x.fillText(minToHM(r.t), 95, y + rowH / 2 + 6);
    x.font = `700 34px ${CANVAS_FONT}`;
    x.fillText(`${r.ico} ${r.what}`, 300, y + rowH / 2 - (r.len ? 10 : -6));
    if (r.len) {
      x.fillStyle = '#B0A396';
      x.font = `600 24px ${CANVAS_FONT}`;
      x.fillText(r.len, 300, y + rowH / 2 + 32);
    }
  });

  x.fillStyle = '#C94F35';
  x.font = `800 30px ${CANVAS_FONT}`;
  x.fillText(`${BRAND.suite} ${BRAND.instagram}`, 60, H - 56);
  x.fillStyle = '#B0A396';
  x.font = `600 24px ${CANVAS_FONT}`;
  x.textAlign = 'right';
  x.fillText('졸린 신호가 시간표보다 먼저예요', W - 60, H - 56);
  x.textAlign = 'left';
  return c;
}

async function onImage() {
  if (isInApp) {
    showToast('⋯ 메뉴에서 "외부 브라우저로 열기" 후 다시 눌러주세요');
    return;
  }
  try { await document.fonts.ready; } catch (e) { /* ignore */ }
  downloadCanvas(drawCard(), `낮잠플랜_${toISO(today())}.png`, () => showToast('이미지를 저장했어요! 📸'));
}

// ---------- 공유/입력 ----------
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

async function onShare() {
  const base = (BRAND.siteUrl || '').replace(/vaccine-calendar\/?$/, 'baby-today/') || location.href.split('?')[0];
  const q = new URLSearchParams();
  q.set('bd', toISO(state.birth));
  if (state.due) q.set('dd', toISO(state.due));
  q.set('wake', state.wake);
  if (state.weight) q.set('w', state.weight);
  const url = `${base}?${q}`;
  if (navigator.share) {
    try { await navigator.share({ title: '우리아기 오늘', url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); showToast('링크를 복사했어요!'); }
  catch (e) { prompt('아래 링크를 복사하세요', url); }
}

function open() {
  const bd = $('babyBirth').value;
  if (!bd) { showToast('생년월일을 입력해 주세요'); return; }
  const birth = parseDate(bd);
  if (isNaN(birth) || birth > today()) { showToast('생년월일을 확인해 주세요'); return; }
  state.birth = birth;
  state.due = $('dueDate').value ? parseDate($('dueDate').value) : null;
  state.wake = $('wakeTime').value || '07:00';
  state.weight = parseFloat($('weight').value) || null;
  try {
    localStorage.setItem('bt:last', JSON.stringify({
      bd, dd: $('dueDate').value || '', wake: state.wake, w: state.weight || '',
    }));
  } catch (e) { /* ignore */ }
  $('hero').classList.add('hidden');
  $('inputCard').classList.add('hidden');
  $('result').classList.remove('hidden');
  renderAll();
  window.scrollTo({ top: 0 });
}

function showInput() {
  $('hero').classList.remove('hidden');
  $('inputCard').classList.remove('hidden');
  $('result').classList.add('hidden');
}

function init() {
  $('brandName').textContent = BRAND.suite;
  $('brandIg').href = BRAND.instagramUrl;
  $('footIg').href = BRAND.instagramUrl;
  $('footIgHandle').textContent = BRAND.instagram;
  $('disclaimer').textContent =
    `${TODAY_META.standard}(${TODAY_META.year})를 참고한 자동 계산이에요. ` +
    `아기마다 리듬이 달라요 — 수치는 참고용이고, 걱정되는 점은 소아청소년과와 상담하세요.`;

  $('babyBirth').max = toISO(today());
  $('makeBtn').addEventListener('click', open);
  $('resetBtn').addEventListener('click', showInput);
  $('imgBtn').addEventListener('click', onImage);
  $('shareBtn').addEventListener('click', onShare);

  const params = new URLSearchParams(location.search);
  const saved = params.get('bd')
    ? { bd: params.get('bd'), dd: params.get('dd') || '', wake: params.get('wake') || '07:00', w: params.get('w') || '' }
    : (() => { try { return JSON.parse(localStorage.getItem('bt:last') || 'null'); } catch (e) { return null; } })();

  if (saved && saved.bd) {
    $('babyBirth').value = saved.bd;
    $('dueDate').value = saved.dd || '';
    $('wakeTime').value = saved.wake || '07:00';
    $('weight').value = saved.w || '';
    if (params.get('bd')) open();
  }
}

init();
