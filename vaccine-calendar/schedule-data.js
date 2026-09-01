// ============================================================
// 접종·검진 일정 데이터 — 단일 소스
// 기준: 질병관리청 표준예방접종일정표 / 국민건강보험공단 영유아검진
// 일정이 개정되면 이 파일만 수정한다.
//
// window 규칙:
//   start/end = { m: 개월, d: 일 } → 날짜 = addDays(addMonths(생일, m), d)
//   end는 포함(inclusive). "12~15개월" = start {m:12} ~ end {m:16, d:-1}
// ============================================================

export const SCHEDULE_META = {
  standard: '질병관리청 표준예방접종일정표 · 국민건강보험공단 영유아검진',
  year: 2026,
};

export const VACCINES = [
  {
    id: 'bcg', name: 'BCG(결핵)', national: true,
    doses: [
      { no: 1, label: '1회', start: { m: 0, d: 0 }, end: { m: 0, d: 28 }, windowText: '생후 4주 이내', note: '피내용(주사형)이 국가지원 무료. 경피용(도장형)은 본인부담' },
    ],
  },
  {
    id: 'hepb', name: 'B형간염', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 0, d: 0 }, end: { m: 0, d: 0 }, windowText: '출생 직후', note: '보통 분만 병원에서 접종. 산모가 B형간염 보유자면 출생 후 12시간 이내 접종' },
      { no: 2, label: '2차', start: { m: 1, d: 0 }, end: { m: 2, d: -1 }, windowText: '생후 1개월' },
      { no: 3, label: '3차', start: { m: 6, d: 0 }, end: { m: 7, d: -1 }, windowText: '생후 6개월' },
    ],
  },
  {
    id: 'dtap', name: 'DTaP(디프테리아·파상풍·백일해)', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 2, d: 0 }, end: { m: 3, d: -1 }, windowText: '생후 2개월' },
      { no: 2, label: '2차', start: { m: 4, d: 0 }, end: { m: 5, d: -1 }, windowText: '생후 4개월' },
      { no: 3, label: '3차', start: { m: 6, d: 0 }, end: { m: 7, d: -1 }, windowText: '생후 6개월' },
      { no: 4, label: '4차(추가)', start: { m: 15, d: 0 }, end: { m: 19, d: -1 }, windowText: '생후 15~18개월' },
      { no: 5, label: '5차(추가)', start: { m: 48, d: 0 }, end: { m: 84, d: -1 }, windowText: '만 4~6세', note: 'IPV 4차와 함께 DTaP-IPV 혼합백신으로 접종 가능' },
    ],
  },
  {
    id: 'tdap', name: 'Tdap/Td(파상풍·디프테리아·백일해)', national: true,
    doses: [
      { no: 6, label: '6차', start: { m: 132, d: 0 }, end: { m: 156, d: -1 }, windowText: '만 11~12세', note: 'Tdap 권장. 이후 10년마다 Td 재접종' },
    ],
  },
  {
    id: 'ipv', name: 'IPV(폴리오)', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 2, d: 0 }, end: { m: 3, d: -1 }, windowText: '생후 2개월' },
      { no: 2, label: '2차', start: { m: 4, d: 0 }, end: { m: 5, d: -1 }, windowText: '생후 4개월' },
      { no: 3, label: '3차', start: { m: 6, d: 0 }, end: { m: 19, d: -1 }, windowText: '생후 6~18개월' },
      { no: 4, label: '4차(추가)', start: { m: 48, d: 0 }, end: { m: 84, d: -1 }, windowText: '만 4~6세' },
    ],
  },
  {
    id: 'hib', name: 'Hib(b형 헤모필루스 인플루엔자)', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 2, d: 0 }, end: { m: 3, d: -1 }, windowText: '생후 2개월' },
      { no: 2, label: '2차', start: { m: 4, d: 0 }, end: { m: 5, d: -1 }, windowText: '생후 4개월' },
      { no: 3, label: '3차', start: { m: 6, d: 0 }, end: { m: 7, d: -1 }, windowText: '생후 6개월' },
      { no: 4, label: '4차(추가)', start: { m: 12, d: 0 }, end: { m: 16, d: -1 }, windowText: '생후 12~15개월' },
    ],
  },
  {
    id: 'pcv', name: '폐렴구균(PCV)', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 2, d: 0 }, end: { m: 3, d: -1 }, windowText: '생후 2개월' },
      { no: 2, label: '2차', start: { m: 4, d: 0 }, end: { m: 5, d: -1 }, windowText: '생후 4개월' },
      { no: 3, label: '3차', start: { m: 6, d: 0 }, end: { m: 7, d: -1 }, windowText: '생후 6개월' },
      { no: 4, label: '4차(추가)', start: { m: 12, d: 0 }, end: { m: 16, d: -1 }, windowText: '생후 12~15개월' },
    ],
  },
  {
    id: 'rv', name: '로타바이러스', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 2, d: 0 }, end: { m: 3, d: -1 }, windowText: '생후 2개월', note: '먹는 백신. 로타릭스(2회)·로타텍(3회) 중 선택. 1차는 생후 14주 6일까지 시작, 모든 차수는 생후 8개월 0일까지 완료해야 함' },
      { no: 2, label: '2차', start: { m: 4, d: 0 }, end: { m: 5, d: -1 }, windowText: '생후 4개월' },
      { no: 3, label: '3차', start: { m: 6, d: 0 }, end: { m: 7, d: -1 }, windowText: '생후 6개월', note: '로타텍(3회 백신)만 해당. 로타릭스는 2차로 완료', optional: true },
    ],
  },
  {
    id: 'mmr', name: 'MMR(홍역·유행성이하선염·풍진)', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 12, d: 0 }, end: { m: 16, d: -1 }, windowText: '생후 12~15개월' },
      { no: 2, label: '2차', start: { m: 48, d: 0 }, end: { m: 84, d: -1 }, windowText: '만 4~6세' },
    ],
  },
  {
    id: 'var', name: '수두', national: true,
    doses: [
      { no: 1, label: '1회', start: { m: 12, d: 0 }, end: { m: 16, d: -1 }, windowText: '생후 12~15개월', note: '국가지원은 1회 (2차는 선택·본인부담)' },
    ],
  },
  {
    id: 'hepa', name: 'A형간염', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 12, d: 0 }, end: { m: 24, d: -1 }, windowText: '생후 12~23개월' },
      { no: 2, label: '2차', start: { m: 18, d: 0 }, end: { m: 36, d: -1 }, windowText: '1차 접종 후 6~12개월', note: '1차 접종일 기준으로 6개월 이상 지난 뒤 접종' },
    ],
  },
  {
    id: 'ijev', name: '일본뇌염(불활성화 백신)', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 12, d: 0 }, end: { m: 24, d: -1 }, windowText: '생후 12~23개월', note: '불활성화(사백신, 총 5회) 기준. 약독화 생백신 선택 시 총 2회(1차 후 12개월 뒤 2차)로 완료 — 두 종류 교차접종은 권장하지 않음' },
      { no: 2, label: '2차', start: { m: 13, d: 0 }, end: { m: 24, d: -1 }, windowText: '1차 접종 후 1개월' },
      { no: 3, label: '3차', start: { m: 24, d: 0 }, end: { m: 36, d: -1 }, windowText: '2차 접종 후 11개월' },
      { no: 4, label: '4차', start: { m: 72, d: 0 }, end: { m: 84, d: -1 }, windowText: '만 6세' },
      { no: 5, label: '5차', start: { m: 144, d: 0 }, end: { m: 156, d: -1 }, windowText: '만 12세' },
    ],
  },
  {
    id: 'flu', name: '인플루엔자(독감)', national: true,
    doses: [
      { no: 1, label: '1차', start: { m: 6, d: 0 }, end: { m: 12, d: -1 }, windowText: '생후 6개월 이후 첫 가을', note: '매년 가을~겨울 절기에 국가 무료지원. 생애 처음 맞는 해에는 4주 간격 2회' },
      { no: 2, label: '2차', start: { m: 7, d: 0 }, end: { m: 13, d: -1 }, windowText: '1차 접종 후 4주', note: '첫해에만 2회. 이후 매 절기 1회씩 접종' },
    ],
  },
  {
    id: 'hpv', name: 'HPV(사람유두종바이러스)', national: true,
    doses: [
      { no: 1, label: '1·2차', start: { m: 132, d: 0 }, end: { m: 156, d: -1 }, windowText: '만 11~12세', note: '만 14세 이하 첫 접종 시 6~12개월 간격 2회. 여성 청소년과 12세 남아 국가지원(2026년 기준, 정책 변동 가능)' },
    ],
  },
];

