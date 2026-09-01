// 브랜드 설정 — 서비스 전체에서 이 파일 하나만 수정하면 된다.
export const BRAND = {
  suite: 'uridaylog',
  instagram: '@uriday_log',
  instagramUrl: 'https://instagram.com/uriday_log',
  siteUrl: 'https://wkdwlsgh29-del.github.io/uridaylog/vaccine-calendar/',
  // 캘린더(.ics)를 올바른 MIME 타입으로 서빙하는 서버 함수 (Supabase Edge).
  // 비우면 브라우저 내 파일 다운로드 방식으로 동작한다.
  icsEndpoint: 'https://bmedbitonzkggfenymog.supabase.co/functions/v1/uriday-ics',
};
