// ============================================================
// 이유식 데이터 — 단일 소스
// 기준: 보건소·대형병원 육아 정보, 소아청소년과 지침 (검증 워크플로로 교차확인)
// 데이터가 바뀌면 이 파일만 수정한다.
//
// stage: early(초기) / mid(중기) / late(후기) / complete(완료기)
// order: 해당 단계 안에서 새 재료 도입 권장 순서 (낮을수록 먼저)
// ============================================================

export const FOOD_META = {
  standard: '질병관리청·대한소아청소년과학회·식약처 이유식 지침',
  year: 2026,
};

export const STAGES = [
  {
    id: 'early', name: '초기', months: '만 4~6개월 시작 · 완모 아기는 6개월',
    mealsPerDay: 1, mealsText: '하루 1회 (모유·분유가 아직 주식)',
    texture: '10배죽 미음 (곱게 갈아 알갱이 없이)',
    amount: '한두 숟가락부터 1회 30~80g까지 서서히',
    base: '쌀미음',
  },
  {
    id: 'mid', name: '중기', months: '만 7~8개월',
    mealsPerDay: 2, mealsText: '하루 2회 + 간식 1회',
    texture: '7배죽 (혀로 으깰 수 있는 0.3cm 입자)',
    amount: '1회 70~100g',
    base: '쌀죽(7배죽)',
  },
  {
    id: 'late', name: '후기', months: '만 9~11개월',
    mealsPerDay: 3, mealsText: '하루 3회 + 간식 1회',
    texture: '5배죽~무른밥 (잇몸으로 으깨는 0.5cm 입자)',
    amount: '1회 100~150g',
    base: '무른밥',
  },
  {
    id: 'complete', name: '완료기', months: '만 12~15개월',
    mealsPerDay: 3, mealsText: '하루 3회 + 간식 2회',
    texture: '진밥 → 유아식 (0.7~1cm로 잘게 썰어서)',
    amount: '1회 120~180g',
    base: '진밥',
  },
];

const STAGE_ORDER = { early: 0, mid: 1, late: 2, complete: 3 };
export function stageAtLeast(food, stageId) {
  return STAGE_ORDER[food.stage] <= STAGE_ORDER[stageId];
}

// category: grain 곡류 / meat 육류 / fish 생선·해산물 / vegetable 채소 / fruit 과일 / dairy 유제품·계란 / legume 콩류 / etc
export const FOODS = [
  // ---------- 초기 ----------
  { id: 'zucchini',  name: '애호박',   category: 'vegetable', stage: 'early', order: 1 },
  { id: 'broccoli',  name: '브로콜리', category: 'vegetable', stage: 'early', order: 2, note: '꽃 부분만 사용' },
  { id: 'cabbage',   name: '양배추',   category: 'vegetable', stage: 'early', order: 3, note: '잎 부분만 사용' },
  { id: 'bokchoy',   name: '청경채',   category: 'vegetable', stage: 'early', order: 4, note: '잎 부분만 사용' },
  { id: 'beef',      name: '소고기',   category: 'meat', stage: 'early', order: 5, note: '안심·우둔 기름기 제거. 생후 6개월부터 철분 보충 위해 꼭 챙기기' },
  { id: 'pumpkin',   name: '단호박',   category: 'vegetable', stage: 'early', order: 6 },
  { id: 'potato',    name: '감자',     category: 'vegetable', stage: 'early', order: 7 },
  { id: 'sweetpotato', name: '고구마', category: 'vegetable', stage: 'early', order: 8 },
  { id: 'chicken',   name: '닭고기',   category: 'meat', stage: 'early', order: 9, note: '안심·가슴살, 기름기 제거' },
  { id: 'pear',      name: '배',       category: 'fruit', stage: 'early', order: 10, note: '익혀서 퓌레로' },
  { id: 'apple',     name: '사과',     category: 'fruit', stage: 'early', order: 11, note: '익혀서 퓌레로' },
  { id: 'oatmeal',   name: '오트밀',   category: 'grain', stage: 'early', order: 12 },

  // ---------- 중기 ----------
  { id: 'eggyolk',   name: '계란 노른자', category: 'dairy', stage: 'mid', order: 1, allergy: true, note: '생후 6개월부터 가능. 완전히 익혀 노른자부터 (반숙·날계란 금지)' },
  { id: 'tofu',      name: '두부',     category: 'legume', stage: 'mid', order: 2, allergy: true, note: '생후 6개월부터 가능. 대두 알레르기 주의' },
  { id: 'whitefish', name: '흰살생선(대구·동태)', category: 'fish', stage: 'mid', order: 3, allergy: true, note: '가시 완전히 제거, 완전히 익혀서' },
  { id: 'carrot',    name: '당근',     category: 'vegetable', stage: 'mid', order: 4, note: '질산염 채소 — 6개월 이후 권장' },
  { id: 'spinach',   name: '시금치',   category: 'vegetable', stage: 'mid', order: 5, note: '질산염 채소 — 6개월 이후, 데쳐서 사용' },
  { id: 'radish',    name: '무',       category: 'vegetable', stage: 'mid', order: 6, note: '질산염 채소 — 6개월 이후' },
  { id: 'beet',      name: '비트',     category: 'vegetable', stage: 'mid', order: 7, note: '질산염 채소 — 6개월 이후 소량' },
  { id: 'onion',     name: '양파',     category: 'vegetable', stage: 'mid', order: 8 },
  { id: 'mushroom',  name: '버섯(양송이·표고)', category: 'vegetable', stage: 'mid', order: 9, note: '갓 부분만 잘게' },
  { id: 'cucumber',  name: '오이',     category: 'vegetable', stage: 'mid', order: 10 },
  { id: 'banana',    name: '바나나',   category: 'fruit', stage: 'mid', order: 11 },
  { id: 'avocado',   name: '아보카도', category: 'fruit', stage: 'mid', order: 12 },
  { id: 'peas',      name: '완두콩',   category: 'legume', stage: 'mid', order: 13, note: '껍질 제거' },
  { id: 'wheat',     name: '밀(소면·빵)', category: 'grain', stage: 'mid', order: 14, allergy: true, note: '알레르기 확인 위해 소량씩 조기 도입 권장' },
  { id: 'peanutbutter', name: '땅콩버터(소량)', category: 'etc', stage: 'mid', order: 15, allergy: true, note: '생후 6개월 이후 가능(조기 도입이 알레르기 예방에 도움 — LEAP 연구). 무가당 크림형 소량을 죽에 섞어서. 통땅콩은 질식 위험 — 절대 금지' },
  { id: 'yogurt',    name: '요거트(무가당)', category: 'dairy', stage: 'mid', order: 16, allergy: true, note: '떠먹는 무가당. 마시는 생우유는 돌 이후' },
  { id: 'tomato',    name: '토마토',   category: 'vegetable', stage: 'mid', order: 17, note: '껍질·씨 제거, 익혀서' },
  { id: 'blueberry', name: '블루베리', category: 'fruit', stage: 'mid', order: 18, note: '으깨거나 잘라서' },

  // ---------- 후기 ----------
  { id: 'eggwhite',  name: '계란 흰자(완숙)', category: 'dairy', stage: 'late', order: 1, allergy: true, note: '노른자 적응 후. 완전히 익혀서' },
  { id: 'pork',      name: '돼지고기', category: 'meat', stage: 'late', order: 2, note: '기름기 적은 부위' },
  { id: 'salmon',    name: '연어',     category: 'fish', stage: 'late', order: 3, allergy: true, note: '완전히 익혀서, 가시 제거' },
  { id: 'shrimp',    name: '새우',     category: 'fish', stage: 'late', order: 4, allergy: true, note: '갑각류 알레르기 주의, 완전히 익혀서' },
  { id: 'cheese',    name: '아기치즈', category: 'dairy', stage: 'late', order: 5, allergy: true, note: '저나트륨 아기용' },
  { id: 'strawberry', name: '딸기',    category: 'fruit', stage: 'late', order: 6, note: '으깨거나 잘라서' },
  { id: 'seaweed',   name: '김(무조미)', category: 'etc', stage: 'late', order: 7, note: '소금·기름 없는 김' },
  { id: 'sesameoil', name: '참기름(소량)', category: 'etc', stage: 'late', order: 8, allergy: true, note: '참깨 알레르기 주의, 향 내기용 소량' },

  // ---------- 완료기 ----------
  { id: 'milk',      name: '우유(생우유)', category: 'dairy', stage: 'complete', order: 1, allergy: true, note: '마시는 우유는 돌(12개월) 이후' },
  { id: 'egg',       name: '계란 완전식', category: 'dairy', stage: 'complete', order: 2, allergy: true },
  { id: 'honey',     name: '꿀', category: 'etc', stage: 'complete', order: 3, note: '반드시 돌(12개월) 이후 — 영아 보툴리누스 위험' },
];

