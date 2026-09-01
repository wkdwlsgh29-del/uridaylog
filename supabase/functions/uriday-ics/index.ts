// uridaylog — 접종·검진 캘린더 .ics 서빙 함수
// 공개 엔드포인트: 캘린더 링크는 인증 헤더를 보낼 수 없으므로 JWT 검증 없음.
// 개인정보 저장 없음 — 쿼리로 받은 생일로 일정을 계산해 즉시 반환만 한다.
//
// ⚠ 배포 방법: 이 함수는 저장소의 schedule-data/logic/date-utils/ics 파일을 동봉해 배포한다.
//   schedule-data.js 등을 수정하면 함수도 재배포해야 한다 (아래 파일들을 함께 업로드):
//   - index.ts (이 파일)
//   - vaccine-calendar/schedule-logic.js, vaccine-calendar/schedule-data.js (저장소 원본 복사)
//   - shared/js/date-utils.js, shared/js/ics.js (저장소 원본 복사)
//   배포 대상: Supabase 프로젝트 bmedbitonzkggfenymog, 함수명 uriday-ics, verify_jwt=false
import { buildEvents } from './vaccine-calendar/schedule-logic.js';
import { buildICS } from './shared/js/ics.js';
import { parseDate, fmtShort } from './shared/js/date-utils.js';

const BRAND_LINE = 'uridaylog @uriday_log';

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  const bd = url.searchParams.get('bd') || '';
  const name = (url.searchParams.get('name') || '').slice(0, 20).trim();
  const skip = new Set((url.searchParams.get('skip') || '').split(',').filter(Boolean));

  if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) {
    return new Response('bd 파라미터가 필요합니다 (YYYY-MM-DD)', { status: 400 });
  }
  const birth = parseDate(bd);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (isNaN(birth.getTime()) || birth > today) {
    return new Response('생년월일이 올바르지 않습니다', { status: 400 });
  }

  const babyLabel = name || '아기';
  const events = buildEvents(birth)
    .filter((ev: any) => !skip.has(ev.key) && ev.end >= today)
    .map((ev: any) => ({
      uid: `${bd}-${ev.key}@uridaylog`,
      title: `${babyLabel} ${ev.title} ${ev.doseLabel}`.trim(),
      date: ev.start,
      endDate: null,
      description: `권장 기간: ${ev.windowText} (${fmtShort(ev.start)}~${fmtShort(ev.end)})${ev.note ? `\n${ev.note}` : ''}\n\n${BRAND_LINE}`,
    }));

  if (!events.length) {
    return new Response('추가할 남은 일정이 없습니다', { status: 404 });
  }

  const ics = buildICS(`${babyLabel} 접종·검진`, events);
  const asciiName = `uridaylog-${bd}.ics`;
  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(`${babyLabel}_접종검진일정.ics`)}`,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
});
