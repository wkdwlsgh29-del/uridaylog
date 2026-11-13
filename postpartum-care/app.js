import { BRAND } from '../shared/js/brand.js';
import { BENCHMARK, ROOM_TYPES, SUPPORT_PRESETS, FEATURES, ASK_LIST, SAMPLES } from './care-data.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'pc:data';
const MAX_CENTERS = 8;

const state = { centers: [], support: 0, editId: null, formFeatures: new Set() };

// ---------- 유틸 ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
}

// 만원 단위 표기: 1,234.5 → "1,234.5"
function won(n) {
  return (Math.round(n * 10) / 10).toLocaleString('ko-KR');
}

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- 계산 ----------
export function calcCenter(c, support) {
  const total = Math.max(0, c.base + c.massage + c.other - c.discount);
  const net = Math.max(0, total - support);
  const perDay = total / c.days;
  // 전국 평균은 2주 기본요금 기준 → 기본요금을 14일로 환산해 비교
  const base2w = (c.base / c.days) * 14;
  const avg = BENCHMARK.avg[c.room];
  return { total, net, perDay, base2w, avgDiff: base2w - avg, avg };
}

function ranked() {
  return state.centers
    .map((c) => ({ c, r: calcCenter(c, state.support) }))
    .sort((a, b) => a.r.total - b.r.total);
}

// ---------- 저장/공유 ----------
function cleanCenter(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 24);
  const base = num(raw.base);
  if (!name || !base) return null;
  const featureIds = new Set(FEATURES.map((f) => f.id));
  return {
    id: String(raw.id || Math.random().toString(36).slice(2, 9)),
    name,
    region: String(raw.region || '').trim().slice(0, 16),
    room: ROOM_TYPES.some((r) => r.id === raw.room) ? raw.room : 'general',
    days: Math.min(60, Math.max(1, Math.round(num(raw.days)) || 14)),
    base,
    massage: num(raw.massage),
    other: num(raw.other),
    discount: num(raw.discount),
    features: Array.isArray(raw.features) ? raw.features.filter((f) => featureIds.has(f)) : [],
    memo: String(raw.memo || '').trim().slice(0, 60),
  };
}

function applyData(data) {
  const list = Array.isArray(data && data.centers) ? data.centers : [];
  state.centers = list.map(cleanCenter).filter(Boolean).slice(0, MAX_CENTERS);
  state.support = num(data && data.support);
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ centers: state.centers, support: state.support }));
  } catch (e) { /* ignore */ }
}

function encodeShare() {
  const json = JSON.stringify({ centers: state.centers, support: state.support });
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeShare(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function shareUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('d', encodeShare());
  return url.toString();
}

function summaryText() {
  const rows = ranked();
  const lines = ['🏡 산후조리원 가격 비교', ''];
  rows.forEach(({ c, r }, i) => {
    const room = ROOM_TYPES.find((x) => x.id === c.room).label;
    lines.push(`${i + 1}. ${c.name} (${room} ${c.days}일)`);
    lines.push(`   총 ${won(r.total)}만원 · 하루 ${won(r.perDay)}만원${state.support ? ` · 지원금 빼면 ${won(r.net)}만원` : ''}`);
    const feats = FEATURES.filter((f) => c.features.includes(f.id)).map((f) => f.label);
    if (feats.length) lines.push(`   ${feats.join(', ')}`);
    if (c.memo) lines.push(`   메모: ${c.memo}`);
  });
  lines.push('', shareUrl());
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ }
    ta.remove();
    return ok;
  }
}

// ---------- 렌더 ----------
function renderSupport() {
  $('supportPresets').innerHTML = SUPPORT_PRESETS.map((p) =>
    `<button class="toggle ${state.support === p.amount ? 'on' : ''}" data-amt="${p.amount}">${p.label}</button>`).join('');
  $('supportPresets').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      state.support = Number(b.dataset.amt);
      $('support').value = state.support || '';
      save();
      renderResult();
    });
  });
}

