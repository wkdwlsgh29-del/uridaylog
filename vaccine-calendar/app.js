import { BRAND } from '../shared/js/brand.js';
import { parseDate, today, addMonths, diffDays, fmt, fmtShort, toISO, ageText } from '../shared/js/date-utils.js';
import { downloadICS } from '../shared/js/ics.js';
import { SCHEDULE_META } from './schedule-data.js';
import { buildEvents } from './schedule-logic.js';

// ---------- 상태 ----------
const state = {
  birth: null,       // Date
  name: '',
  done: new Set(),   // 완료한 이벤트 key
  filter: 'all',
};

const $ = (id) => document.getElementById(id);

function statusOf(ev) {
  const t = today();
  if (state.done.has(ev.key)) return 'done';
  if (ev.end < t) return 'past';
  if (ev.start <= t) return 'now';
  if (diffDays(t, ev.start) <= 60) return 'soon';
  return 'future';
}

// ---------- 렌더링 ----------
function render() {
  const { birth, name } = state;
  const events = buildEvents(birth);
  const t = today();

  $('sumName').textContent = name || '우리 아기';
  $('sumBirth').textContent = `${fmt(birth)} 출생`;
  $('sumAge').textContent = ageText(birth, t);

  // 다음 일정 하이라이트
  const nowItems = events.filter((e) => statusOf(e) === 'now');
  const nextItem = nowItems[0] || events.find((e) => statusOf(e) === 'soon' || statusOf(e) === 'future');
  const nextBox = $('nextBox');
  if (nextItem) {
    const isNow = statusOf(nextItem) === 'now';
    const dday = isNow ? '지금!' : `D-${diffDays(t, nextItem.start)}`;
    const extra = nowItems.length > 1 ? ` 외 ${nowItems.length - 1}건` : '';
    nextBox.innerHTML = `
      <div class="dday ${isNow ? 'now' : ''}">${dday}</div>
      <div>
        <div class="next-title">${nextItem.title} ${nextItem.doseLabel}${extra}</div>
        <div class="next-date">${isNow ? `${fmtShort(nextItem.end)}까지 가능해요` : `${fmt(nextItem.start)}부터`}</div>
      </div>`;
  } else {
    nextBox.innerHTML = `<div class="next-title">🎉 표준 일정을 모두 지났어요</div>`;
  }

  // 진행률
  const doneCount = events.filter((e) => state.done.has(e.key)).length;
  $('progText').textContent = `${doneCount} / ${events.length}`;
  $('progBar').style.width = `${events.length ? Math.round((doneCount / events.length) * 100) : 0}%`;

  // 지난 일정 일괄 완료 버튼 (지난 미체크 항목이 있을 때만)
  const pastPending = events.filter((e) => statusOf(e) === 'past');
  $('bulkPastBtn').classList.toggle('hidden', pastPending.length === 0);
  $('bulkPastBtn').dataset.count = pastPending.length;

  // 타임라인 (시작일 기준 그룹)
  const filtered = events.filter((e) => state.filter === 'all' || e.cat === state.filter);
  const groups = new Map();
  for (const ev of filtered) {
    const k = toISO(ev.start);
    if (!groups.has(k)) groups.set(k, { start: ev.start, label: ev.groupLabel, items: [] });
    groups.get(k).items.push(ev);
  }

  const tl = $('timeline');
  tl.innerHTML = '';
  for (const g of groups.values()) {
    const gStatuses = g.items.map(statusOf);
    const gClass = gStatuses.some((s) => s === 'now') ? 'g-now'
      : gStatuses.every((s) => s === 'past' || s === 'done') ? 'g-past' : '';
    const div = document.createElement('div');
    div.className = `tl-group ${gClass}`;
    div.innerHTML = `
      <div class="tl-head">
        <span class="tl-age">${g.label}</span>
        <span class="tl-date">${fmtShort(g.start)}부터</span>
      </div>
      <div class="tl-items">
        ${g.items.map(itemHTML).join('')}
      </div>`;
    tl.appendChild(div);
  }

  // 체크박스 바인딩
  tl.querySelectorAll('.item').forEach((el) => {
    el.querySelector('.check').addEventListener('click', () => toggleDone(el.dataset.key));
  });

  renderPrintSheet(events);
}

