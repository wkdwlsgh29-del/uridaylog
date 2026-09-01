// ============================================================
// '우리아기 오늘' 데이터 — 단일 소스
// 원더윅스 도약 일정 · 월령별 수면 기준 · 분유량 공식
// (검증 워크플로로 교차확인 후 확정)
// ============================================================

export const TODAY_META = {
  standard: '원더윅스(서적 기반) · 미국수면재단/소아과 통용 수면 기준',
  year: 2026,
};

// 원더윅스 도약 — 주차는 "출산예정일" 기준 (공식 사이트 기준)
// fussyStart~fussyEnd: 불안정기 신호가 나타나는 구간(주차), peak: 새 능력이 나타나는 정점 주차
export const WONDER_LEAPS = [
  { no: 1,  fussyStart: 4,  fussyEnd: 6,  peak: 5,  title: '감각의 세계', desc: '감각이 또렷해지고 첫 사회적 미소가 나타나요' },
  { no: 2,  fussyStart: 7,  fussyEnd: 10, peak: 8,  title: '패턴의 세계', desc: '반복되는 패턴을 알아보고 자기 손을 발견해요' },
  { no: 3,  fussyStart: 11, fussyEnd: 12, peak: 12, title: '부드러운 전환', desc: '매끄러운 움직임·소리 변화를 느끼고 옹알이와 웃음이 늘어요' },
  { no: 4,  fussyStart: 14, fussyEnd: 20, peak: 19, title: '사건의 세계', desc: '원인과 결과를 이해하고 손을 뻗어 잡기 시작해요' },
  { no: 5,  fussyStart: 22, fussyEnd: 26, peak: 26, title: '관계의 세계', desc: '거리·공간 관계를 이해해요 (분리불안이 시작될 수 있어요)' },
  { no: 6,  fussyStart: 33, fussyEnd: 38, peak: 37, title: '범주의 세계', desc: '사물의 공통점을 찾아 종류별로 분류하기 시작해요' },
  { no: 7,  fussyStart: 41, fussyEnd: 47, peak: 46, title: '순서의 세계', desc: '목표를 이루는 동작의 순서를 이해해요 (블록 쌓기)' },
  { no: 8,  fussyStart: 50, fussyEnd: 55, peak: 55, title: '프로그램의 세계', desc: '일과의 전체 흐름을 이해하고 스스로 참여하려 해요' },
  { no: 9,  fussyStart: 59, fussyEnd: 64, peak: 64, title: '원칙의 세계', desc: '규칙을 파악하고 경계를 시험해요 (떼쓰기 시작)' },
  { no: 10, fussyStart: 70, fussyEnd: 75, peak: 75, title: '시스템의 세계', desc: '더 큰 체계를 이해하고 자아 인식과 공감이 싹터요' },
];

export const WW_NOTE = '원더윅스는 서적 「The Wonder Weeks」 기반의 참고 프레임이지, 과학적으로 검증된 예측이 아니에요. 아기마다 발달 시기와 양상이 크게 다르니 "요즘 유난히 보채는 이유"를 이해하는 참고용으로만 봐주세요. 주차는 출생일이 아니라 출산예정일 기준이에요.';

// 월령별 수면 기준 (개월은 만 나이, 이른둥이는 교정 개월수 기준 권장)
// wwMin/wwMax: 권장 깨어있는 시간(잠텀, 분) / napMin: 낮잠 1회 통상 길이(분)
export const SLEEP_TABLE = [
  { fromM: 0,  toM: 2,  wwMin: 30,  wwMax: 90,  naps: '4~6회', napCount: 5, napMin: 60,  total: '14~17시간' },
  { fromM: 2,  toM: 4,  wwMin: 60,  wwMax: 105, naps: '4~5회', napCount: 4, napMin: 60,  total: '14~16시간' },
  { fromM: 4,  toM: 6,  wwMin: 90,  wwMax: 150, naps: '3~4회', napCount: 3, napMin: 60,  total: '12~15시간' },
  { fromM: 6,  toM: 7,  wwMin: 120, wwMax: 180, naps: '3회 (7~8개월경 2회로)', napCount: 3, napMin: 60,  total: '12~15시간' },
  { fromM: 7,  toM: 9,  wwMin: 150, wwMax: 210, naps: '2~3회', napCount: 2, napMin: 75,  total: '12~15시간' },
  { fromM: 9,  toM: 12, wwMin: 180, wwMax: 240, naps: '2회',   napCount: 2, napMin: 75,  total: '12~15시간' },
  { fromM: 12, toM: 15, wwMin: 195, wwMax: 240, naps: '1~2회', napCount: 2, napMin: 75,  total: '11~14시간' },
  { fromM: 15, toM: 18, wwMin: 240, wwMax: 330, naps: '1~2회 (1회 전환기)', napCount: 1, napMin: 120, total: '11~14시간' },
  { fromM: 18, toM: 24, wwMin: 300, wwMax: 360, naps: '1회',   napCount: 1, napMin: 120, total: '11~14시간' },
  { fromM: 24, toM: 36, wwMin: 360, wwMax: 420, naps: '0~1회 (점차 줄어요)', napCount: 1, napMin: 90, total: '11~14시간' },
];

// 분유 수유 참고 (완분 기준)
export const FEEDING = {
  perKgMin: 120,           // 하루 체중(kg)당 최소 ml
  perKgMax: 150,           // 하루 체중(kg)당 최대 ml
  dailyMax: 1000,          // 하루 상한 ml
  note: '하루 권장량은 체중 1kg당 120~150ml(많게는 180ml)이고, 최대 1,000ml(AAP 기준 약 960ml)를 넘지 않는 것이 일반적인 기준이에요. 이유식이 늘면 수유량은 자연히 줄어요. 체중이 성장곡선을 따라 잘 늘고 있다면 지금 양이 적정량이에요. 모유 수유는 아기가 원할 때 충분히!',
  feedsByMonth: [
    { fromM: 0, toM: 1, feeds: 8 },
    { fromM: 1, toM: 2, feeds: 7 },
    { fromM: 2, toM: 4, feeds: 6 },
    { fromM: 4, toM: 6, feeds: 5 },
    { fromM: 6, toM: 12, feeds: 4 },
  ],
};

// 이른둥이 교정 개월수: 37주 미만 출생아에게 적용, 통상 만 2세까지
export const CORRECTED_NOTE = '이른둥이(재태 37주 미만)는 성장·발달·수면 기준을 볼 때 출산예정일 기준의 "교정 개월수"를 써요(질병관리청 기준, 만 2세까지). 단, 예방접종·영유아검진 일정은 교정 없이 출생일 그대로 진행해요!';
