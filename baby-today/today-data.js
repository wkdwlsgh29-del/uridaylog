// ============================================================
// '우리아기 오늘' 데이터 — 단일 소스
// 원더윅스 도약 일정 · 월령별 수면 기준 · 분유량 공식
// (검증 워크플로로 교차확인 후 확정)
// ============================================================

export const TODAY_META = {
  standard: '원더윅스(서적 기반) · 미국수면재단/소아과 통용 수면 기준',
  year: 2026,
};

// 원더윅스 도약 — 주차는 "출산예정일" 기준 (책 공식 기준)
// fussyStart/fussyEnd: 불안정기(보챔) 구간 주차, peak: 정점 주차
export const WONDER_LEAPS = [
  { no: 1,  fussyStart: 4.5,  fussyEnd: 5.5,  peak: 5,  title: '감각의 변화', desc: '주변 자극을 훨씬 강하게 느끼기 시작해요' },
  { no: 2,  fussyStart: 7.5,  fussyEnd: 9.5,  peak: 8,  title: '패턴', desc: '단순한 패턴을 인식하기 시작해요 (손 발견!)' },
  { no: 3,  fussyStart: 11.5, fussyEnd: 12.5, peak: 12, title: '부드러운 변화', desc: '움직임·소리의 흐름을 느껴요 (옹알이 발전)' },
  { no: 4,  fussyStart: 14.5, fussyEnd: 19.5, peak: 17, title: '사건', desc: '연속된 동작을 하나의 사건으로 이해해요 (장난감 잡기)' },
  { no: 5,  fussyStart: 22.5, fussyEnd: 26.5, peak: 26, title: '관계', desc: '거리·위치 관계를 이해해요 (분리불안 시작)' },
  { no: 6,  fussyStart: 33.5, fussyEnd: 37.5, peak: 36, title: '범주', desc: '사물을 종류별로 구분해요 (강아지는 다 강아지!)' },
  { no: 7,  fussyStart: 41.5, fussyEnd: 46.5, peak: 44, title: '순서', desc: '순서대로 하는 일을 이해해요 (블록 쌓기)' },
  { no: 8,  fussyStart: 50.5, fussyEnd: 54.5, peak: 52, title: '프로그램', desc: '일상의 절차를 이해해요 (밥 먹기 과정, 청소 흉내)' },
  { no: 9,  fussyStart: 59.5, fussyEnd: 64.5, peak: 62, title: '원칙', desc: '규칙과 원칙을 배워요 (내 것/네 것, 떼쓰기 시작)' },
  { no: 10, fussyStart: 70.5, fussyEnd: 76.5, peak: 73, title: '시스템', desc: '더 큰 체계를 이해해요 (가족, 나만의 의지)' },
];

export const WW_NOTE = '원더윅스는 네덜란드 연구자 부부의 서적 「The Wonder Weeks」 기반 참고 프레임이에요. 아기마다 시기가 다를 수 있으니 "요즘 유난히 보채는 이유"를 이해하는 참고용으로 봐주세요. 주차는 출생일이 아니라 출산예정일 기준으로 계산해요.';

// 월령별 수면 기준 (개월은 만 나이, 이른둥이는 교정 개월수 기준 권장)
// wwMin/wwMax: 권장 깨어있는 시간(잠텀, 분) / napMin: 낮잠 1회 통상 길이(분)
export const SLEEP_TABLE = [
  { fromM: 0,  toM: 1,  wwMin: 45,  wwMax: 60,  naps: '4~6회', napCount: 5, napMin: 45,  total: '14~17시간' },
  { fromM: 1,  toM: 3,  wwMin: 60,  wwMax: 90,  naps: '4~5회', napCount: 4, napMin: 60,  total: '14~17시간' },
  { fromM: 3,  toM: 5,  wwMin: 75,  wwMax: 120, naps: '3~4회', napCount: 3, napMin: 60,  total: '12~16시간' },
  { fromM: 5,  toM: 7,  wwMin: 120, wwMax: 150, naps: '3회',   napCount: 3, napMin: 75,  total: '12~15시간' },
  { fromM: 7,  toM: 9,  wwMin: 150, wwMax: 180, naps: '2~3회', napCount: 2, napMin: 75,  total: '12~15시간' },
  { fromM: 9,  toM: 13, wwMin: 180, wwMax: 210, naps: '2회',   napCount: 2, napMin: 75,  total: '12~15시간' },
  { fromM: 13, toM: 18, wwMin: 210, wwMax: 300, naps: '1~2회', napCount: 1, napMin: 120, total: '11~14시간' },
  { fromM: 18, toM: 36, wwMin: 300, wwMax: 360, naps: '1회',   napCount: 1, napMin: 120, total: '11~14시간' },
];

// 분유 수유 참고 (완분 기준)
export const FEEDING = {
  perKgMin: 120,           // 하루 체중(kg)당 최소 ml
  perKgMax: 150,           // 하루 체중(kg)당 최대 ml
  dailyMax: 1000,          // 하루 상한 ml
  note: '하루 권장량은 체중 1kg당 120~150ml, 최대 1,000ml를 넘지 않는 것이 일반적인 기준이에요. 이유식이 늘면 수유량은 자연히 줄어요. 모유 수유는 아기가 원할 때 충분히!',
  feedsByMonth: [
    { fromM: 0, toM: 1, feeds: 8 },
    { fromM: 1, toM: 2, feeds: 7 },
    { fromM: 2, toM: 4, feeds: 6 },
    { fromM: 4, toM: 6, feeds: 5 },
    { fromM: 6, toM: 12, feeds: 4 },
  ],
};

// 이른둥이 교정 개월수: 37주 미만 출생아에게 적용, 통상 만 2세까지
export const CORRECTED_NOTE = '이른둥이(재태 37주 미만)는 발달·수면 기준을 볼 때 출산예정일 기준의 "교정 개월수"를 써요. 보통 만 2세까지 교정 나이로 봐요.';
