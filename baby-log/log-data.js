// ============================================================
// '함께 육아일지' 데이터 — 단일 소스
// 기록 종류 · 가족 역할 · 성장 단계(레벨) · 팀 미션 · 도감 · 대변 색 · 참고 기준 · 안내 문구
// 데이터·문구가 바뀌면 이 파일만 수정한다. (로직은 logic.js, 저장은 store.js)
//
// 설계 원칙 (RESEARCH.md A~D — 구속력 있는 결정)
//   · 게임 요소는 '협동'만: 사람별 횟수·순위·MVP·"누가 더"는 어디에도 없다. 기록자는 정보일 뿐 점수가 아니다.
//   · 레벨 = 아기의 성장 단계(생년월일로 자동). 기록을 많이 한다고 레벨이 오르지 않는다.
//   · 아기를 채점하지 않는다: 수유량·횟수 목표 미션 없음, 경고 색은 '부드러운 호박색'까지만 (빨강 없음).
//   · 참고 기준 수치는 출처 주석을 단다. ⚠ 아기 안전 관련 수치 — 수정 시 출처 원문 확인.
// ============================================================

import { FEEDING } from '../baby-today/today-data.js';

/** 데이터 기준 메타 (다른 도구의 *_META 와 같은 모양) */
export const LOG_META = {
  standard: 'AAP(HealthyChildren)·CDC·WHO·대한소아청소년과학회·질병관리청·아이사랑·대한소아치과학회',
  year: 2026,
};

// ---------- 가족 역할 ----------
// color: 타임라인 왼쪽 띠 색 (같은 역할이 둘이면 logic.memberColor 가 MEMBER_COLORS 에서 다른 색을 고른다)
/** 가족 역할 목록 [{id,label,emoji,color}] — 온보딩·참여 화면의 "나는" 칩 순서 */
export const ROLES = [
  { id: 'mom',     label: '엄마',     emoji: '👩',    color: '#E86A4E' },
  { id: 'dad',     label: '아빠',     emoji: '👨',    color: '#4A7FB5' },
  { id: 'sitter',  label: '시터',     emoji: '🧑‍🍼', color: '#5E9C82' },
  { id: 'grandma', label: '할머니',   emoji: '👵',    color: '#D9962B' },
  { id: 'grandpa', label: '할아버지', emoji: '👴',    color: '#8B6FB8' },
  { id: 'other',   label: '가족',     emoji: '🙂',    color: '#9A8575' },
];

/** 역할 id → 역할 객체 */
export const ROLE_BY_ID = Object.fromEntries(ROLES.map((r) => [r.id, r]));

/** 구성원 띠 색 팔레트 (같은 역할 구성원이 여럿일 때 순서대로 사용) */
export const MEMBER_COLORS = ['#E86A4E', '#4A7FB5', '#5E9C82', '#D9962B', '#8B6FB8', '#C2577E', '#3F9BA8', '#9A8575'];

/** 시터 이름 입력칸 placeholder — 시터는 자기 호칭을 직접 정한다 (RESEARCH A) */
export const NAME_PLACEHOLDER = { sitter: '예: 이모님, 김OO 선생님', default: '예: 하린맘, 큰아빠' };

/** 글자 수 제한 (서버 검증과 같은 값 — SPEC §4) */
export const LIMITS = {
  babyName: 10, memberName: 12, memberEmoji: 8,
  note: 100, noteText: 200, food: 30, medName: 20, medNote: 60,
  ml: [1, 500], min: [1, 120], tempC: [34.0, 42.5],
};

