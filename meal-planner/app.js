import { BRAND } from '../shared/js/brand.js';
import { parseDate, today, fmt, fmtShort, toISO } from '../shared/js/date-utils.js';
import { FOODS, STAGES, CATEGORY_LABEL, FORBIDDEN, RULES, FOOD_META, stageAtLeast } from './food-data.js';
import { buildPlan } from './planner-logic.js';

const $ = (id) => document.getElementById(id);

const UA = navigator.userAgent;
const isInApp = /Instagram|KAKAOTALK|NAVER|FBAV|FBAN/i.test(UA);

const state = {
  stageId: 'early',
  start: today(),
  food: new Map(),   // id → 'eaten' | 'avoid'
  plan: null,
  week: 0,
};

// ---------- 입력 UI ----------
function renderStageGrid() {
  $('stageGrid').innerHTML = STAGES.map((s) => `
    <button class="stage-btn ${s.id === state.stageId ? 'active' : ''}" data-stage="${s.id}">
      <div class="s-name">${s.name}</div>
      <div class="s-months">${s.months}</div>
    </button>`).join('');
}

function renderFoodPicker() {
  const cats = ['grain', 'vegetable', 'meat', 'fish', 'dairy', 'legume', 'fruit', 'etc'];
  $('foodPicker').innerHTML = cats.map((cat) => {
    const foods = FOODS.filter((f) => f.category === cat);
    if (!foods.length) return '';
    return `
      <div class="food-group">
        <div class="food-group-title">${CATEGORY_LABEL[cat]}</div>
        <div class="food-chips">
          ${foods.map((f) => {
            const locked = !stageAtLeast(f, state.stageId);
            const st = state.food.get(f.id) || '';
            return `<button class="food-chip ${locked ? 'locked' : ''} ${st}" data-food="${f.id}">${f.name}</button>`;
          }).join('')}
        </div>
      </div>`;
  }).join('');
}

// ---------- 결과 렌더 ----------
function renderResult() {
  const p = state.plan;
  const endDate = p.days[p.days.length - 1].date;
  $('sumStage').textContent = `${p.stage.name} 이유식 식단표`;
  $('sumRange').textContent = `${fmtShort(state.start)} ~ ${fmtShort(endDate)}`;
  $('sumNew').textContent = `4주간 ${p.newCount}개`;
  $('stageInfo').innerHTML =
    `<b>${p.stage.name}</b> · ${p.stage.months}<br />` +
    `${p.stage.mealsText} · ${p.stage.texture}<br />1회 양: ${p.stage.amount}`;

  $('weekTabs').innerHTML = p.weeks.map((w, i) =>
    `<button class="filter-btn ${i === state.week ? 'active' : ''}" data-week="${i}">${w.no}주차</button>`).join('');

  renderWeek();
  renderPrintSheet();
}

function renderWeek() {
  const p = state.plan;
  const days = p.days.slice(state.week * 7, state.week * 7 + 7);
  $('dayList').innerHTML = days.map((d) => `
    <div class="day-card">
      <div class="day-head">
        <span class="day-no">${d.idx + 1}일차</span>
        <span class="day-date">${fmtShort(d.date)}</span>
      </div>
      <div class="day-foods">
        <span class="pill pill-base">${p.stage.base}</span>
        ${d.adapt ? '<span class="pill pill-side">첫 3일은 쌀미음만 — 숟가락 적응 기간</span>' : ''}
        ${d.newFood ? `<span class="pill pill-new">NEW ${d.newFood.name} <span class="cnt">${d.introDay}/3</span></span>` : ''}
        ${d.sides.map((s) => `<span class="pill pill-side">${s.name}</span>`).join('')}
      </div>
      ${d.caution ? `<div class="day-caution">⚠ ${d.caution}</div>` : ''}
      ${d.newFood && d.newFood.note && d.introDay === 1 ? `<div class="day-caution" style="background:var(--line-soft); color:var(--ink-soft);">💡 ${d.newFood.note}</div>` : ''}
    </div>`).join('');

  const w = p.weeks[state.week];
  $('shoppingList').innerHTML = `
    <div class="shop-chips">
      ${w.shopping.map((n) => `<span class="shop-chip ${w.newFoods.includes(n) ? 'new' : ''}">${w.newFoods.includes(n) ? '✦ ' : ''}${n}</span>`).join('')}
    </div>
    ${w.newFoods.length ? `<p style="margin-top:10px; font-size:12px; color:var(--ink-faint);">✦ 표시는 이번 주 처음 도입하는 재료예요</p>` : ''}`;
}