// 영유아 건강검진 (국민건강보험공단, 총 8차)
export const CHECKUPS = [
  { round: 1, kind: 'health', windowText: '생후 14~35일', start: { m: 0, d: 14 }, end: { m: 0, d: 35 }, focus: '문진·진찰, 신체계측, 건강교육' },
  { round: 2, kind: 'health', windowText: '생후 4~6개월', start: { m: 4, d: 0 }, end: { m: 7, d: -1 }, focus: '문진·진찰, 신체계측, 건강교육' },
  { round: 3, kind: 'health', windowText: '생후 9~12개월', start: { m: 9, d: 0 }, end: { m: 13, d: -1 }, focus: '발달선별검사(K-DST) 포함' },
  { round: 4, kind: 'health', windowText: '생후 18~24개월', start: { m: 18, d: 0 }, end: { m: 25, d: -1 }, focus: '발달선별검사(K-DST) 포함' },
  { round: 5, kind: 'health', windowText: '생후 30~36개월', start: { m: 30, d: 0 }, end: { m: 37, d: -1 }, focus: '발달선별검사(K-DST) 포함' },
  { round: 6, kind: 'health', windowText: '생후 42~48개월', start: { m: 42, d: 0 }, end: { m: 49, d: -1 }, focus: '발달선별검사(K-DST)·청력 확인 포함' },
  { round: 7, kind: 'health', windowText: '생후 54~60개월', start: { m: 54, d: 0 }, end: { m: 61, d: -1 }, focus: '발달선별검사(K-DST) 포함' },
  { round: 8, kind: 'health', windowText: '생후 66~71개월', start: { m: 66, d: 0 }, end: { m: 72, d: -1 }, focus: '취학 전 마지막 검진' },
];

// 영유아 구강검진 (총 4차)
export const DENTAL_CHECKUPS = [
  { round: 1, kind: 'dental', windowText: '생후 18~29개월', start: { m: 18, d: 0 }, end: { m: 30, d: -1 }, focus: '구강 문진·진찰, 구강보건교육' },
  { round: 2, kind: 'dental', windowText: '생후 30~41개월', start: { m: 30, d: 0 }, end: { m: 42, d: -1 }, focus: '구강 문진·진찰, 구강보건교육' },
  { round: 3, kind: 'dental', windowText: '생후 42~53개월', start: { m: 42, d: 0 }, end: { m: 54, d: -1 }, focus: '구강 문진·진찰, 구강보건교육' },
  { round: 4, kind: 'dental', windowText: '생후 54~65개월', start: { m: 54, d: 0 }, end: { m: 66, d: -1 }, focus: '구강 문진·진찰, 구강보건교육' },
];