// ---------- 기록 종류 ----------
// group: 'feed'|'diaper'|'sleep'|'care'|'food'|'health'|'etc'
// input: 기록 방식 — tap(한 번 탭=지금 기록) / amount(ml 시트) / breast / toggle(수면) / food / temp / med / potty / note
// fromDay/toDay: 더보기·설정 목록에 보이는 생후 일수 구간 (없으면 항상). 그리드 기본값과는 별개.
// hidden: 퀵 그리드·더보기·통계에 나오지 않는 종류 (고마워요·바통·확인)
// ※ '수유'로 세는 종류는 FEED_TYPES (분유·모유·유축). 우유(milk)는 돌 이후 '식사'의 일부로 보고 수유에서 뺀다.
/** 기록 종류 정의 id → {label, emoji, group, input, unit?, hidden?, fromDay?, toDay?, defaultData?} */
export const EVENT_TYPES = {
  formula: { label: '분유',       emoji: '🍼', group: 'feed',   input: 'amount', unit: 'ml' },
  breast:  { label: '모유',       emoji: '🤱', group: 'feed',   input: 'breast' },
  pumped:  { label: '유축 수유',  emoji: '🫗', group: 'feed',   input: 'amount', unit: 'ml' },
  pee:     { label: '소변',       emoji: '💧', group: 'diaper', input: 'tap' },
  poop:    { label: '대변',       emoji: '💩', group: 'diaper', input: 'tap' },
  potty:   { label: '변기',       emoji: '🚽', group: 'diaper', input: 'potty', fromDay: 548 },   // 18개월~ (배변훈련 준비 신호 18~24개월)
  sleep:   { label: '잠',         emoji: '😴', group: 'sleep',  input: 'toggle',
             startLabel: '재우기', endLabel: '깼어요', endEmoji: '🌤' },
  burp:    { label: '트림',       emoji: '😮‍💨', group: 'care', input: 'tap' },
  tummy:   { label: '터미타임',   emoji: '🐢', group: 'care',   input: 'tap', unit: '분', toDay: 365, defaultData: { min: 5 } },
  bath:    { label: '목욕',       emoji: '🛁', group: 'care',   input: 'tap' },
  brush:   { label: '양치',       emoji: '🪥', group: 'care',   input: 'tap', fromDay: 180 },   // 첫 이가 나면 시작
  solid:   { label: '이유식',     emoji: '🥣', group: 'food',   input: 'food', fromDay: 120 },   // 만 4개월(120일)부터 버튼 열림
  meal:    { label: '식사',       emoji: '🍚', group: 'food',   input: 'food', fromDay: 270 },
  snack:   { label: '간식',       emoji: '🍪', group: 'food',   input: 'food', fromDay: 180 },
  water:   { label: '물',         emoji: '🥤', group: 'food',   input: 'tap', unit: 'ml', fromDay: 180 },  // 6개월 전엔 물 불필요
  milk:    { label: '우유',       emoji: '🥛', group: 'food',   input: 'amount', unit: 'ml', fromDay: 365 }, // 생우유는 돌 이후
  temp:    { label: '체온',       emoji: '🌡️', group: 'health', input: 'temp', unit: '℃' },
  med:     { label: '약',         emoji: '💊', group: 'health', input: 'med' },
  note:    { label: '메모',       emoji: '📝', group: 'etc',    input: 'note' },
  // ── 화면 그리드·통계에 나오지 않는 종류 ──
  thanks:  { label: '고마워요',   emoji: '💛', group: 'etc',    input: 'tap', hidden: true },   // data.target = 기록 id
  handoff: { label: '바통 넘기기', emoji: '📋', group: 'etc',   input: 'tap', hidden: true },   // data.from/to = 요약 범위(epoch ms)
  ack:     { label: '받았어요',   emoji: '✅', group: 'etc',    input: 'tap', hidden: true },   // data.target = handoff 기록 id
};

/** 수유로 세는 종류 (횟수·간격·다음 수유 예상·트림 체크 대상) — 우유는 제외 */
export const FEED_TYPES = ['formula', 'breast', 'pumped'];

/** ml 양을 받는 종류 (prefs.lastMl 키) */
export const AMOUNT_TYPES = ['formula', 'pumped', 'milk', 'water'];

/** 다른 기록에 붙는 '반응' 종류 — 타임라인 행으로 보이지 않고 대상 기록에 💛/✓ 로 표시 */
export const REACTION_TYPES = ['thanks', 'ack'];

/** 더보기·설정의 전체 버튼 순서 (기록 종류 id + 'both') */
export const QUICK_ACTIONS = [
  'formula', 'breast', 'pumped', 'pee', 'poop', 'both', 'potty',
  'sleep', 'burp', 'tummy', 'bath', 'brush',
  'solid', 'meal', 'snack', 'water', 'milk',
  'temp', 'med', 'note',
];

/** 기록 종류가 아닌 버튼 동작 — 'both' = 소변+대변을 같은 시각으로 두 건 기록 */
export const ACTION_META = {
  both: { label: '둘 다', emoji: '💧💩', input: 'tap', group: 'diaper', creates: ['pee', 'poop'] },
};

/** 서버 빠른 기록(?a=q)이 받는 종류 — 잠금화면 단축어·알림 버튼 후보 (SPEC §6.3) */
export const QUICK_URL_TYPES = ['pee', 'poop', 'both', 'formula', 'pumped', 'breast', 'burp', 'sleep', 'bath', 'tummy', 'brush', 'water'];