function renderPrintSheet() {
  const p = state.plan;
  const tables = p.weeks.map((w, wi) => {
    const days = p.days.slice(wi * 7, wi * 7 + 7);
    return `
      <table class="p-table">
        <thead><tr><th style="width:70px">${w.no}주차</th><th>새 재료 (3일 룰)</th><th>함께 주는 재료</th><th style="width:110px">메모</th></tr></thead>
        <tbody>
          ${days.map((d) => `
            <tr>
              <td>${d.idx + 1}일차<br /><span style="color:#888">${fmtShort(d.date).slice(5)}</span></td>
              <td class="p-new">${d.adapt ? '쌀미음 적응' : d.newFood ? `${d.newFood.name} (${d.introDay}/3)${d.newFood.allergy ? ' ⚠' : ''}` : '-'}</td>
              <td>${p.stage.base}${d.sides.length ? ' + ' + d.sides.map((s) => s.name).join(', ') : ''}</td>
              <td></td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }).join('');
  $('printSheet').innerHTML = `
    <h1>${p.stage.name} 이유식 4주 식단표</h1>
    <div class="p-sub">${fmt(state.start)} 시작 · ⚠ = 알레르기 유발 식품(오전 소량 시작) · ${BRAND.suite} ${BRAND.instagram}</div>
    ${tables}
    <div class="p-foot">새 재료는 3일 연속 유지하며 반응(발진·구토·설사)을 관찰하세요. 본 식단표는 참고용이며, 아기 상태에 따라 소아과와 상담해 조절하세요.</div>`;
}

// ---------- 이미지 저장 (1080x1350 인스타 비율) ----------
function drawWeekImage() {
  const p = state.plan;
  const w = p.weeks[state.week];
  const days = p.days.slice(state.week * 7, state.week * 7 + 7);
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const F = '"Pretendard Variable", Pretendard, sans-serif';

  x.fillStyle = '#FBF6F0';
  x.fillRect(0, 0, W, H);

  // 헤더
  x.fillStyle = '#2B2019';
  x.font = `800 56px ${F}`;
  x.fillText(`${p.stage.name} 이유식 식단표`, 60, 110);
  x.fillStyle = '#7A6A5D';
  x.font = `600 30px ${F}`;
  x.fillText(`${w.no}주차 · ${fmtShort(days[0].date)} ~ ${fmtShort(days[6].date)}`, 60, 160);

  // 데이 카드
  const top = 210, cardH = 128, gap = 16;
  days.forEach((d, i) => {
    const y = top + i * (cardH + gap);
    x.fillStyle = '#FFFFFF';
    x.strokeStyle = '#EFE4D8';
    x.lineWidth = 2;
    roundRect(x, 60, y, W - 120, cardH, 20);
    x.fill(); x.stroke();

    x.fillStyle = '#2B2019';
    x.font = `800 32px ${F}`;
    x.fillText(`${d.idx + 1}일차`, 90, y + 48);
    x.fillStyle = '#B0A396';
    x.font = `600 24px ${F}`;
    x.fillText(fmtShort(d.date).slice(5), 90, y + 84);

    let px = 230;
    px = drawPill(x, px, y + 40, p.stage.base, '#F6EEE5', '#7A6A5D', F);
    if (d.newFood) px = drawPill(x, px, y + 40, `NEW ${d.newFood.name} ${d.introDay}/3`, '#E86A4E', '#FFFFFF', F);
    d.sides.forEach((s) => { px = drawPill(x, px, y + 40, s.name, '#E9F3EE', '#41775F', F); });
    if (d.newFood && d.newFood.allergy && d.introDay === 1) {
      x.fillStyle = '#A3701A';
      x.font = `600 22px ${F}`;
      x.fillText('⚠ 알레르기 유발 식품 — 오전 첫 끼 소량으로', 230, y + 106);
    }
  });

  // 푸터 워터마크
  x.fillStyle = '#C94F35';
  x.font = `800 30px ${F}`;
  x.fillText(`${BRAND.suite} ${BRAND.instagram}`, 60, H - 60);
  x.fillStyle = '#B0A396';
  x.font = `600 24px ${F}`;
  x.textAlign = 'right';
  x.fillText('새 재료는 3일 관찰 · 간은 하지 않아요', W - 60, H - 60);
  x.textAlign = 'left';
  return c;
}

function roundRect(x, px, py, w, h, r) {
  x.beginPath();
  x.moveTo(px + r, py);
  x.arcTo(px + w, py, px + w, py + h, r);
  x.arcTo(px + w, py + h, px, py + h, r);
  x.arcTo(px, py + h, px, py, r);
  x.arcTo(px, py, px + w, py, r);
  x.closePath();
}

function drawPill(x, px, py, text, bg, fg, F) {
  x.font = `700 26px ${F}`;
  const tw = x.measureText(text).width;
  x.fillStyle = bg;
  roundRect(x, px, py - 30, tw + 36, 46, 23);
  x.fill();
  x.fillStyle = fg;
  x.fillText(text, px + 18, py + 2);
  return px + tw + 36 + 12;
}