function renderRank(rows) {
  const max = Math.max(...rows.map((x) => x.r.total), 1);
  const best = rows[0];
  const useNet = state.support > 0;
  const rowsHtml = rows.map(({ c, r }, i) => {
    const diff = r.total - best.r.total;
    return `
      <div class="rank-row ${i === 0 ? 'best' : ''}">
        <div class="rank-top">
          <span class="rank-name">${i === 0 && rows.length > 1 ? '👑 ' : ''}${esc(c.name)}</span>
          <span class="rank-amt">${won(useNet ? r.net : r.total)}만원</span>
        </div>
        <div class="rank-bar"><i style="width:${Math.max(4, (r.total / max) * 100)}%"></i></div>
        <div class="rank-diff">${useNet ? `총 ${won(r.total)}만원 · ` : ''}하루 ${won(r.perDay)}만원${rows.length > 1 ? (i === 0 ? ' · 가장 저렴' : ` · 1위보다 +${won(diff)}만원`) : ''}</div>
      </div>`;
  }).join('');

  $('rankCard').innerHTML = `
    <h3>${rows.length > 1 ? '저렴한 순서' : '내 견적'}</h3>
    <div class="rank-sub">${useNet ? `지원금 ${won(state.support)}만원을 뺀 실부담 기준` : '추가비용·할인 반영한 총 결제액 기준'}</div>
    <div class="rank-rows">${rowsHtml}</div>
    <div class="avg-note">참고 — 전국 평균 2주 요금은 <b>일반실 ${BENCHMARK.avg.general}만원 · 특실 ${BENCHMARK.avg.special}만원</b>이에요 (${BENCHMARK.source}, ${BENCHMARK.asOf}). 지역 차이가 커서 서울·수도권은 이보다 높은 편이에요.</div>`;
}

function renderCenters(rows) {
  $('centerCards').innerHTML = rows.map(({ c, r }, i) => {
    const room = ROOM_TYPES.find((x) => x.id === c.room).label;
    const absDiff = Math.abs(r.avgDiff);
    const avgChip = absDiff < 1
      ? `<span class="chip chip-mute">전국 ${room} 평균 수준</span>`
      : r.avgDiff < 0
        ? `<span class="chip chip-sage">전국 ${room} 평균보다 ${won(absDiff)}만원 ↓</span>`
        : `<span class="chip chip-gold">전국 ${room} 평균보다 ${won(absDiff)}만원 ↑</span>`;
    const feats = FEATURES.filter((f) => c.features.includes(f.id))
      .map((f) => `<span class="chip chip-mute">${f.emoji} ${f.label}</span>`).join('');
    const line = (label, amt, cls = '') => amt ? `<div class="c-line ${cls}"><span>${label}</span><span>${cls === 'minus' ? '−' : ''}${won(amt)}만원</span></div>` : '';
    return `
      <div class="card center-card ${i === 0 && rows.length > 1 ? 'best' : ''}">
        <div class="c-head">
          <div class="c-title">
            <div class="c-name">${esc(c.name)}</div>
            <div class="c-meta">${room} · ${c.days}일${c.region ? ` · ${esc(c.region)}` : ''}</div>
          </div>
          ${i === 0 && rows.length > 1 ? '<span class="chip chip-brand">최저가</span>' : ''}
        </div>
        <div class="c-total-box">
          <span class="c-total">${won(state.support ? r.net : r.total)}<small>만원</small></span>
          <span class="c-total-detail">${state.support ? '지원금 뺀 실부담' : '총 결제액'}<br />하루 ${won(r.perDay)}만원꼴</span>
        </div>
        <div class="c-lines">
          ${line('기본 요금', c.base)}
          ${line('마사지 추가', c.massage)}
          ${line('기타 추가', c.other)}
          ${line('할인', c.discount, 'minus')}
          <div class="c-line sum"><span>총 결제액</span><span>${won(r.total)}만원</span></div>
          ${state.support ? line('지원금', Math.min(state.support, r.total), 'minus') : ''}
        </div>
        <div class="c-chips">${avgChip}${feats}</div>
        ${c.days !== 14 ? `<div class="c-memo">평균 비교는 기본 요금을 2주로 환산한 ${won(r.base2w)}만원 기준이에요.</div>` : ''}
        ${c.memo ? `<div class="c-memo">📝 ${esc(c.memo)}</div>` : ''}
        <div class="c-btns">
          <button data-act="edit" data-id="${esc(c.id)}">수정</button>
          <button data-act="del" data-id="${esc(c.id)}">삭제</button>
        </div>
      </div>`;
  }).join('');

  $('centerCards').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.act === 'edit') startEdit(b.dataset.id);
      else removeCenter(b.dataset.id);
    });
  });
}