// ---------- 선택지 ----------
/** 모유 수유 방향 */
export const BREAST_SIDES = [
  { id: 'L', label: '왼쪽' },
  { id: 'R', label: '오른쪽' },
  { id: 'both', label: '양쪽' },
];
/** 트림 선택지 (분유·모유 시트의 분절 버튼; 값 없음 = '아직') */
export const BURP_OPTIONS = [
  { id: 'yes', label: '했어요', short: '트림 ✓', plain: '트림 O' },
  { id: 'no',  label: '안 했어요', short: '트림 안 함', plain: '트림 X' },
];
/** 이유식·식사 양 */
export const FOOD_AMOUNTS = [
  { id: 'little', label: '조금' },
  { id: 'half',   label: '반' },
  { id: 'all',    label: '다' },
  { id: 'more',   label: '더' },
];
/** 이유식·식사 반응 (allergy = 알레르기 의심 → 기록 권장) */
export const FOOD_REACTIONS = [
  { id: 'good',    label: '좋아함', emoji: '😋' },
  { id: 'meh',     label: '그냥',   emoji: '😐' },
  { id: 'refuse',  label: '거부',   emoji: '🙅' },
  { id: 'allergy', label: '알레르기 의심', emoji: '⚠️' },
];
/** 변기 결과 (성공 = 스티커·축하 효과) */
export const POTTY_RESULTS = [
  { id: 'pee',      label: '쉬 성공',   emoji: '🎉', success: true },
  { id: 'poop',     label: '응가 성공', emoji: '🎉', success: true },
  { id: 'try',      label: '시도만',    emoji: '🙂', success: false },
  { id: 'accident', label: '실수',      emoji: '💦', success: false },
];
/** 모유 수유 시간 칩(분) */
export const BREAST_MIN_CHIPS = [5, 10, 15, 20, 30];
/** 터미타임 시간 칩(분) — 한 번 탭 기본 5분 */
export const TUMMY_MIN_CHIPS = [3, 5, 10, 15];
/** "N분 전" 시각 칩 */
export const TIME_AGO_CHIPS = [5, 10, 15, 30];

// 단계별 분유·유축·우유 ml 칩 — 아이사랑·AAP 월령별 1회 수유량 표를 넉넉히 감싸는 범위
//   신생아 15~60 → 2주 60~80 → 1개월 80~120 / 1~2개월 120~140 / 2~4개월 140~180 / 4~6개월 160~200 / 6~12개월 180~240
/** 단계 id → ml 칩 목록 (water 키 = 물 칩) */
export const AMOUNT_CHIPS = {
  newborn: [20, 30, 40, 60, 80, 100, 120, 140],
  hundred: [60, 80, 100, 120, 140, 160, 180, 200],
  rolling: [100, 120, 140, 160, 180, 200, 220, 240],
  solids:  [120, 140, 160, 180, 200, 220, 240, 260],
  toddler: [100, 120, 150, 180, 200, 240],
  potty:   [100, 120, 150, 180, 200, 240],
  water:   [30, 50, 80, 100, 120, 150],
};
/** ml 스테퍼 한 칸 */
export const AMOUNT_STEP = 10;

// ---------- 대변 색 · 굳기 ----------
// 근거: SNUH 영유아녹변(초록 정상), 서울아산병원 담도폐쇄증(흰색·회색 = 빠른 진료, 생후 60일 전 수술 예후↑),
//       AAP·대한소아청소년과학회 소화기 응급(피·타르변 진료), 아이사랑(태변 2~3일)
// ⚠ 일본 모자수첩 대변 카드를 베끼지 않고 자체 칩으로 만든다. 화면마다 색이 달라 보일 수 있음을 함께 안내.
/** 대변 색 칩 [{id,label,hex,level:'ok'|'check'|'urgent',note}] — black 은 생후 3일까지 ok (logic.poopAlert) */
export const POOP_COLORS = [
  { id: 'yellow', label: '노랑',     hex: '#E4B53A', level: 'ok',     note: '노란색·겨자색은 건강한 변이에요' },
  { id: 'brown',  label: '갈색',     hex: '#8A5A2E', level: 'ok',     note: '갈색 변은 정상이에요' },
  { id: 'green',  label: '초록',     hex: '#6E8B3D', level: 'ok',     note: '초록색 변도 대부분 정상이에요. 잘 먹고 잘 놀면 괜찮아요' },
  { id: 'black',  label: '검정',     hex: '#2E2A26', level: 'check',  note: '까맣고 끈적한 태변은 생후 2~3일까지 정상이에요' },
  { id: 'red',    label: '빨강(피)', hex: '#B83A2E', level: 'check',  note: '빨간색(피)이나 까만 타르 같은 변은 진료를 받아 보세요' },
  { id: 'pale',   label: '흰색·회색', hex: '#E6E1D3', level: 'urgent', note: '회색·흰색처럼 아주 옅은 변은 꼭 확인이 필요한 색이에요' },
];
/** 대변 굳기 */
export const POOP_TEXTURES = [
  { id: 'watery', label: '묽음' },
  { id: 'soft',   label: '무름' },
  { id: 'normal', label: '보통' },
  { id: 'hard',   label: '단단함' },
];