async function onImage() {
  if (isInApp) {
    showToast('⋯ 메뉴에서 "외부 브라우저로 열기" 후 다시 눌러주세요');
    $('inappBanner').classList.remove('hidden');
    return;
  }
  try { await document.fonts.ready; } catch (e) { /* ignore */ }
  const c = drawWeekImage();
  c.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `이유식식단표_${state.plan.weeks[state.week].no}주차.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    showToast('이미지를 저장했어요! 인스타 스토리에 올려보세요 📸');
  }, 'image/png');
}

// ---------- 공유/저장 ----------
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2400);
}

function currentParams() {
  const eaten = [], avoid = [];
  state.food.forEach((v, k) => (v === 'eaten' ? eaten : avoid).push(k));
  const q = new URLSearchParams();
  q.set('st', state.stageId);
  q.set('sd', toISO(state.start));
  if (eaten.length) q.set('e', eaten.join(','));
  if (avoid.length) q.set('a', avoid.join(','));
  return q;
}

async function onShare() {
  const base = (BRAND.siteUrl || '').replace(/vaccine-calendar\/?$/, 'meal-planner/') || location.href.split('?')[0];
  const url = `${base}?${currentParams()}`;
  if (navigator.share) {
    try { await navigator.share({ title: '이유식 식단표 생성기', url }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); showToast('링크를 복사했어요!'); }
  catch (e) { prompt('아래 링크를 복사하세요', url); }
}

// ---------- 생성 ----------
function makePlan() {
  const eaten = [], avoid = [];
  state.food.forEach((v, k) => (v === 'eaten' ? eaten : avoid).push(k));
  state.plan = buildPlan({ startDate: state.start, stageId: state.stageId, eatenIds: eaten, avoidIds: avoid });
  state.week = 0;
  try {
    localStorage.setItem('mp:last', JSON.stringify({ st: state.stageId, sd: toISO(state.start), e: eaten, a: avoid }));
  } catch (e) { /* ignore */ }
  history.replaceState(null, '', `${location.pathname}?${currentParams()}`);
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
  history.replaceState(null, '', location.pathname);
}

// ---------- 초기화 ----------
function init() {
  $('brandName').textContent = BRAND.suite;
  $('brandIg').href = BRAND.instagramUrl;
  $('footIg').href = BRAND.instagramUrl;
  $('footIgHandle').textContent = BRAND.instagram;
  $('disclaimer').textContent =
    `본 식단표는 ${FOOD_META.standard}(${FOOD_META.year})를 참고한 자동 생성 예시입니다. ` +
    `아기의 발달·알레르기 상태에 따라 소아청소년과 의사와 상담해 조절하세요.`;
  $('rulesList').innerHTML = `
    <li>${RULES.threeDayRule}</li>
    <li>${RULES.allergyNote}</li>
    <li>이유식을 시작해도 모유/분유는 계속 함께 먹여요.</li>`;
  $('forbiddenList').innerHTML = FORBIDDEN.map((f) =>
    `<li><b>${f.name}</b> — ${f.until}. ${f.reason}</li>`).join('');

  $('startDate').value = toISO(today());
  renderStageGrid();
  renderFoodPicker();
  if (isInApp) $('inappBanner').classList.remove('hidden');

  $('stageGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.stage-btn');
    if (!btn) return;
    state.stageId = btn.dataset.stage;
    renderStageGrid();
    renderFoodPicker();
  });

  $('foodPicker').addEventListener('click', (e) => {
    const chip = e.target.closest('.food-chip');
    if (!chip || chip.classList.contains('locked')) return;
    const id = chip.dataset.food;
    const cur = state.food.get(id);
    const next = !cur ? 'eaten' : cur === 'eaten' ? 'avoid' : null;
    if (next) state.food.set(id, next); else state.food.delete(id);
    chip.classList.remove('eaten', 'avoid');
    if (next) chip.classList.add(next);
  });

  $('makeBtn').addEventListener('click', () => {
    const sd = $('startDate').value;
    if (!sd) { showToast('시작일을 선택해 주세요'); return; }
    state.start = parseDate(sd);
    makePlan();
  });

  $('weekTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    state.week = Number(btn.dataset.week);
    document.querySelectorAll('#weekTabs .filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderWeek();
  });

  $('resetBtn').addEventListener('click', showInput);
  $('imgBtn').addEventListener('click', onImage);
  $('printBtn').addEventListener('click', () => window.print());
  $('shareBtn').addEventListener('click', onShare);

  // URL 파라미터 / 마지막 입력 복원
  const params = new URLSearchParams(location.search);
  const saved = params.get('st') ? {
    st: params.get('st'), sd: params.get('sd'),
    e: (params.get('e') || '').split(',').filter(Boolean),
    a: (params.get('a') || '').split(',').filter(Boolean),
  } : (() => {
    try { return JSON.parse(localStorage.getItem('mp:last') || 'null'); } catch (e) { return null; }
  })();

  if (saved && saved.st && STAGES.some((s) => s.id === saved.st)) {
    state.stageId = saved.st;
    (saved.e || []).forEach((id) => state.food.set(id, 'eaten'));
    (saved.a || []).forEach((id) => state.food.set(id, 'avoid'));
    if (saved.sd && /^\d{4}-\d{2}-\d{2}$/.test(saved.sd)) $('startDate').value = saved.sd;
    renderStageGrid();
    renderFoodPicker();
    // 공유 링크로 들어온 경우 바로 결과 표시
    if (params.get('st')) {
      state.start = parseDate($('startDate').value);
      makePlan();
    }
  }
}

init();
