// 브랜드 설정 — 서비스 전체에서 이 파일 하나만 수정하면 된다.
export const BRAND = {
  suite: 'uridaylog',
  instagram: '@uriday_log',
  instagramUrl: 'https://instagram.com/uriday_log',
  siteUrl: 'https://wkdwlsgh29-del.github.io/uridaylog/vaccine-calendar/',
  // 캘린더(.ics)를 올바른 MIME 타입으로 서빙하는 서버 함수 (Supabase Edge).
  // 비우면 브라우저 내 파일 다운로드 방식으로 동작한다.
  icsEndpoint: 'https://bmedbitonzkggfenymog.supabase.co/functions/v1/uriday-ics',
  // 함께 육아일지(baby-log) 가족 공유 서버 함수 (Supabase Edge Function 'uriday-log').
  // 비우면 '이 기기만' 모드 — 기록은 브라우저에만 저장되고 가족 초대·잠금화면 단축어 주소는 "곧 열려요"로 보인다.
  // 배포 후 넣을 값: 'https://bmedbitonzkggfenymog.supabase.co/functions/v1/uriday-log' (README 참고)
  logEndpoint: '',
  // 아이폰 잠금화면 기록용 '단축어' iCloud 공유 링크 (종류별 1개, https://www.icloud.com/shortcuts/…).
  // 각 단축어는 가져올 때 '코드'(가족 공유 기기 토큰)를 묻는 가져오기 질문을 넣어 만든다 (RESEARCH D).
  // 링크가 있으면 잠금화면 안내에 [내 코드 복사] + [○○ 버튼 받기] 버튼이, 비어 있으면 직접 만드는 안내가 보인다.
  iosShortcuts: {
    pee: '',      // 💧 소변 기록
    poop: '',     // 💩 대변 기록
    both: '',     // 💧💩 소변+대변 기록
    formula: '',  // 🍼 분유 기록 (양은 가족의 지난번 분유 양)
    sleep: '',    // 😴 재우기/깼어요 (한 번 누르면 잠 시작, 다시 누르면 끝)
    burp: '',     // 😮‍💨 트림 (90분 안 마지막 수유에 '트림 ✓'로 붙음)
  },
};