// ---------- 참고 기준 (힌트·색·예상 시각 계산용) ----------
/** 참고 기준 수치 모음 — 출처는 각 항목 주석 */
export const NORMS = {
  // 월령별 수유 '보통 간격'(분): calm 이하 = 평온, calm~soon = 곧, soon 초과 = 부드러운 호박색(빨강 없음)
  // 근거: AAP·CDC·KPS·아이사랑 (RESEARCH C). 0~27일 2~3h / 28~59일 2.5~4h / 60~119일 3~4h / 120~179일 3.5~5h / 180~364일 4~5h / 돌 이후 색 없음
  feedGapByAge: [
    { fromDay: 0,   toDay: 28,  calm: 120, soon: 180 },
    { fromDay: 28,  toDay: 60,  calm: 150, soon: 240 },
    { fromDay: 60,  toDay: 120, calm: 180, soon: 240 },
    { fromDay: 120, toDay: 180, calm: 210, soon: 300 },
    { fromDay: 180, toDay: 365, calm: 240, soon: 300 },
  ],
  // 신생아(28일 미만): 4시간 넘게 안 먹으면 깨워서 먹이기 권장 (AAP "more than four hours", CDC, 대한소아청소년과학회)
  newbornWakeFeedMin: 240,
  // 생후 1개월 이후엔 밤(22~06시)에 '늦음' 색을 쓰지 않는다 (체중 회복 후엔 스스로 깰 때까지 괜찮음 — AAP)
  nightFrom: 22, nightTo: 6,
  // 같은 수유로 묶는 간격(분): 모유 양쪽·분유 보충처럼 30분 안에 이어진 기록은 한 번의 수유로 보고 간격을 잰다 (설계 결정)
  feedSessionMergeMin: 30,
  // 트림 확인 대기: 수유 후 90분이 지나면 '트림?' 버튼을 거둔다 (서버 빠른 기록의 트림 붙이기와 같은 창)
  burpWindowMin: 90,
  // 분유 하루 상한: AAP 32oz ≈ 960ml 초과 시 참고 힌트 (repo FEEDING.dailyMax 1,000ml 는 문구에 사용)
  formulaDailyHintMl: 960,
  formulaDailyMaxMl: FEEDING.dailyMax,
  feedsByMonth: FEEDING.feedsByMonth,   // 월령별 하루 수유 횟수 참고 (baby-today 단일 소스)
  // 소변 기저귀 최소 개수 — 생후 일째(1일째 = 첫 24시간): 1,2,3,4, 5일째부터 6개 이상 (CDC·AAP·NHS·KDCA; 3·4일째는 너그러운 값)
  wetMinByDayOfLife: [1, 2, 3, 4, 6],
  wetMinAfter6w: 5,           // 약 6주(42일) 이후 5~6개 (AAP, 아이사랑 "2개월 이후 소변 5~6")
  wetCheckUntilDay: 60,       // 소변 개수 힌트는 생후 2개월까지만
  // 소변 기저귀 힌트는 기록이 꾸준할 때만: 최근 24시간 기록 8개 이상 + 첫 기록이 24시간보다 오래됨 (RESEARCH C)
  activeLogMin24h: 8,
  noPeeHours: 8,              // 8시간 넘게 소변 없음 = 탈수 신호 (KPS, fever-data.js 와 같은 기준)
  noPeeMinOtherLogs: 3,       // …단, 마지막 소변 뒤로 다른 기록이 3개 이상일 때만 (기록을 잊은 것과 구분)
  meconiumOkDays: 3,          // 검은 태변은 생후 3일까지 정상 (아이사랑 "2~3일")
  feverC: 38.0,               // 발열 기준 (대한소아청소년과학회: 직장 38.0℃)
  feverUrgentUnderDays: 90,   // 생후 3개월 미만 38℃ 이상 = 바로 병원 (fever-data.js RED_FLAGS)
  fullNightSleepMin: 360,     // '첫 통잠' 도감: 한 번에 6시간 이상
  sleepOngoingMaxMin: 24 * 60, // 끝나지 않은 잠은 24시간까지만 '자는 중'으로 본다 (서버 수면 토글과 같은 창)
  tummyTargetMin: [15, 30],   // 생후 7주쯤 하루 합계 15~30분 (AAP 2022), WHO: 하루 30분 이상
  waterFromDay: 180, waterMl: [120, 240],   // 6개월 전 물 불필요, 6~12개월 하루 120~240ml (AAP 등 합의)
  milkFromDay: 365, milkMaxMl: 500,          // 생우유 돌 이후, 하루 500ml 이하 (질병관리청)
  solidFromDay: 120,          // 이유식 만 4~6개월 (완모 아기는 6개월) — 대한소아청소년과학회
  pottyReadyDay: 548,         // 배변훈련 준비 신호 18~24개월 (KPS·아이사랑·AAP)
};

