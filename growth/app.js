import { BRAND } from '../shared/js/brand.js';
import { parseDate, today, diffDays, fmtShort, toISO, ageText } from '../shared/js/date-utils.js';
import { CANVAS_FONT, roundRect, downloadCanvas } from '../shared/js/canvas-utils.js';
import { GROWTH_META, LMS } from './growth-data.js';

const $ = (id) => document.getElementById(id);
const UA = navigator.userAgent;
const isInApp = /Instagram|KAKAOTALK|NAVER|FBAV|FBAN/i.test(UA);

const state = { sex: 1, birth: null, measure: null, values: {}, results: [] };

// ---------- 통계 ----------
function erf(x) {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

function normCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// LMS 보간 → z점수/백분위
function lmsAt(rows, ageM) {
  if (!rows.length) return null;
  if (ageM <= rows[0][0]) return rows[0];
  if (ageM >= rows[rows.length - 1][0]) return rows[rows.length - 1];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (ageM >= a[0] && ageM <= b[0]) {
      const t = (ageM - a[0]) / (b[0] - a[0]);
      return [ageM, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
    }
  }
  return rows[rows.length - 1];
}

function percentile(measureKey, sex, ageM, value) {
  const table = LMS[measureKey][sex];
  const lms = lmsAt(table, ageM);
  if (!lms) return null;
  const [, L, M, S] = lms;
  const z = L !== 0 ? (Math.pow(value / M, L) - 1) / (L * S) : Math.log(value / M) / S;
  return { z, pct: normCdf(z) * 100, median: M };
}

// ---------- 렌더 ----------
const MEASURES = [
  { key: 'weight', input: 'weight', emoji: '⚖️' },
  { key: 'length', input: 'height', emoji: '📏' },
  { key: 'head', input: 'head', emoji: '🧢' },
];

function pctLabel(p) {
  if (p < 1) return '1 미만';
  if (p > 99) return '99 이상';
  return String(Math.round(p));
}

function friendly(p) {
  const nth = Math.max(1, Math.min(100, Math.round(p)));
  return `또래 100명을 작은 순으로 세우면 <b>${nth}번째</b> 정도예요`;
}

function renderResult() {
  const ageM = diffDays(state.birth, state.measure) / 30.4375;
  $('sumTitle').textContent = `${state.sex === 1 ? '👦 남아' : '👧 여아'} · ${ageText(state.birth, state.measure)}`;
  $('sumSub').textContent = `${fmtShort(state.measure)} 측정 · WHO 기준`;

  state.results = [];
  $('gauges').innerHTML = MEASURES.map((mDef) => {
    const v = state.values[mDef.input];
    if (!v) return '';
    const info = LMS[mDef.key];
    const r = percentile(mDef.key, state.sex, ageM, v);
    if (!r) return '';
    state.results.push({ ...mDef, v, ...r, name: info.name, unit: info.unit });
    const pos = Math.max(2, Math.min(98, r.pct));
    const outlier = Math.abs(r.z) > 2.5;
    return `
      <div class="gauge-card">
        <div class="gauge-head">
          <span class="gauge-name">${mDef.emoji} ${info.name}</span>
          <span class="gauge-val">${v}${info.unit} · 또래 중간값 ${r.median.toFixed(1)}${info.unit}</span>
        </div>
        <div class="gauge-pct">백분위 ${pctLabel(r.pct)} <span class="small">/ 100</span></div>
        <div class="gauge-bar"><span class="band"></span><span class="marker" style="left:${pos}%"></span></div>
        <div class="gauge-scale"><span>3</span><span>25</span><span>50</span><span>75</span><span>97</span></div>
        <div class="gauge-note">${friendly(r.pct)}</div>
        ${outlier ? '<div class="gauge-warn">⚠ 정상 범위(3~97 백분위)를 벗어났어요. 다음 영유아검진이나 소아과에서 상담해 보세요.</div>' : ''}
      </div>`;
  }).join('');

  saveHistory(ageM);
  renderHistory();
}

// ---------- 기록 ----------
function historyKey() { return `gr:history:${toISO(state.birth)}`; }

function saveHistory(ageM) {
  try {
    const list = JSON.parse(localStorage.getItem(historyKey()) || '[]')
      .filter((h) => h.date !== toISO(state.measure));
    list.push({
      date: toISO(state.measure),
      ageM: Math.round(ageM * 10) / 10,
      sex: state.sex,
      items: state.results.map((r) => ({ k: r.key, v: r.v, p: Math.round(r.pct) })),
    });
    list.sort((a, b) => a.date.localeCompare(b.date));
    localStorage.setItem(historyKey(), JSON.stringify(list.slice(-24)));
  } catch (e) { /* ignore */ }
}

function renderHistory() {
  let list = [];
  try { list = JSON.parse(localStorage.getItem(historyKey()) || '[]'); } catch (e) { /* ignore */ }
  const names = { weight: '몸무게', length: '키', head: '머리둘레' };
  $('historyCard').innerHTML = `
    <h3>📈 성장 기록 (이 기기에 저장)</h3>
    ${list.length ? [...list].reverse().map((h) => `
      <div class="h-row">
        <span class="h-date">${h.date.slice(2)}</span>
        <span class="h-item">${h.ageM}개월</span>
        ${h.items.map((it) => `<span class="h-item">${names[it.k]} ${it.v} → <b>P${it.p}</b></span>`).join('')}
      </div>`).join('')
    : '<div class="h-empty">기록이 쌓이면 백분위 변화를 한눈에 볼 수 있어요. 한 달에 한 번 재보세요!</div>'}`;
}

// ---------- 성장 카드 이미지 ----------
function drawCard() {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');

  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#EAF0FC');
  g.addColorStop(1, '#FBF6F0');
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);

  x.fillStyle = '#2B2019';
  x.font = `800 60px ${CANVAS_FONT}`;
  x.fillText('우리아기 성장 리포트', 60, 130);
  x.fillStyle = '#7A6A5D';
  x.font = `600 32px ${CANVAS_FONT}`;
  x.fillText(`${state.sex === 1 ? '남아' : '여아'} · ${ageText(state.birth, state.measure)} · ${fmtShort(state.measure)}`, 60, 186);

  const top = 260, cardH = 250, gap = 28;
  state.results.forEach((r, i) => {
    const y = top + i * (cardH + gap);
    x.fillStyle = '#FFFFFF';
    x.strokeStyle = '#DDE4F1';
    x.lineWidth = 2;
    roundRect(x, 60, y, W - 120, cardH, 26);
    x.fill(); x.stroke();

    x.fillStyle = '#2B2019';
    x.font = `800 38px ${CANVAS_FONT}`;
    x.fillText(`${r.emoji} ${r.name}`, 100, y + 64);
    x.fillStyle = '#7A6A5D';
    x.font = `600 30px ${CANVAS_FONT}`;
    x.textAlign = 'right';
    x.fillText(`${r.v}${r.unit}`, W - 100, y + 64);
    x.textAlign = 'left';

    x.fillStyle = '#34497E';
    x.font = `800 64px ${CANVAS_FONT}`;
    x.fillText(`백분위 ${pctLabel(r.pct)}`, 100, y + 148);

    // 게이지
    const bx = 100, bw = W - 200, by = y + 186;
    x.fillStyle = '#E4EAF7';
    roundRect(x, bx, by, bw, 20, 10);
    x.fill();
    const pos = bx + bw * Math.max(0.02, Math.min(0.98, r.pct / 100));
    x.fillStyle = '#4A67B0';
    x.beginPath();
    x.arc(pos, by + 10, 20, 0, Math.PI * 2);
    x.fill();
    x.strokeStyle = '#fff';
    x.lineWidth = 5;
    x.stroke();
  });

  x.fillStyle = '#C94F35';
  x.font = `800 30px ${CANVAS_FONT}`;
  x.fillText(`${BRAND.suite} ${BRAND.instagram}`, 60, H - 56);
  x.fillStyle = '#B0A396';
  x.font = `600 24px ${CANVAS_FONT}`;
  x.textAlign = 'right';
  x.fillText('WHO 성장 기준 · 참고용', W - 60, H - 56);
  x.textAlign = 'left';
  return c;
}

