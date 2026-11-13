// ============================================================
// 산후조리원 비교 데이터 — 단일 소스
// ⚠ 개별 조리원 가격은 싣지 않는다 (시기·객실·프로모션마다 달라 금방 틀려짐).
//    사용자가 상담받은 견적을 직접 넣어 비교하는 구조.
// 전국 평균: 보건복지부 「산후조리원 현황」(반기별 공개) 2025년 하반기(2025-12-31 기준) 언론 보도 수치.
//    새 반기 자료가 나오면 BENCHMARK 만 수정한다.
// ============================================================

export const BENCHMARK = {
  source: '보건복지부 산후조리원 현황',
  asOf: '2025년 12월 말 기준',
  weeks: 2,
  // 2주 이용요금 전국 평균 (만원)
  avg: { general: 372, special: 543 },
};

export const ROOM_TYPES = [
  { id: 'general', label: '일반실' },
  { id: 'special', label: '특실' },
];

// 지원금 빠른 선택 (만원). 첫만남이용권: 첫째 200만원, 둘째 이상 300만원 — 산후조리원 결제에 사용 가능.
export const SUPPORT_PRESETS = [
  { amount: 0, label: '없음' },
  { amount: 200, label: '첫만남 첫째 200' },
  { amount: 300, label: '첫만남 둘째+ 300' },
];

// 조리원마다 체크해서 나란히 비교할 항목
export const FEATURES = [
  { id: 'massage', label: '마사지 포함', emoji: '💆' },
  { id: 'rooming', label: '모자동실 가능', emoji: '🤱' },
  { id: 'pedi', label: '소아과 회진', emoji: '🩺' },
  { id: 'cam', label: '신생아 캠', emoji: '📹' },
  { id: 'partner', label: '배우자 숙박', emoji: '🛏️' },
  { id: 'meal', label: '배우자 식사 포함', emoji: '🍚' },
  { id: 'parking', label: '주차 무료', emoji: '🚗' },
  { id: 'hospital', label: '병원 연계', emoji: '🏥' },
];

// 상담 때 꼭 물어볼 것 — 가격표에 안 보이는 비용 위주
export const ASK_LIST = [
  '<b>최종 결제 금액</b> — 안내받은 가격이 부가세·신생아 관리비까지 포함인지',
  '<b>마사지</b> — 기본 포함 횟수, 추가 패키지 가격, 현장 권유가 있는지',
  '<b>조기 입실·연장</b> — 예정일보다 빨리/늦게 낳았을 때 1박 추가 요금과 객실 보장 여부',
  '<b>환불 규정</b> — 입실 전 취소 시점별 계약금 환불 비율, 중도 퇴실 시 정산 방식',
  '<b>배우자</b> — 숙박·식사가 포함인지, 식사 1끼 추가 요금은 얼마인지',
  '<b>결제 수단</b> — 첫만남이용권(국민행복카드)·지자체 산후조리비 바우처 결제가 되는지',
  '<b>신생아실</b> — 간호 인력 1명당 아기 수, 야간 인력, 감염 발생 시 대응·보상',
  '<b>다태아·제왕절개</b> — 쌍둥이 추가 요금, 수술 산모 입실일 계산 방식',
];

// "예시로 넣어보기" — 실제 조리원이 아닌 가상의 견적
export const SAMPLES = [
  { name: '예시 A조리원', region: '집에서 10분', room: 'general', days: 14, base: 350, massage: 60, other: 0, discount: 10, features: ['rooming', 'pedi', 'cam', 'parking'], memo: '마사지 3회 패키지 별도' },
  { name: '예시 B조리원', region: '병원 옆', room: 'general', days: 14, base: 420, massage: 0, other: 15, discount: 0, features: ['massage', 'pedi', 'cam', 'partner', 'hospital'], memo: '마사지 5회 포함, 배우자 식사 별도' },
  { name: '예시 C조리원', region: '친정 근처', room: 'special', days: 14, base: 520, massage: 0, other: 0, discount: 30, features: ['massage', 'rooming', 'pedi', 'cam', 'partner', 'meal', 'parking'], memo: '조기예약 할인' },
];
