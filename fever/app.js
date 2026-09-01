import { BRAND } from '../shared/js/brand.js';
import { parseDate, today, toISO, addMonths } from '../shared/js/date-utils.js';
import { FEVER_META, DRUGS, CROSS, RED_FLAGS, TIPS, FEVER_THRESHOLD } from './fever-data.js';

const $ = (id) => document.getElementById(id);

const state = { weight: null, birth: null, log: [] };

// ---------- 유틸 ----------
function monthsBetween(a, b) {
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (addMonths(a, m) > b) m -= 1;
  return Math.max(0, m);
}

function babyMonths() {
  return state.birth ? monthsBetween(state.birth, today()) : null;
}

function hm(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function round1(x) { return Math.round(x * 10) / 10; }

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- 복용 기록 ----------
function loadLog() {
  try {
    const raw = JSON.parse(localStorage.getItem('fv:log') || '[]');
    const cutoff = Date.now() - 48 * 3600e3;
    state.log = raw.filter((e) => e.ts > cutoff);
  } catch (e) { state.log = []; }
}

function saveLog() {
  try { localStorage.setItem('fv:log', JSON.stringify(state.log)); } catch (e) { /* ignore */ }
}

function dosesIn24h(drugId) {
  const cutoff = Date.now() - 24 * 3600e3;
  return state.log.filter((e) => e.drugId === drugId && e.ts > cutoff).length;
}

function lastDose(drugId) {
  const list = state.log.filter((e) => e.drugId === drugId);
  return list.length ? list[list.length - 1] : null;
}

// ---------- 렌더 ----------
function renderTimer() {
  const el = $('timerCard');
  if (!state.log.length) {
    el.innerHTML = `<h3>⏱ 복용 타이머</h3><div class="timer-empty">아직 기록이 없어요. 아래에서 먹인 약의 "지금 먹였어요"를 누르면 다음 복용 가능 시각을 계산해 드려요.</div>`;
    return;
  }
  const now = Date.now();
  const lastAny = state.log[state.log.length - 1];
  const lastDrug = DRUGS.find((d) => d.id === lastAny.drugId);
  const rows = [];

  for (const d of DRUGS) {
    const last = lastDose(d.id);
    let ready = 0;
    let why = '';
    if (last) {
      ready = Math.max(ready, last.ts + d.intervalMinH * 3600e3);
      why = `같은 약 간격 ${d.intervalH}`;
    }
    if (lastAny.drugId !== d.id) {
      const lastFam = DRUGS.find((x) => x.id === lastAny.drugId).family;
      if (lastFam === d.family) {
        // 같은 계열 다른 약 (이부프로펜↔덱시부프로펜): 교차 금지 — 같은 약 간격 규칙 적용
        const famLast = state.log.filter((e) => DRUGS.find((x) => x.id === e.drugId).family === d.family).pop();
        if (famLast) {
          ready = Math.max(ready, famLast.ts + d.intervalMinH * 3600e3);
          why = '같은 계열(NSAIDs)은 교차 금지 — 계열 간격 적용';
        }
      } else {
        ready = Math.max(ready, lastAny.ts + CROSS.minGapH * 3600e3);
        if (!why) why = `교차복용 최소 ${CROSS.minGapH}시간`;
      }
    }
    if (!ready) continue;
    const capped = dosesIn24h(d.id) >= d.maxPerDay;
    const ok = !capped && now >= ready;
    rows.push(`
      <div class="timer-row ${ok ? 'ok' : 'wait'}">
        <span class="t-ico">${d.emoji}</span>
        <div class="t-main">
          <div class="t-title">${d.name}</div>
          <div class="t-sub">${capped ? '오늘 최대 횟수에 도달했어요 — 열이 계속되면 병원 상담' : why}</div>
        </div>
        <span class="t-time">${capped ? '오늘 그만' : ok ? '지금 가능' : hm(ready) + ' 이후'}</span>
      </div>`);
  }

  el.innerHTML = `
    <h3>⏱ 복용 타이머</h3>
    <div class="timer-empty">마지막 복용: ${lastDrug.emoji} ${lastDrug.name} · ${hm(lastAny.ts)}</div>
    <div class="timer-rows">${rows.join('')}</div>`;
}

function renderDrugs() {
  const w = state.weight;
  const m = babyMonths();
  $('drugCards').innerHTML = DRUGS.map((d) => {
    const blocked = m !== null && m < d.minAgeM;
    const mlMin = round1(w * d.doseMin / d.mgPerMl);
    const mlMax = round1(w * d.doseMax / d.mgPerMl);
    return `
      <div class="drug-card ${blocked ? 'blocked' : ''}">
        <div class="drug-head">
          <span class="drug-name">${d.emoji} ${d.name}</span>
          <span class="drug-brands">${d.brands}</span>
        </div>
        <div class="dose-box">
          <span class="dose-ml">${mlMin}~${mlMax}ml</span>
          <span class="dose-detail">1회 복용량 (몸무게 ${w}kg × ${d.doseMin}~${d.doseMax}mg/kg)<br />${d.syrupNote}</span>
        </div>
        <div class="drug-meta">
          <span class="chip chip-mute">간격 ${d.intervalH}</span>
          <span class="chip chip-mute">하루 최대 ${d.maxPerDay}회</span>
          <span class="chip chip-mute">생후 ${d.minAgeM}개월부터</span>
        </div>
        ${blocked ? `<div class="age-warn">⚠ ${d.ageNote}</div>` : `<div class="drug-note">${d.ageNote}</div>`}
        <button class="took-btn" data-drug="${d.id}" ${blocked ? 'disabled' : ''}>지금 먹였어요 (기록)</button>
      </div>`;
  }).join('');

  document.querySelectorAll('.took-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.log.push({ drugId: btn.dataset.drug, ts: Date.now() });
      saveLog();
      renderTimer();
      renderLog();
      const d = DRUGS.find((x) => x.id === btn.dataset.drug);
      showToast(`${d.name} 복용을 기록했어요. 다음 가능 시각은 타이머에서!`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

function renderLog() {
  const el = $('logCard');
  if (!state.log.length) {
    el.innerHTML = `<h3>📋 최근 복용 기록</h3><div class="log-empty">기록이 여기 쌓여요 (48시간 보관, 이 기기에만 저장)</div>`;
    return;
  }
  el.innerHTML = `
    <h3>📋 최근 복용 기록</h3>
    ${[...state.log].reverse().map((e, ri) => {
      const d = DRUGS.find((x) => x.id === e.drugId);
      const idx = state.log.length - 1 - ri;
      const day = new Date(e.ts);
      const dayLabel = toISO(day) === toISO(new Date()) ? '오늘' : `${day.getMonth() + 1}/${day.getDate()}`;
      return `<div class="log-row"><span class="l-time">${dayLabel} ${hm(e.ts)}</span><span>${d.emoji} ${d.name}</span><button class="l-del" data-idx="${idx}">삭제</button></div>`;
    }).join('')}`;
  el.querySelectorAll('.l-del').forEach((b) => {
    b.addEventListener('click', () => {
      state.log.splice(Number(b.dataset.idx), 1);
      saveLog();
      renderTimer();
      renderLog();
    });
  });
}

function renderStatic() {
  $('redFlags').innerHTML = RED_FLAGS.map((f) => `<li><b>${f.sign}</b> — ${f.why}</li>`).join('');
  $('tipsList').innerHTML = [FEVER_THRESHOLD, ...TIPS, CROSS.rule, CROSS.sameFamily, CROSS.advice].map((t) => `<li>${t}</li>`).join('');
}

// ---------- 시작 ----------
function calc() {
  const w = parseFloat($('weight').value);
  if (!w || w < 2 || w > 40) { showToast('몸무게를 확인해 주세요 (2~40kg)'); return; }
  state.weight = w;
  state.birth = $('babyBirth').value ? parseDate($('babyBirth').value) : null;
  try {
    localStorage.setItem('fv:last', JSON.stringify({ w, bd: $('babyBirth').value || '' }));
  } catch (e) { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set('w', w);
  if ($('babyBirth').value) url.searchParams.set('bd', $('babyBirth').value);
  history.replaceState(null, '', url);
  $('result').classList.remove('hidden');
  renderTimer();
  renderDrugs();
  renderLog();
  if (state.birth === null) showToast('생년월일을 넣으면 월령 제한도 확인해 드려요');
}

function init() {
  $('brandName').textContent = BRAND.suite;
  $('brandIg').href = BRAND.instagramUrl;
  $('footIg').href = BRAND.instagramUrl;
  $('footIgHandle').textContent = BRAND.instagram;
  $('disclaimer').textContent =
    `본 계산기는 ${FEVER_META.standard}(${FEVER_META.year})에 따른 참고 정보이며 의학적 판단을 대신하지 않아요. ` +
    `실제 복용은 제품 설명서와 의사·약사 안내가 우선이고, 처방받은 용량이 있다면 그것을 따르세요. ` +
    `기록은 이 기기 브라우저에만 저장돼요.`;

  $('babyBirth').max = toISO(today());
  $('makeBtn').addEventListener('click', calc);
  renderStatic();
  loadLog();

  const params = new URLSearchParams(location.search);
  const saved = params.get('w')
    ? { w: params.get('w'), bd: params.get('bd') || '' }
    : (() => { try { return JSON.parse(localStorage.getItem('fv:last') || 'null'); } catch (e) { return null; } })();
  if (saved && saved.w) {
    $('weight').value = saved.w;
    $('babyBirth').value = saved.bd || '';
    calc();
  }

  // 1분마다 타이머 갱신
  setInterval(() => { if (!$('result').classList.contains('hidden')) renderTimer(); }, 60000);
}

init();