// ---------- 안내 문구 ----------
// {n} {h} {m} {a} {b} 자리표시자는 logic.fill 로 채운다. 톤: '참고' 프레이밍, 짧고 따뜻하게, 겁주지 않기.
/** 힌트·안내 문구 모음 (logic.hints 등에서 사용) */
export const HINT_COPY = {
  feedGap: '마지막 수유 후 {elapsed} 지났어요. 이 시기 아기들은 보통 {a}~{b}시간마다 먹어요 (참고)',
  wakeFeed: '생후 초기에는 4시간 넘게 안 먹으면 깨워서 먹이는 걸 권해요 (대한소아청소년과학회·AAP 참고)',
  formulaMax: '오늘 분유가 {n}ml예요. 하루 1,000ml 안쪽이 일반적인 기준이라 참고해 주세요',
  formulaAmount: '분유 양은 평균일 뿐이에요. 잘 자라고 기저귀가 충분히 젖으면 지금 양이 딱 맞는 양이에요 😊',
  wetOk: '오늘 소변 기저귀 {n}개. 생후 5일부터는 하루 6개 이상이면 잘 먹고 있다는 신호예요 (참고)',
  wetLow: '기록을 깜빡했을 수도 있지만, 최근 24시간 소변이 {n}번이에요. 이 시기엔 보통 {min}번 이상이라 수유량을 한번 살펴보고, 계속 적으면 소아청소년과에 문의해 보세요',
  noPee: '소변을 본 지 8시간이 넘었어요. 입술이 마르거나 처지면 진료를 받아 보세요',
  poopPale: '회색·흰색처럼 아주 옅은 변은 꼭 확인이 필요한 색이에요. 사진을 찍어 두고 가능한 빨리 소아청소년과 진료를 받아 보세요 (생후 2개월 이내 확인이 중요해요)',
  poopRed: '빨간색(피)이나 까만 타르 같은 변은 진료를 받아 보세요',
  poopMeconium: '까맣고 끈적한 태변은 생후 2~3일까지 정상이에요',
  poopGreen: '초록색 변도 대부분 정상이에요. 잘 먹고 잘 놀면 괜찮아요',
  poopScreen: '화면에 따라 색이 달라 보일 수 있어요',
  poopPhoto: '1차 영유아검진 때 대변 사진을 보여주면 좋아요',
  feverInfant: '생후 3개월 미만 38℃ 이상은 해열제보다 먼저 바로 병원(응급실)에 가야 해요',
  fever: '38℃ 이상이에요. 아이 상태를 잘 살펴 주세요 — 해열제 용량은 계산기에서 확인할 수 있어요',
  burp: '분유 60~90ml마다, 모유는 반대쪽으로 바꿀 때 트림을 시켜 보세요 (참고)',
  burpLater: '요즘은 트림 없이도 편안한 아기가 많아요. 필요할 때만 기록해도 돼요',
  tummy: '터미타임(엎드려 놀기)은 깨어 있을 때, 어른이 지켜보면서! 하루 몇 번 몇 분씩 시작해서 생후 7주쯤엔 하루 합계 15~30분이 목표예요 (AAP 참고)',
  solidStart: '이유식은 만 4~6개월에 시작해요. 모유만 먹는 아기는 6개월 시작을 권해요 (대한소아청소년과학회)',
  waterEarly: '6개월 전에는 물 없이 모유·분유만으로 충분해요',
  water: '6개월부터는 이유식과 함께 컵으로 조금씩, 하루 120~240ml 정도가 참고량이에요',
  milkEarly: '생우유는 돌 이후부터! 돌 전에는 모유·분유를 주세요',
  milkMuch: '오늘 우유가 {n}ml예요. 생우유는 하루 500ml 안팎이 적당하고, 너무 많이 마시면 철분이 부족해질 수 있어요',
  brush: '첫 이가 났어요! 이제 칫솔질 시작 — 불소치약(1,000ppm 이상)은 쌀알만큼만, 만 3세부터는 콩알만큼 (대한소아치과학회)',
  pottyReady: '18~24개월쯤 준비 신호가 보일 수 있어요: 2시간쯤 기저귀가 뽀송하거나, 쉬·응가를 알려주거나. 서두르지 않아도 괜찮아요',
};