async function onImage() {
  if (isInApp) { showToast('⋯ 메뉴에서 "외부 브라우저로 열기" 후 다시 눌러주세요'); return; }
  if (!state.results.length) return;
  try { await document.fonts.ready; } catch (e) { /* ignore */ }
  downloadCanvas(drawCard(), `성장카드_${toISO(state.measure)}.png`, () => showToast('성장 카드를 저장했어요! 📸'));
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
  const base = (BRAND.siteUrl || '').replace(/vaccine-calendar\/?$/, 'growth/') || location.href.split('?')[0];
  const q = new URLSearchParams();
  q.set('sex', state.sex);
  q.set('bd', toISO(state.birth));
  q.set('md', toISO(state.measure));
  for (const k of ['weight', 'height', 'head']) if (state.values[k]) q.set(k[0], state.values[k]);
  const url = `${base}?${q}`;
  if (navigator.share) {
    try { await navigator.share({ title: '우리아기 성장 백분위', url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); showToast('링크를 복사했어요!'); }
  catch (e) { prompt('아래 링크를 복사하세요', url); }
}

function calc() {
  if (!LMS.weight[1].length) { showToast('데이터 준비 중이에요 — 잠시 후 다시 시도해 주세요'); return; }
  const bd = $('babyBirth').value;
  if (!bd) { showToast('생년월일을 입력해 주세요'); return; }
  const birth = parseDate(bd);
  const measure = $('measureDate').value ? parseDate($('measureDate').value) : today();
  if (isNaN(birth) || birth > measure) { showToast('날짜를 확인해 주세요'); return; }
  const ageM = diffDays(birth, measure) / 30.4375;
  if (ageM > 24.5) { showToast('이 도구는 0~24개월 기준이에요'); return; }
  state.birth = birth;
  state.measure = measure;
  state.values = {
    weight: parseFloat($('weight').value) || null,
    height: parseFloat($('height').value) || null,
    head: parseFloat($('head').value) || null,
  };
  if (!state.values.weight && !state.values.height && !state.values.head) {
    showToast('몸무게·키·머리둘레 중 1가지는 입력해 주세요');
    return;
  }
  try {
    localStorage.setItem('gr:last', JSON.stringify({ sex: state.sex, bd, md: toISO(measure), ...state.values }));
  } catch (e) { /* ignore */ }
  $('hero').classList.add('hidden');
  $('inputCard').classList.add('hidden');
  $('result').classList.remove('hidden');
  renderResult();
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
    `${GROWTH_META.standard} ${GROWTH_META.range} 데이터를 사용한 참고용 계산이에요. ` +
    `정확한 성장 평가는 영유아검진과 소아청소년과 진료로 확인하세요. 기록은 이 기기 브라우저에만 저장돼요.`;

  $('babyBirth').max = toISO(today());
  $('measureDate').value = toISO(today());
  $('measureDate').max = toISO(today());

  document.querySelectorAll('.sex-btn').forEach((b) => {
    b.addEventListener('click', () => {
      state.sex = Number(b.dataset.sex);
      document.querySelectorAll('.sex-btn').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  $('makeBtn').addEventListener('click', calc);
  $('resetBtn').addEventListener('click', showInput);
  $('imgBtn').addEventListener('click', onImage);
  $('shareBtn').addEventListener('click', onShare);

  const params = new URLSearchParams(location.search);
  const saved = params.get('bd')
    ? { sex: Number(params.get('sex')) || 1, bd: params.get('bd'), md: params.get('md') || '', weight: params.get('w') || '', height: params.get('h') || '', head: params.get('he') || '' }
    : (() => { try { return JSON.parse(localStorage.getItem('gr:last') || 'null'); } catch (e) { return null; } })();

  if (saved && saved.bd) {
    state.sex = saved.sex === 2 ? 2 : 1;
    document.querySelectorAll('.sex-btn').forEach((x) => x.classList.toggle('active', Number(x.dataset.sex) === state.sex));
    $('babyBirth').value = saved.bd;
    if (saved.md) $('measureDate').value = saved.md;
    $('weight').value = saved.weight || '';
    $('height').value = saved.height || '';
    $('head').value = saved.head || '';
    if (params.get('bd')) calc();
  }
}

init();
