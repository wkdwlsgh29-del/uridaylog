// .ics(iCalendar) 생성 — 구글/애플/네이버 캘린더에서 모두 열린다.
// events: [{ uid, title, date(Date), endDate(Date|null), description }]

function icsDate(date) {
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}

function escapeText(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function foldLine(line) {
  // RFC 5545: 75 옥텟 초과 줄은 접는다 (한글 안전하게 60자 기준)
  const out = [];
  let rest = line;
  while (rest.length > 60) {
    out.push(rest.slice(0, 60));
    rest = ' ' + rest.slice(60);
  }
  out.push(rest);
  return out.join('\r\n');
}

export function buildICS(calName, events) {
  const now = new Date();
  const stamp = `${icsDate(now)}T000000Z`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//baby-tools//KR',
    'CALSCALE:GREGORIAN',
    foldLine(`X-WR-CALNAME:${escapeText(calName)}`),
  ];
  for (const ev of events) {
    const end = ev.endDate || ev.date;
    // DTEND는 배타적 → 하루 더한다
    const endPlus = new Date(end);
    endPlus.setDate(endPlus.getDate() + 1);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${ev.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(ev.date)}`,
      `DTEND;VALUE=DATE:${icsDate(endPlus)}`,
      foldLine(`SUMMARY:${escapeText(ev.title)}`),
      foldLine(`DESCRIPTION:${escapeText(ev.description || '')}`),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      foldLine(`DESCRIPTION:${escapeText(ev.title)}`),
      'TRIGGER:-P7D',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function downloadICS(filename, calName, events) {
  const blob = new Blob([buildICS(calName, events)], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