/** 안전한 잠 한 줄 (수면 시트·단계 시트) — AAP 2022, 질병관리청 영아돌연사증후군 */
export const SAFE_SLEEP = '아기는 항상 등을 대고 똑바로, 단단하고 평평한 아기 잠자리에서! 베개·이불·인형은 치워 주세요';

/** 전역 푸터 면책 문구 */
export const DISCLAIMER = '참고용 일반 기준이에요. 아기마다 달라요 — 걱정되면 소아청소년과에 물어보세요.';

/** 저장 방식 안내 (푸터·설정) */
export const STORAGE_NOTE = '기록은 이 기기(브라우저)에 저장돼요. 브라우저 데이터를 지우면 사라질 수 있으니 가족 공유를 켜거나 JSON 백업을 해 두세요. 가족 공유를 켜면 초대받은 가족만 볼 수 있는 공간에 함께 저장돼요.';

// ---------- 성장 단계 (= 레벨) ----------
// 생후 일수(태어난 날 = 0일)로 자동 결정. toDay 는 미포함 경계.
// grid: 퀵 그리드 기본 버튼 (마지막 칸 '⋯ 더보기'는 UI가 붙임). 가족이 설정에서 바꾸면 prefs.grid[stage.id] 가 우선.
// unlocks/retires: 이전 단계 grid 와 비교해 자동 계산 (아래) — 레벨업 모달 "새로 열린 기록 / 더보기로 옮긴 버튼"
// feedGap: 이 단계 대표 수유 간격(분). 실제 계산은 생후 일수를 알면 NORMS.feedGapByAge 로 더 정밀하게.
// burp: 수유 시트에 트림 선택 + 수유 카드의 '트림?' 버튼 (약 4개월부터 줄이고 6개월부터 더보기로 — RESEARCH C)
// nightQuiet: 밤(22~06시)엔 '늦음' 색을 쓰지 않음 (생후 1개월 이후)
// quests: 오늘의 팀 미션 — 가족 합계, 돌봄 긍정 행동만, 먹는 양·횟수 목표 없음 (RESEARCH A)
//   filter: poopColor(색을 고른 대변) · burpChecked(트림 답한 수유 + 트림 기록) · nightFeed · pottySuccess · tummy · reaction(반응을 적은 식사)
const RAW_STAGES = [
  {
    lv: 1, id: 'newborn', name: '신생아', emoji: '👶', title: '먹고 자고 싸는 게 전부인 시기',
    fromDay: 0, toDay: 28,
    grid: ['formula', 'breast', 'pee', 'poop', 'both', 'burp', 'sleep', 'pumped', 'note'],
    feedGap: { calm: 120, soon: 180 }, burp: true, nightQuiet: false,
    intro: '팀 결성! 수유·기저귀·트림을 한 화면에서 같이 챙겨요',
    quests: [
      { id: 'nb-poop-color', emoji: '💩', label: '대변 색 한 번 확인하기', types: ['poop'], count: 1, filter: 'poopColor' },
      { id: 'nb-burp',       emoji: '😮‍💨', label: '트림 체크 3번', types: ['formula', 'breast', 'pumped', 'burp'], count: 3, filter: 'burpChecked' },
      { id: 'nb-thanks',     emoji: '💛', label: '서로 고마워요 1번', types: ['thanks'], count: 1 },
      { id: 'nb-handoff',    emoji: '📋', label: '교대 요약 1번 보내기', types: ['handoff'], count: 1 },
    ],
    tips: [
      HINT_COPY.burp,
      HINT_COPY.wakeFeed,
      '대변 색은 생후 2개월까지 특히 중요해요 — 흰색·회색이면 바로 진료! ' + HINT_COPY.poopScreen,
      SAFE_SLEEP,
    ],
  },
  {
    lv: 2, id: 'hundred', name: '100일의 기적', emoji: '🍼', title: '밤잠이 조금씩 길어지는 시기',
    fromDay: 28, toDay: 100,
    grid: ['formula', 'breast', 'pee', 'poop', 'both', 'sleep', 'burp', 'tummy', 'bath'],
    feedGap: { calm: 150, soon: 240 }, burp: true, nightQuiet: true,
    intro: '터미타임·목욕 버튼이 생겼어요',
    quests: [
      { id: 'hd-tummy',      emoji: '🐢', label: '터미타임 3번', types: ['tummy'], count: 3, filter: 'tummy' },
      { id: 'hd-poop-color', emoji: '💩', label: '대변 색 확인 1번', types: ['poop'], count: 1, filter: 'poopColor' },
      { id: 'hd-thanks',     emoji: '💛', label: '서로 고마워요 1번', types: ['thanks'], count: 1 },
      { id: 'hd-care',       emoji: '🛁', label: '목욕이나 교대 요약 1번', types: ['bath', 'handoff'], count: 1 },
    ],
    tips: [HINT_COPY.tummy, '생후 1개월이 지나면 밤에는 깨워서 먹이지 않아도 괜찮아요 (체중이 잘 늘 때 — AAP 참고)', SAFE_SLEEP],
  },
  {
    lv: 3, id: 'rolling', name: '뒤집기', emoji: '🐣', title: '뒤집고 옹알이하는 시기',
    fromDay: 100, toDay: 180,
    grid: ['formula', 'breast', 'pee', 'poop', 'sleep', 'tummy', 'bath', 'solid', 'burp'],
    feedGap: { calm: 210, soon: 300 }, burp: false, nightQuiet: true,
    intro: '트림 버튼은 맨 뒤로! 생후 120일부터 이유식 버튼이 열려요',
    quests: [
      { id: 'rl-tummy',  emoji: '🐢', label: '터미타임 3번', types: ['tummy'], count: 3, filter: 'tummy' },
      { id: 'rl-care',   emoji: '🛁', label: '목욕이나 교대 요약 1번', types: ['bath', 'handoff'], count: 1 },
      { id: 'rl-thanks', emoji: '💛', label: '서로 고마워요 1번', types: ['thanks'], count: 1 },
    ],
    tips: [HINT_COPY.burpLater, HINT_COPY.solidStart, SAFE_SLEEP],
  },
  {
    lv: 4, id: 'solids', name: '이유식', emoji: '🥣', title: '처음 맛보는 세상의 맛',
    fromDay: 180, toDay: 365,
    grid: ['solid', 'formula', 'breast', 'pee', 'poop', 'sleep', 'water', 'temp', 'med'],
    feedGap: { calm: 240, soon: 300 }, burp: false, nightQuiet: true,
    intro: "이유식 스테이지 시작! '트림' 대신 '이유식'이 맨 앞에 왔어요",
    quests: [
      { id: 'sd-reaction', emoji: '🥣', label: '이유식 반응 기록 1번', types: ['solid'], count: 1, filter: 'reaction' },
      { id: 'sd-water',    emoji: '🥤', label: '물 조금씩 마셔보기', types: ['water'], count: 1 },
      { id: 'sd-thanks',   emoji: '💛', label: '서로 고마워요 1번', types: ['thanks'], count: 1 },
      { id: 'sd-handoff',  emoji: '📋', label: '교대 요약 1번 보내기', types: ['handoff'], count: 1 },
    ],
    tips: [HINT_COPY.water, '새 재료는 하나씩, 반응을 기록해 두면 알레르기를 찾기 쉬워요', HINT_COPY.brush],
  },
  {
    lv: 5, id: 'toddler', name: '걸음마', emoji: '🚶', title: '한 걸음씩 세상 탐험',
    fromDay: 365, toDay: 730,
    grid: ['meal', 'milk', 'snack', 'pee', 'poop', 'sleep', 'brush', 'med', 'temp'],
    feedGap: null, burp: false, nightQuiet: true,
    intro: '첫 돌 축하해요! 식사·우유·간식·양치 버튼이 생겼어요',
    quests: [
      { id: 'td-brush',   emoji: '🪥', label: '양치 2번', types: ['brush'], count: 2 },
      { id: 'td-thanks',  emoji: '💛', label: '서로 고마워요 1번', types: ['thanks'], count: 1 },
      { id: 'td-handoff', emoji: '📋', label: '교대 요약 1번 보내기', types: ['handoff'], count: 1 },
    ],
    tips: ['생우유는 하루 500ml 안팎이 적당해요 (질병관리청)', HINT_COPY.brush, HINT_COPY.pottyReady],
  },
  {
    lv: 6, id: 'potty', name: '배변훈련', emoji: '🧒', title: '기저귀와 작별 준비',
    fromDay: 730, toDay: Infinity,
    grid: ['potty', 'meal', 'snack', 'sleep', 'brush', 'pee', 'poop', 'milk', 'note'],
    feedGap: null, burp: false, nightQuiet: true,
    intro: '변기 버튼이 맨 앞에! 성공하면 스티커가 붙어요 🎉',
    quests: [
      { id: 'pt-potty',  emoji: '🚽', label: '변기 앉아보기 2번', types: ['potty'], count: 2 },
      { id: 'pt-brush',  emoji: '🪥', label: '양치 2번', types: ['brush'], count: 2 },
      { id: 'pt-thanks', emoji: '💛', label: '서로 고마워요 1번', types: ['thanks'], count: 1 },
    ],
    tips: [HINT_COPY.pottyReady, '실수해도 괜찮아요 — 혼내지 않고 성공만 크게 칭찬해 주세요', '낮 기저귀는 보통 만 2.5~3세에 떼요. 30개월이 지나도 준비가 안 됐다면 그것도 정상이에요 (AAP)'],
  },
];