function renderMatrix(rows) {
  const el = $('matrixCard');
  const used = FEATURES.filter((f) => rows.some(({ c }) => c.features.includes(f.id)));
  if (rows.length < 2 || !used.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <h3>포함 항목 한눈에</h3>
    <div class="matrix-scroll">
      <table class="matrix">
        <thead><tr><th></th>${rows.map(({ c }) => `<th title="${esc(c.name)}">${esc(c.name)}</th>`).join('')}</tr></thead>
        <tbody>
          ${used.map((f) => `<tr><td>${f.emoji} ${f.label}</td>${rows.map(({ c }) =>
            c.features.includes(f.id) ? '<td class="yes">✓</td>' : '<td class="no">–</td>').join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderResult() {
  const has = state.centers.length > 0;
  $('result').classList.toggle('hidden', !has);
  $('sampleBtn').classList.toggle('hidden', has);
  if (!has) return;
  const rows = ranked();
  renderSupport();
  renderRank(rows);
  renderCenters(rows);
  renderMatrix(rows);
}

// ---------- 폼 ----------
function renderFormFeatures() {
  $('fFeatures').innerHTML = FEATURES.map((f) =>
    `<button type="button" class="toggle ${state.formFeatures.has(f.id) ? 'on' : ''}" data-f="${f.id}">${f.emoji} ${f.label}</button>`).join('');
  $('fFeatures').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const id = b.dataset.f;
      if (state.formFeatures.has(id)) state.formFeatures.delete(id);
      else state.formFeatures.add(id);
      b.classList.toggle('on');
    });
  });
}

function resetForm() {
  state.editId = null;
  state.formFeatures = new Set();
  ['fName', 'fRegion', 'fBase', 'fMassage', 'fOther', 'fDiscount', 'fMemo'].forEach((id) => { $(id).value = ''; });
  $('fDays').value = 14;
  $('fRoom').value = 'general';
  $('formTitle').textContent = state.centers.length ? '조리원 하나 더 넣기' : '조리원 견적 넣기';
  $('saveBtn').textContent = '비교에 추가하기';
  $('cancelBtn').classList.add('hidden');
  renderFormFeatures();
}

function startEdit(id) {
  const c = state.centers.find((x) => x.id === id);
  if (!c) return;
  state.editId = id;
  state.formFeatures = new Set(c.features);
  $('fName').value = c.name;
  $('fRegion').value = c.region;
  $('fRoom').value = c.room;
  $('fBase').value = c.base;
  $('fDays').value = c.days;
  $('fMassage').value = c.massage || '';
  $('fOther').value = c.other || '';
  $('fDiscount').value = c.discount || '';
  $('fMemo').value = c.memo;
  $('formTitle').textContent = `${c.name} 수정`;
  $('saveBtn').textContent = '수정 저장하기';
  $('cancelBtn').classList.remove('hidden');
  renderFormFeatures();
  $('formCard').scrollIntoView({ behavior: 'smooth' });
}

function removeCenter(id) {
  const c = state.centers.find((x) => x.id === id);
  if (!c || !confirm(`${c.name}을(를) 비교에서 뺄까요?`)) return;
  state.centers = state.centers.filter((x) => x.id !== id);
  if (state.editId === id) resetForm();
  save();
  renderResult();
  resetFormTitle();
}

function resetFormTitle() {
  if (!state.editId) $('formTitle').textContent = state.centers.length ? '조리원 하나 더 넣기' : '조리원 견적 넣기';
}

function submitForm() {
  const name = $('fName').value.trim();
  const base = num($('fBase').value);
  const days = Math.round(num($('fDays').value));
  if (!name) { showToast('조리원 이름을 넣어 주세요'); $('fName').focus(); return; }
  if (!base) { showToast('기본 요금을 만원 단위로 넣어 주세요'); $('fBase').focus(); return; }
  if (!days || days > 60) { showToast('이용 기간을 확인해 주세요 (1~60일)'); $('fDays').focus(); return; }
  if (base > 10000) { showToast('만원 단위예요 — 380만원이면 380만 입력'); $('fBase').focus(); return; }
  if (!state.editId && state.centers.length >= MAX_CENTERS) { showToast(`최대 ${MAX_CENTERS}곳까지 비교할 수 있어요`); return; }

  const center = cleanCenter({
    id: state.editId || undefined,
    name, base, days,
    region: $('fRegion').value,
    room: $('fRoom').value,
    massage: $('fMassage').value,
    other: $('fOther').value,
    discount: $('fDiscount').value,
    features: [...state.formFeatures],
    memo: $('fMemo').value,
  });

  const editing = Boolean(state.editId);
  if (editing) state.centers = state.centers.map((c) => (c.id === state.editId ? center : c));
  else state.centers.push(center);

  save();
  resetForm();
  renderResult();
  showToast(editing ? '수정했어요' : state.centers.length === 1 ? '추가했어요 — 한 곳 더 넣으면 비교돼요' : '비교에 추가했어요');
  $('result').scrollIntoView({ behavior: 'smooth' });
}

// ---------- 시작 ----------
function init() {
  $('brandName').textContent = BRAND.suite;
  $('brandIg').href = BRAND.instagramUrl;
  $('footIg').href = BRAND.instagramUrl;
  $('footIgHandle').textContent = BRAND.instagram;
  $('disclaimer').textContent =
    `입력한 견적은 이 기기 브라우저에만 저장되고, 공유 링크를 만들 때만 링크 안에 담겨요. ` +
    `전국 평균은 ${BENCHMARK.source}(${BENCHMARK.asOf}) 수치로 참고용이며, 실제 요금·환불 조건은 조리원 계약서가 기준이에요.`;

  $('fRoom').innerHTML = ROOM_TYPES.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
  $('askList').innerHTML = ASK_LIST.map((t) => `<li>${t}</li>`).join('');

  // 공유 링크로 들어왔으면 그 데이터를, 아니면 저장된 데이터를 불러온다
  const shared = new URLSearchParams(location.search).get('d');
  let loaded = false;
  if (shared) {
    try { applyData(decodeShare(shared)); loaded = state.centers.length > 0; } catch (e) { /* 깨진 링크 */ }
    history.replaceState(null, '', location.pathname);
    if (loaded) { save(); showToast('공유받은 비교표를 불러왔어요'); }
    else showToast('링크를 읽지 못했어요');
  }
  if (!loaded) {
    try { applyData(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch (e) { /* ignore */ }
  }

  $('support').value = state.support || '';
  $('support').addEventListener('input', () => {
    state.support = num($('support').value);
    save();
    const rows = ranked();
    renderSupport();
    renderRank(rows);
    renderCenters(rows);
  });

  $('saveBtn').addEventListener('click', submitForm);
  $('cancelBtn').addEventListener('click', resetForm);
  $('sampleBtn').addEventListener('click', () => {
    applyData({ centers: SAMPLES, support: 200 });
    $('support').value = state.support;
    save();
    resetForm();
    renderResult();
    showToast('예시 견적이에요 — 수정·삭제하고 내 견적을 넣어 보세요');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('shareBtn').addEventListener('click', async () => {
    const url = shareUrl();
    if (navigator.share) {
      try { await navigator.share({ title: '산후조리원 가격 비교', text: '우리 조리원 후보 비교표예요', url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    showToast((await copyText(url)) ? '링크를 복사했어요 — 배우자에게 보내 보세요' : '복사에 실패했어요');
  });
  $('copyBtn').addEventListener('click', async () => {
    showToast((await copyText(summaryText())) ? '비교 내용을 복사했어요' : '복사에 실패했어요');
  });

  resetForm();
  renderResult();
}

init();
