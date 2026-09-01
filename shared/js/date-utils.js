// 날짜 계산 유틸 — 모든 도구 공용. 시간대 문제를 피하기 위해 로컬 자정 기준으로만 계산한다.

export function parseDate(str) {
  // 'YYYY-MM-DD' → 로컬 자정 Date
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function today() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMonths(date, months) {
  // 말일 보정: 1/31 + 1개월 → 2/28(29). setMonth의 오버플로를 막는다.
  const d = new Date(date);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

export function diffDays(a, b) {
  return Math.round((b - a) / 86400000);
}

export function fmt(date) {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일`;
}

export function fmtShort(date) {
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

export function toISO(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// 생후 개월수: 'N개월 M일' (만 나이 방식)
export function ageText(birth, ref) {
  let months = (ref.getFullYear() - birth.getFullYear()) * 12 + (ref.getMonth() - birth.getMonth());
  let anchor = addMonths(birth, months);
  if (anchor > ref) {
    months -= 1;
    anchor = addMonths(birth, months);
  }
  const days = diffDays(anchor, ref);
  if (months <= 0) return `${diffDays(birth, ref)}일`;
  return days === 0 ? `${months}개월` : `${months}개월 ${days}일`;
}