/** 성장 단계(레벨) 목록 — {lv,id,name,emoji,title,fromDay,toDay,grid,unlocks,retires,feedGap,burp,nightQuiet,intro,quests,tips} */
export const STAGES = RAW_STAGES.map((s, i) => {
  const prev = i > 0 ? RAW_STAGES[i - 1].grid : [];
  return Object.freeze({
    ...s,
    unlocks: s.grid.filter((t) => !prev.includes(t)),
    retires: prev.filter((t) => !s.grid.includes(t)),
  });
});

/** 단계 id → 단계 객체 */
export const STAGE_BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s]));

// ---------- 도감 (배지) ----------
// 아기의 '처음'과 팀 이정표만 — 집안일 개수가 아니다 (RESEARCH A). 획득 여부는 기록에서 매번 계산(logic.earnedBadges),
// '새 카드' 표시는 prefs.seenBadges 로 판단. kind: baby(아기의 처음) / team(우리 팀)
/** 도감 카드 [{id, emoji, name, desc, kind}] */
export const BADGES = [
  { id: 'first-log',     emoji: '📝', name: '첫 기록',         desc: '우리 가족 육아일지의 첫 페이지',                     kind: 'team' },
  { id: 'team',          emoji: '🤝', name: '팀 결성',         desc: '두 사람 이상이 함께 기록해요',                       kind: 'team' },
  { id: 'support',       emoji: '🦸', name: '든든한 지원군',   desc: '시터·할머니·할아버지가 팀에 합류했어요',             kind: 'team' },
  { id: 'first-thanks',  emoji: '💛', name: '첫 고마워요',     desc: '서로에게 처음으로 고마움을 전했어요',                 kind: 'team' },
  { id: 'first-baton',   emoji: '📋', name: '첫 바통',         desc: '교대 요약으로 첫 인수인계를 했어요',                   kind: 'team' },
  { id: 'lockscreen',    emoji: '🔒', name: '잠금화면 첫 기록', desc: '잠금화면·알림·음성으로 처음 기록했어요',              kind: 'team' },
  { id: 'streak-7',      emoji: '🔥', name: '함께 7일',        desc: '7일 연속 함께 기록했어요',                            kind: 'team' },
  { id: 'streak-30',     emoji: '🌟', name: '함께 30일',       desc: '30일 연속 함께 기록했어요',                           kind: 'team' },
  { id: 'streak-100',    emoji: '🏆', name: '함께 100일',      desc: '100일 연속 함께 기록했어요',                          kind: 'team' },
  { id: 'logs-100',      emoji: '📚', name: '기록 100개',      desc: '우리 가족이 함께 남긴 기록 100개',                    kind: 'team' },
  { id: 'logs-1000',     emoji: '🏅', name: '기록 1,000개',    desc: '우리 가족이 함께 남긴 기록 1,000개',                  kind: 'team' },
  { id: 'first-night',   emoji: '🌙', name: '첫 통잠',         desc: '한 번에 6시간 넘게 푹 잤어요',                        kind: 'baby' },
  { id: 'day-100',       emoji: '💯', name: '백일',            desc: '태어난 지 100일째 — 축하해요!',                       kind: 'baby' },
  { id: 'first-solid',   emoji: '🥣', name: '첫 이유식',       desc: '처음으로 이유식을 맛봤어요',                          kind: 'baby' },
  { id: 'first-brush',   emoji: '🪥', name: '첫 양치',         desc: '첫 칫솔질을 시작했어요',                              kind: 'baby' },
  { id: 'birthday-1',    emoji: '🎂', name: '첫 돌',           desc: '첫 번째 생일을 축하해요!',                             kind: 'baby' },
  { id: 'potty-first',   emoji: '🎉', name: '첫 변기 성공',    desc: '처음으로 변기에서 성공했어요',                        kind: 'baby' },
  { id: 'birthday-2',    emoji: '🎈', name: '두 돌',           desc: '두 번째 생일을 축하해요!',                             kind: 'baby' },
];