export const CATEGORY_LABEL = {
  grain: '곡류', meat: '육류', fish: '생선·해산물', vegetable: '채소',
  fruit: '과일', dairy: '계란·유제품', legume: '콩류', etc: '기타',
};

export const FORBIDDEN = [
  { name: '꿀', until: '돌(12개월) 전 절대 금지', reason: '영아 보툴리누스증 위험 — 소량도, 가열해도 안 됨 (질병관리청)' },
  { name: '생우유(마시기)', until: '돌 전 금지', reason: '장 자극·철분 흡수 방해로 빈혈 위험, 신장 부담 (요리에 익혀 소량은 가능)' },
  { name: '과일주스', until: '돌 전 금지', reason: '대한소아청소년과학회 권고 — 당 과다·식사 방해. 돌 이후에도 하루 120ml 이내' },
  { name: '소금·설탕 간하기', until: '돌 전까지 간하지 않기', reason: '신장 부담 + 평생 입맛이 짜게 굳어져요. 어른 국·반찬 그대로 주지 않기' },
  { name: '날음식(회·육회·반숙 계란)', until: '영아기 내내 금지', reason: '세균·기생충 감염 위험 — 고기·생선·계란은 반드시 완전히 익혀서' },
  { name: '통견과·통포도·떡·사탕·방울토마토 통째', until: '만 3세까지 주의', reason: '질식 위험 — 포도·방울토마토는 4등분, 견과는 가루나 버터 형태로만' },
  { name: '다랑어·새치류 등 심해 생선', until: '영유아기 주의', reason: '메틸수은 축적 — 식약처 기준 1~2세는 주 25g 이하(가급적 금지), 일반 생선·참치캔도 주 100g 이하' },
];

export const RULES = {
  threeDayRule: '새 재료는 한 번에 하나씩! 오전 첫 끼에 소량(1작은술)부터 시작하고, 최소 3일간(질병관리청 권고 3~7일) 발진·구토·설사 등 반응을 관찰해요. 이 기간에는 이미 통과한 재료만 함께 주고, 통과한 재료는 식단에서 빼지 말고 꾸준히 먹여요.',
  allergyNote: '알레르기 유발 식품(계란·밀·땅콩·생선·유제품 등)은 미룰수록 오히려 알레르기 위험이 높아져요 — 시기에 맞게 소량씩 도입하는 것이 최신 권고예요. 첫 시도는 오전에, 집에서. 아토피가 심하거나 가족력이 있으면 도입 전 소아과와 상담하세요.',
};