function itemHTML(ev) {
  const s = statusOf(ev);
  const statusChip =
    s === 'done' ? '<span class="chip chip-sage">완료</span>'
    : s === 'now' ? '<span class="chip chip-sage">지금 가능</span>'
    : s === 'soon' ? `<span class="chip chip-gold">곧 다가와요</span>`
    : s === 'past' ? '<span class="chip chip-danger">시기 지남</span>'
    : '';
  const catChip = ev.cat === 'checkup'
    ? (ev.kind === 'dental' ? '<span class="chip chip-sage">🦷 구강검진</span>' : '<span class="chip chip-sage">🩺 검진</span>')
    : '<span class="chip chip-brand">💉 접종</span>';
  return `
    <div class="item ${s === 'done' ? 'done' : ''}" data-key="${ev.key}">
      <button class="check" aria-label="완료 체크">✓</button>
      <div class="item-body">
        <div class="item-title">${ev.title} <span class="dose">${ev.doseLabel}</span></div>
        <div class="item-meta">
          ${catChip}${statusChip}
          <span class="item-window">${ev.windowText}</span>
        </div>
        ${ev.note ? `<div class="item-note">${ev.note}</div>` : ''}
      </div>
    </div>`;
}

// ---------- 인쇄 시트 ----------
function renderPrintSheet(events) {
  const rows = events.map((ev) => `
    <tr>
      <td class="p-age">${ev.groupLabel}</td>
      <td>${ev.title} ${ev.doseLabel} <span class="p-cat">${ev.cat === 'checkup' ? '(검진)' : ''}</span></td>
      <td>${fmtShort(ev.start)} ~ ${fmtShort(ev.end)}</td>
      <td style="width:70px"></td>
      <td style="width:30px; text-align:center"><span class="p-box"></span></td>
    </tr>`).join('');
  $('printSheet').innerHTML = `
    <h1>${state.name || '우리 아기'} 접종·검진 체크리스트</h1>
    <div class="p-sub">${fmt(state.birth)} 출생 · ${SCHEDULE_META.standard} 기준 · ${BRAND.suite} ${BRAND.instagram}</div>
    <table class="p-table">
      <thead><tr><th>시기</th><th>항목</th><th>권장 기간</th><th>접종/검진일</th><th>완료</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="p-foot">본 일정표는 표준 일정 기준 참고용입니다. 실제 접종·검진은 의료기관과 상담 후 진행하세요.</div>`;
}

// ---------- 완료 체크 저장 ----------
function doneStorageKey() {
  return `vc:done:${toISO(state.birth)}`;
}

function toggleDone(key) {
  if (state.done.has(key)) state.done.delete(key);
  else state.done.add(key);
  try {
    localStorage.setItem(doneStorageKey(), JSON.stringify([...state.done]));
  } catch (e) { /* 시크릿 모드 등 저장 불가 환경 무시 */ }
  render();
}

function loadDone() {
  try {
    const raw = localStorage.getItem(doneStorageKey());
    state.done = new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    state.done = new Set();
  }
}

// ---------- 액션 ----------
function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function shareURL() {
  const url = new URL(BRAND.siteUrl || location.href.split('?')[0]);
  url.searchParams.set('bd', toISO(state.birth));
  if (state.name) url.searchParams.set('name', state.name);
  return url.toString();
}

