// 일정 계산 로직 — 순수 모듈 (DOM 의존 없음)
// 웹앱(app.js)과 서버 캘린더 함수(Supabase Edge)가 이 파일을 공유한다.
import { addDays, addMonths } from '../shared/js/date-utils.js';
import { VACCINES, CHECKUPS, DENTAL_CHECKUPS } from './schedule-data.js';

export function resolveDate(birth, off) {
  return addDays(addMonths(birth, off.m || 0), off.d || 0);
}

export function ageLabel(off) {
  const m = off.m || 0, d = off.d || 0;
  if (m === 0 && d === 0) return '출생 직후';
  if (m === 0) return `생후 ${d}일`;
  if (m >= 48 && m % 12 === 0) return `만 ${m / 12}세`;
  if (m >= 48) return `만 ${Math.floor(m / 12)}세`;
  return `생후 ${m}개월`;
}

export function buildEvents(birth) {
  const events = [];
  for (const v of VACCINES) {
    for (const dose of v.doses) {
      events.push({
        key: `${v.id}-${dose.no}`,
        cat: 'vaccine',
        title: v.name,
        doseLabel: dose.label,
        windowText: dose.windowText,
        note: dose.note || '',
        optional: !!dose.optional,
        start: resolveDate(birth, dose.start),
        end: resolveDate(birth, dose.end),
        groupLabel: ageLabel(dose.start),
      });
    }
  }
  for (const c of [...CHECKUPS, ...DENTAL_CHECKUPS]) {
    const isDental = c.kind === 'dental';
    events.push({
      key: `${c.kind}-${c.round}`,
      cat: 'checkup',
      kind: c.kind,
      title: isDental ? `영유아 구강검진 ${c.round}차` : `영유아 건강검진 ${c.round}차`,
      doseLabel: '',
      windowText: c.windowText,
      note: c.focus || '',
      start: resolveDate(birth, c.start),
      end: resolveDate(birth, c.end),
      groupLabel: ageLabel(c.start),
    });
  }
  events.sort((a, b) => a.start - b.start || a.end - b.end);
  return events;
}
