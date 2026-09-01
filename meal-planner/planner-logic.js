// 식단표 생성 로직 — 순수 모듈 (DOM 의존 없음)
// 원칙: 새 재료는 하나씩, 3일 연속 유지(3일 룰). 결정적(같은 입력 → 같은 식단표).
import { addDays } from '../shared/js/date-utils.js';
import { FOODS, STAGES, stageAtLeast } from './food-data.js';

const PROTEIN_CATS = new Set(['meat', 'fish', 'legume', 'dairy']);

// 단계별 곁들임(이미 먹어본 재료) 수
const SIDE_COUNT = { early: 1, mid: 2, late: 3, complete: 3 };

export function getStage(stageId) {
  return STAGES.find((s) => s.id === stageId);
}

export function buildPlan({ startDate, stageId, eatenIds, avoidIds, days = 28 }) {
  const eaten = new Set(eatenIds);
  const avoid = new Set(avoidIds);
  const stage = getStage(stageId);

  const pool = FOODS.filter((f) => stageAtLeast(f, stageId) && !avoid.has(f.id));
  const stageRank = { early: 0, mid: 1, late: 2, complete: 3 };

  // 새로 도입할 재료: 이른 단계 재료부터, 단계 내 권장 순서대로
  const queue = pool
    .filter((f) => !eaten.has(f.id))
    .sort((a, b) => (stageRank[a.stage] - stageRank[b.stage]) || (a.order - b.order));

  // 로테이션 풀 (이미 먹어본 재료들) — 단백질/채소/기타로 분리
  const known = pool.filter((f) => eaten.has(f.id));
  const rot = {
    protein: known.filter((f) => PROTEIN_CATS.has(f.category)),
    veg: known.filter((f) => f.category === 'vegetable'),
    other: known.filter((f) => !PROTEIN_CATS.has(f.category) && f.category !== 'vegetable'),
  };
  const idx = { protein: 0, veg: 0, other: 0 };

  function pickSide(group, excludeId) {
    const list = rot[group];
    if (!list.length) return null;
    for (let t = 0; t < list.length; t++) {
      const f = list[idx[group] % list.length];
      idx[group] += 1;
      if (f.id !== excludeId) return f;
    }
    return null;
  }

  // 완전 처음 시작(초기 + 먹어본 재료 없음)이면 첫 3일은 쌀미음 단독 적응
  const riceAdaptDays = (stageId === 'early' && known.length === 0) ? 3 : 0;

  const planDays = [];
  for (let i = 0; i < days; i++) {
    if (i < riceAdaptDays) {
      planDays.push({
        idx: i, date: addDays(startDate, i),
        newFood: null, introDay: 0, sides: [], adapt: true,
        caution: '',
      });
      continue;
    }
    const j = i - riceAdaptDays;
    const block = Math.floor(j / 3);
    const newFood = queue[block] || null;
    const introDay = newFood ? (j % 3) + 1 : 0;

    // 3일 블록이 끝난 재료는 로테이션 풀에 편입
    if (j > 0 && j % 3 === 0 && queue[block - 1]) {
      const done = queue[block - 1];
      const g = PROTEIN_CATS.has(done.category) ? 'protein' : done.category === 'vegetable' ? 'veg' : 'other';
      rot[g].push(done);
    }

    // 곁들임 구성: 단백질 1 + 채소 위주로 채움 (새 재료와 중복 제외)
    const sides = [];
    const maxSides = SIDE_COUNT[stageId];
    const excludeId = newFood ? newFood.id : null;
    const protein = pickSide('protein', excludeId);
    if (protein && !(newFood && PROTEIN_CATS.has(newFood.category))) sides.push(protein);
    while (sides.length < maxSides) {
      const veg = pickSide('veg', excludeId);
      if (!veg || sides.some((s) => s.id === veg.id)) break;
      sides.push(veg);
    }

    planDays.push({
      idx: i,
      date: addDays(startDate, i),
      newFood,
      introDay,
      sides,
      caution: newFood && newFood.allergy && introDay === 1
        ? '알레르기 유발 식품 — 오전 첫 끼에 소량으로 시작하고 반응을 지켜보세요'
        : '',
    });
  }

  // 주차별 장보기 리스트
  const weeks = [];
  for (let w = 0; w < Math.ceil(days / 7); w++) {
    const slice = planDays.slice(w * 7, w * 7 + 7);
    const names = new Set();
    const newNames = new Set();
    for (const d of slice) {
      if (d.newFood) { names.add(d.newFood.name); newNames.add(d.newFood.name); }
      d.sides.forEach((s) => names.add(s.name));
    }
    weeks.push({ no: w + 1, newFoods: [...newNames], shopping: [...names] });
  }

  const blocks = Math.ceil((days - riceAdaptDays) / 3);
  const newCount = Math.min(blocks, queue.length);
  return { stage, days: planDays, weeks, newCount, queueExhausted: queue.length <= blocks };
}