async function onShare() {
  const url = shareURL();
  if (navigator.share) {
    try {
      await navigator.share({ title: '우리아기 접종·검진 캘린더', url });
      return;
    } catch (e) { /* 사용자가 취소한 경우 → 복사로 폴백하지 않음 */ if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('링크를 복사했어요!');
  } catch (e) {
    prompt('아래 링크를 복사하세요', url);
  }
}

// ---------- 환경 감지 ----------
const UA = navigator.userAgent;
const isInApp = /Instagram|KAKAOTALK|NAVER|FBAV|FBAN/i.test(UA);
const isIOS = /iPhone|iPad|iPod/i.test(UA);
const isAndroid = /Android/i.test(UA);

function showICSGuide() {
  $('sheetTitle').textContent = '📅 캘린더에 넣는 법';
  const body = $('icsGuideBody');
  if (isIOS) {
    body.innerHTML = `
      <ol>
        <li>잠시 후 뜨는 화면에서 <b>"모두 추가"</b>(또는 "캘린더에 추가")를 누르면 끝!</li>
        <li>화면이 안 뜨면: 주소창 옆 <b>↓ 아이콘 → 다운로드 항목</b>에서 파일을 열어주세요.</li>
      </ol>
      <div class="sheet-tip">알림도 함께 등록돼서 각 일정 7일 전에 미리 알려줘요.</div>`;
  } else if (isAndroid) {
    body.innerHTML = `
      <ol>
        <li>다운로드 알림에서 <b>일정 파일(.ics)을 탭</b>해 캘린더 앱으로 열어주세요.</li>
        <li><b>삼성 캘린더</b>: 바로 전체 일정이 들어가요.</li>
        <li><b>구글 캘린더 앱</b>에서 일부만 보이면: 브라우저에서 calendar.google.com → 설정 → <b>가져오기</b>에 파일을 올리면 전체가 들어가요.</li>
      </ol>
      <div class="sheet-tip">알림도 함께 등록돼서 각 일정 7일 전에 미리 알려줘요.</div>`;
  } else {
    body.innerHTML = `
      <ol>
        <li>다운로드된 .ics 파일을 캘린더 앱(구글/애플/아웃룩)으로 열면 전체 일정이 들어가요.</li>
      </ol>`;
  }
  $('icsGuide').classList.remove('hidden');
}

function showInstallGuide() {
  $('sheetTitle').textContent = '📲 홈 화면에 추가하는 법';
  const body = $('icsGuideBody');
  if (isIOS) {
    body.innerHTML = `
      <ol>
        <li>Safari 하단(또는 상단)의 <b>공유 버튼 ⬆︎</b>을 눌러주세요.</li>
        <li>목록에서 <b>"홈 화면에 추가"</b>를 선택하고 <b>추가</b>를 누르면 끝!</li>
      </ol>
      <div class="sheet-tip">홈 화면 아이콘으로 열면 앱처럼 전체 화면으로 열려요. 인스타그램 안에서 보고 있다면 먼저 ⋯ 메뉴 → 외부 브라우저(Safari)로 열어주세요.</div>`;
  } else {
    body.innerHTML = `
      <ol>
        <li>브라우저 <b>⋮ 메뉴</b>를 눌러주세요.</li>
        <li><b>"홈 화면에 추가"</b>(또는 "앱 설치")를 선택하면 끝!</li>
      </ol>
      <div class="sheet-tip">홈 화면 아이콘으로 열면 앱처럼 전체 화면으로 열려요.</div>`;
  }
  $('icsGuide').classList.remove('hidden');
}

function onICS() {
  const events = buildEvents(state.birth)
    .filter((ev) => !state.done.has(ev.key) && ev.end >= today());
  if (!events.length) {
    showToast('추가할 남은 일정이 없어요');
    return;
  }
  if (isInApp) {
    // 인스타 등 인앱 브라우저는 파일 다운로드가 막히는 경우가 많다
    showToast('⋯ 메뉴에서 "외부 브라우저로 열기" 후 다시 눌러주세요');
    $('inappBanner').classList.remove('hidden');
    return;
  }
  if (BRAND.icsEndpoint) {
    // 서버가 text/calendar MIME으로 직접 응답 → iOS는 "캘린더에 추가" 화면이 바로 뜬다
    const u = new URL(BRAND.icsEndpoint);
    u.searchParams.set('bd', toISO(state.birth));
    if (state.name) u.searchParams.set('name', state.name);
    if (state.done.size) u.searchParams.set('skip', [...state.done].join(','));
    showICSGuide();
    location.href = u.toString();
    return;
  }
  const babyLabel = state.name || '아기';
  const icsEvents = events.map((ev) => ({
    uid: `${toISO(state.birth)}-${ev.key}@baby-tools`,
    title: `${babyLabel} ${ev.title} ${ev.doseLabel}`.trim(),
    date: ev.start,
    endDate: null, // 시작일 하루 일정으로 등록 (기간 등록은 캘린더가 지저분해짐)
    description: `권장 기간: ${ev.windowText} (${fmtShort(ev.start)}~${fmtShort(ev.end)})${ev.note ? `\n${ev.note}` : ''}\n\n${BRAND.suite} ${BRAND.instagram}`,
  }));
  downloadICS(`${babyLabel}_접종검진일정.ics`, `${babyLabel} 접종·검진`, icsEvents);
  showToast(`남은 일정 ${events.length}건을 내려받았어요!`);
  showICSGuide();
}

// ---------- 진입/폼 ----------
function showResult() {
  $('hero').classList.add('hidden');
  $('inputCard').classList.add('hidden');
  $('result').classList.remove('hidden');
  render();
  window.scrollTo({ top: 0 });
}

function showInput() {
  $('hero').classList.remove('hidden');
  $('inputCard').classList.remove('hidden');
  $('result').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
}

function start(birthISO, name) {
  const birth = parseDate(birthISO);
  const t = today();
  if (isNaN(birth) || birth > t) {
    showToast('생년월일을 확인해 주세요');
    return;
  }
  if (diffDays(birth, t) > 365 * 13) {
    showToast('만 12세 이하 어린이 일정만 제공해요');
    return;
  }
  state.birth = birth;
  state.name = (name || '').trim();
  loadDone();
  try {
    localStorage.setItem('vc:last', JSON.stringify({ bd: birthISO, name: state.name }));
  } catch (e) { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set('bd', birthISO);
  if (state.name) url.searchParams.set('name', state.name);
  else url.searchParams.delete('name');
  history.replaceState(null, '', url);
  showResult();
}

function init() {
  // 브랜드 적용 (단일 소스: shared/js/brand.js)
  $('brandName').textContent = BRAND.suite;
  $('brandIg').href = BRAND.instagramUrl;
  $('footIg').href = BRAND.instagramUrl;
  $('footIgHandle').textContent = BRAND.instagram;
  $('disclaimer').textContent =
    `본 서비스는 ${SCHEDULE_META.standard}(${SCHEDULE_META.year}년 기준)를 바탕으로 한 참고용 정보입니다. ` +
    `의학적 판단을 대신하지 않으며, 실제 접종·검진 일정은 소아청소년과 의사와 상담해 결정하세요.`;

  const bi = $('babyBirth');
  bi.max = toISO(today());
  bi.min = toISO(addMonths(today(), -156));

  $('makeBtn').addEventListener('click', () => {
    if (!bi.value) {
      showToast('생년월일을 입력해 주세요');
      return;
    }
    start(bi.value, $('babyName').value);
  });

  $('resetBtn').addEventListener('click', showInput);
  $('shareBtn').addEventListener('click', onShare);
  $('icsBtn').addEventListener('click', onICS);
  $('printBtn').addEventListener('click', () => window.print());
  $('bulkPastBtn').addEventListener('click', () => {
    const events = buildEvents(state.birth);
    const past = events.filter((e) => statusOf(e) === 'past');
    past.forEach((e) => state.done.add(e.key));
    try {
      localStorage.setItem(doneStorageKey(), JSON.stringify([...state.done]));
    } catch (e) { /* ignore */ }
    render();
    showToast(`지난 일정 ${past.length}건을 완료로 표시했어요. 실제 접종 여부는 예방접종도우미에서 확인!`);
  });
  $('icsGuideClose').addEventListener('click', () => $('icsGuide').classList.add('hidden'));
  $('icsGuide').addEventListener('click', (e) => {
    if (e.target === $('icsGuide')) $('icsGuide').classList.add('hidden');
  });
  if (isInApp) $('inappBanner').classList.remove('hidden');

  // 홈 화면 추가 (PWA 설치)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* http 미리보기 등에선 무시 */ });
  }
  const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    if (!isStandalone) $('installBtn').classList.remove('hidden');
  });
  if (!isStandalone && isIOS) $('installBtn').classList.remove('hidden');
  $('installBtn').addEventListener('click', async () => {
    if (installPrompt) {
      installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        $('installBtn').classList.add('hidden');
        showToast('홈 화면에 추가됐어요!');
      }
      installPrompt = null;
      return;
    }
    showInstallGuide();
  });

  $('filters').addEventListener('click', (e) => {
    const btn = e.target.closest('.filter-btn');
    if (!btn) return;
    state.filter = btn.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
    render();
  });

  // URL 파라미터 → 공유 링크로 바로 진입
  const params = new URLSearchParams(location.search);
  const bd = params.get('bd');
  if (bd && /^\d{4}-\d{2}-\d{2}$/.test(bd)) {
    bi.value = bd;
    $('babyName').value = params.get('name') || '';
    start(bd, params.get('name') || '');
    return;
  }

  // 재방문 → 마지막 입력 복원 (자동 진입은 하지 않고 입력만 채워둔다)
  try {
    const last = JSON.parse(localStorage.getItem('vc:last') || 'null');
    if (last && last.bd) {
      bi.value = last.bd;
      $('babyName').value = last.name || '';
    }
  } catch (e) { /* ignore */ }
}

init();
