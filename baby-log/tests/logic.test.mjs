// '함께 육아일지' 순수 로직 테스트 — node --test baby-log/tests/
// 시간대는 Asia/Seoul 로 고정 (서머타임 테스트만 잠깐 America/New_York).
process.env.TZ = 'Asia/Seoul';

import test from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../log-data.js';
import * as L from '../logic.js';
import { FEEDING } from '../../baby-today/today-data.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const at = (h = 0, m = 0, d = 28, mo = 9, y = 2026) => new Date(y, mo - 1, d, h, m).getTime();
const iso = (ts) => L.dayKey(ts);
// now 기준 생후 n일 생일
const birthFor = (n, now) => { const d = new Date(now); return iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime()); };
let seq = 0;
const ev = (type, ts, data = {}, by = 'm1', extra = {}) => ({ id: `e${String(++seq).padStart(4, '0')}`, type, ts, by, data, deleted: false, updatedAt: ts, rev: 0, ...extra });
const stage = (id) => D.STAGE_BY_ID[id];

// ---------- 데이터 일관성 ----------
test('log-data: 단계 경계가 이어지고 grid·퀘스트가 올바른 종류를 가리킨다', () => {
  assert.equal(D.STAGES.length, 6);
  assert.equal(D.STAGES[0].fromDay, 0);
  for (let i = 0; i < D.STAGES.length - 1; i++) assert.equal(D.STAGES[i].toDay, D.STAGES[i + 1].fromDay, D.STAGES[i].id);
  assert.equal(D.STAGES.at(-1).toDay, Infinity);
  const filters = new Set([undefined, 'poopColor', 'burpChecked', 'nightFeed', 'pottySuccess', 'tummy', 'reaction']);
  for (const s of D.STAGES) {
    assert.deepEqual(s.lv, D.STAGES.indexOf(s) + 1);
    for (const id of s.grid) assert.ok(D.QUICK_ACTIONS.includes(id), `${s.id} grid ${id}`);
    assert.ok(s.quests.length >= 3 && s.quests.length <= 4, `${s.id} quests`);
    for (const q of s.quests) {
      for (const t of q.types) assert.ok(D.EVENT_TYPES[t], `${q.id} ${t}`);
      assert.ok(filters.has(q.filter), q.filter);
      assert.ok(q.count >= 1);
    }
    assert.ok(s.tips.length >= 1);
    if (s.feedGap) assert.ok(s.feedGap.calm < s.feedGap.soon);
  }
  const ids = D.STAGES.flatMap((s) => s.quests.map((q) => q.id));
  assert.equal(new Set(ids).size, ids.length, '퀘스트 id 중복');
  for (const id of D.QUICK_ACTIONS) assert.ok(D.EVENT_TYPES[id] || D.ACTION_META[id], id);
  for (const t of D.FEED_TYPES) assert.equal(D.EVENT_TYPES[t].group, 'feed');
  assert.equal(D.EVENT_TYPES.milk.group, 'food', '우유는 수유가 아니다');
});

test('log-data: unlocks/retires 는 이전 단계 grid 와 비교해 계산된다 (RESEARCH: 트림은 6개월부터 더보기)', () => {
  assert.deepEqual(stage('newborn').unlocks, stage('newborn').grid);
  assert.deepEqual(stage('newborn').retires, []);
  assert.deepEqual(stage('hundred').unlocks, ['tummy', 'bath']);
  assert.deepEqual(stage('hundred').retires, ['pumped', 'note']);
  assert.deepEqual(stage('rolling').unlocks, ['solid']);
  assert.ok(stage('rolling').grid.at(-1) === 'burp', '뒤집기 단계는 트림을 맨 뒤에 유지');
  assert.ok(stage('solids').retires.includes('burp'));
  assert.deepEqual(stage('potty').unlocks, ['potty', 'note']);
});

test('log-data: 도감·대변색·기준값', () => {
  assert.ok(D.BADGES.length >= 14 && D.BADGES.length <= 18);
  assert.equal(new Set(D.BADGES.map((b) => b.id)).size, D.BADGES.length);
  for (const b of D.BADGES) assert.ok(b.emoji && b.name && b.desc && ['baby', 'team'].includes(b.kind), b.id);
  const lv = new Set(['ok', 'check', 'urgent']);
  for (const c of D.POOP_COLORS) assert.ok(lv.has(c.level) && /^#[0-9A-F]{6}$/i.test(c.hex), c.id);
  assert.equal(D.POOP_COLORS.find((c) => c.id === 'pale').level, 'urgent');
  assert.equal(D.POOP_COLORS.find((c) => c.id === 'green').level, 'ok');
  assert.equal(D.NORMS.formulaDailyMaxMl, FEEDING.dailyMax, 'FEEDING 은 baby-today 에서 가져온다');
  assert.equal(D.NORMS.feedsByMonth, FEEDING.feedsByMonth);
  assert.equal(D.ROLES.length, 6);
  assert.equal(D.ROLE_BY_ID.sitter.emoji, '🧑‍🍼');
  assert.ok(D.LOG_META.standard && D.LOG_META.year === 2026);
  // 신생아 수유 간격: 2~3시간, 돌 이후 색 없음
  assert.deepEqual(stage('newborn').feedGap, { calm: 120, soon: 180 });
  assert.equal(stage('toddler').feedGap, null);
});

// ---------- 나이 · 단계 ----------
test('ageDays: 로컬 달력 기준, 잘못된 값 null, 미래 0', () => {
  const now = at(0, 30, 28);
  assert.equal(L.ageDays('2026-09-28', now), 0);
  assert.equal(L.ageDays('2026-09-27', at(0, 1, 28)), 1, '자정 넘자마자 하루');
  assert.equal(L.ageDays('2026-09-27', at(23, 59, 27)), 0);
  assert.equal(L.ageDays('2025-09-28', now), 365);
  assert.equal(L.ageDays('2026-10-02', now), 0);
  assert.equal(L.ageDays('2026-02-30', now), null);
  assert.equal(L.ageDays('', now), null);
  assert.equal(L.ageDays(undefined, now), null);
  assert.equal(L.ageDays('28/09/2026', now), null);
});

test('stageFor: 단계 경계 (0·27·28·99·100·179·180·364·365·729·730)', () => {
  const now = at(15, 0, 28);
  const cases = [[0, 'newborn'], [27, 'newborn'], [28, 'hundred'], [99, 'hundred'], [100, 'rolling'], [179, 'rolling'],
    [180, 'solids'], [364, 'solids'], [365, 'toddler'], [729, 'toddler'], [730, 'potty'], [4000, 'potty']];
  for (const [n, id] of cases) {
    const r = L.stageFor(birthFor(n, now), now);
    assert.equal(r.stage.id, id, `생후 ${n}일`);
    assert.equal(r.ageDays, n);
    assert.equal(r.daysIn, n - r.stage.fromDay);
    if (r.next) assert.equal(r.daysToNext, r.next.fromDay - n);
    else assert.equal(r.daysToNext, null);
  }
  const r23 = L.stageFor(birthFor(23, now), now);
  assert.equal(r23.daysToNext, 5);
  assert.equal(r23.next.id, 'hundred');
  assert.ok(r23.progress > 0.8 && r23.progress < 0.83);
  const bad = L.stageFor('nope', now);
  assert.equal(bad.stage.id, 'newborn');
  assert.equal(bad.ageDays, null);
});

test('startOfDay / dayKey / addDaysTs 는 로컬 날짜', () => {
  assert.equal(L.startOfDay(at(23, 59, 28)), at(0, 0, 28));
  assert.equal(L.dayKey(at(0, 0, 1, 1)), '2026-01-01');
  assert.equal(L.dayKey(at(23, 59, 31, 12, 2025)), '2025-12-31');
  assert.equal(L.addDaysTs(at(13, 0, 30), 1), at(0, 0, 1, 10));
  assert.equal(L.isNight(at(22, 0)), true);
  assert.equal(L.isNight(at(5, 59)), true);
  assert.equal(L.isNight(at(6, 0)), false);
});

test('서머타임이 있는 시간대에서도 하루 경계가 맞다 (America/New_York 2026-03-08)', () => {
  process.env.TZ = 'America/New_York';
  try {
    const dstDay = new Date(2026, 2, 8, 12, 0).getTime();
    const s = L.startOfDay(dstDay);
    const next = L.addDaysTs(dstDay, 1);
    assert.equal(new Date(s).getHours(), 0);
    assert.equal(new Date(next).getDate(), 9);
    assert.equal(next - s, 23 * HOUR, '서머타임 시작일은 23시간');
    // 22시~다음날 06시 잠: 3/8 에 2시간(22~24), 3/9 에 6시간
    const sl = [ev('sleep', new Date(2026, 2, 8, 22).getTime(), { end: new Date(2026, 2, 9, 6).getTime() })];
    assert.equal(L.statsBetween(sl, s, next).sleepMin, 120);
    // 전날 22시 ~ 3/8 06시: 시계가 한 시간 건너뛰어 실제 7시간 중 3/8 몫은 5시간
    const sl2 = [ev('sleep', new Date(2026, 2, 7, 22).getTime(), { end: new Date(2026, 2, 8, 6).getTime() })];
    assert.equal(L.statsBetween(sl2, s, next).sleepMin, 300);
    // 연속 기록: 3/7, 3/8, 3/9
    const days = [7, 8, 9].map((d) => ev('pee', new Date(2026, 2, d, 1, 30).getTime()));
    assert.equal(L.streakDays(days, new Date(2026, 2, 9, 12).getTime()), 3);
    assert.equal(L.ageDays('2026-03-01', new Date(2026, 2, 9, 0, 30).getTime()), 8);
  } finally {
    process.env.TZ = 'Asia/Seoul';
  }
});

// ---------- 통계 ----------
test('statsBetween: 수유 = 분유+모유+유축(우유 제외), 소변·대변에 변기 성공 포함, 지운 기록·고마워요 제외', () => {
  const evs = [
    ev('formula', at(1), { ml: 120 }), ev('formula', at(4), { ml: 100 }), ev('breast', at(7), { side: 'L', min: 10 }),
    ev('pumped', at(9), { ml: 80 }), ev('milk', at(10), { ml: 200 }), ev('pee', at(2)), ev('pee', at(3)),
    ev('poop', at(3)), ev('potty', at(11), { result: 'pee' }), ev('potty', at(12), { result: 'try' }),
    ev('formula', at(5), { ml: 999 }, 'm1', { deleted: true }), ev('thanks', at(6), { target: 'e0001' }),
    ev('formula', at(23, 59, 27), { ml: 50 }),
  ];
  const s = L.statsBetween(evs, at(0), at(0, 0, 29));
  assert.equal(s.feeds, 4);
  assert.equal(s.formulaMl, 220);
  assert.equal(s.pumpedMl, 80);
  assert.equal(s.bottleMl, 300);
  assert.equal(s.milkMl, 200);
  assert.equal(s.breast, 1);
  assert.equal(s.breastMin, 10);
  assert.equal(s.pee, 3);
  assert.equal(s.poop, 1);
  assert.equal(s.byType.formula, 2);
  assert.equal(s.byType.thanks, undefined);
  assert.equal(s.last.formula.ts, at(4));
});

test('statsBetween: 자정을 넘는 잠은 겹친 만큼만, 끝나지 않은 잠은 min(to, now) 까지, 24시간 상한', () => {
  const evs = [ev('sleep', at(22, 0, 27), { end: at(6, 0, 28) }), ev('sleep', at(13, 0), { end: at(14, 30) })];
  const today = L.statsBetween(evs, at(0), at(0, 0, 29));
  assert.equal(today.sleepMin, 360 + 90);
  assert.equal(today.sleeps, 2);
  assert.equal(L.statsBetween(evs, at(0, 0, 27), at(0, 0, 28)).sleepMin, 120);
  // 진행 중인 잠: 23시 시작, 다음날 01:30 에 '오늘' 통계
  const on = [ev('sleep', at(23, 0, 27))];
  assert.equal(L.statsBetween(on, at(0), at(0, 0, 29), at(1, 30)).sleepMin, 90, 'now 까지만');
  assert.equal(L.statsBetween(on, at(0), at(1, 30)).sleepMin, 90, 'to=now');
  assert.equal(L.statsBetween(on, at(0, 0, 27), at(0, 0, 28), at(1, 30)).sleepMin, 60, '어제 몫');
  // 이틀 전 시작해 안 끝난 잠은 24시간까지만
  const stale = [ev('sleep', at(8, 0, 26))];
  assert.equal(L.statsBetween(stale, at(0, 0, 26), at(0, 0, 29), at(12)).sleepMin, 24 * 60);
  // 끝이 시작보다 앞선 잘못된 잠은 0
  assert.equal(L.statsBetween([ev('sleep', at(10), { end: at(9) })], at(0), at(0, 0, 29)).sleepMin, 0);
});

// ---------- 수유 ----------
test('feedState: 단계 간격에 따른 calm/soon/over, 기록 없으면 null', () => {
  const nb = stage('newborn');
  const empty = L.feedState([], at(12), nb);
  assert.equal(empty.last, null);
  assert.equal(empty.level, null);
  assert.equal(empty.elapsedMin, null);
  const f = [ev('formula', at(10), { ml: 60, burp: 'yes' })];
  assert.equal(L.feedState(f, at(11, 40), nb).level, 'calm');   // 100분
  assert.equal(L.feedState(f, at(12, 0), nb).level, 'calm');    // 120분 = calm 경계 포함
  assert.equal(L.feedState(f, at(12, 30), nb).level, 'soon');   // 150분
  assert.equal(L.feedState(f, at(13, 0), nb).level, 'soon');    // 180분
  assert.equal(L.feedState(f, at(13, 20), nb).level, 'over');   // 200분
  assert.equal(L.feedState(f, at(13, 20), nb).elapsedMin, 200);
  assert.equal(L.feedState(f, at(13, 20), stage('toddler')).level, null, '돌 이후 색 없음');
  // 우유는 수유가 아니다
  assert.equal(L.feedState([ev('milk', at(10), { ml: 200 })], at(11), stage('toddler')).last, null);
});

test('feedState: 생후 1개월 이후 밤엔 늦음 색 없음, 신생아는 밤에도 표시 + 4시간 깨워 먹이기 안내', () => {
  const f = [ev('formula', at(21, 0, 27), { ml: 120 })];
  const night = at(2, 0);   // 5시간 뒤
  const hd = L.feedState(f, night, stage('hundred'), 50);
  assert.equal(hd.night, true);
  assert.equal(hd.level, 'calm');
  assert.equal(hd.wakeHint, false);
  const nb = L.feedState(f, night, stage('newborn'), 10);
  assert.equal(nb.level, 'over');
  assert.equal(nb.wakeHint, true);
  assert.equal(L.feedState(f, at(0, 30), stage('newborn'), 10).wakeHint, false, '3.5시간은 아직');
  assert.equal(L.feedState(f, at(20, 0), stage('newborn'), 10).wakeHint, false, '12시간 넘은 기록은 안내 안 함(기록 중단)');
  // 낮에는 1개월 이후에도 over
  const day = [ev('formula', at(8, 0), { ml: 120 })];
  assert.equal(L.feedState(day, at(13, 0), stage('hundred'), 50).level, 'over');
});

test('feedState: 생후 일수를 넘기면 NORMS.feedGapByAge (70일 = 3~4시간)', () => {
  const f = [ev('formula', at(10), { ml: 120 })];
  const s = L.feedState(f, at(12, 50), stage('hundred'), 70);   // 170분
  assert.deepEqual(s.gap, { calm: 180, soon: 240 });
  assert.equal(s.level, 'calm');
  assert.equal(L.feedState(f, at(12, 50), stage('hundred')).level, 'soon', '단계 기본값(150/240)이면 soon');
  assert.equal(L.feedGapFor(stage('toddler'), 400), null);
  assert.equal(L.feedGapFor(stage('solids'), 400), null, '돌 이후면 단계와 상관없이 null');
});

test('다른 기기 시계가 1~2분 빨라도 방금 기록이 보인다 (수유·기저귀·잠)', () => {
  const now = at(10, 0);
  const f = [ev('formula', now + 90 * 1000, { ml: 90 })];
  const s = L.feedState(f, now, stage('newborn'));
  assert.ok(s.last, '90초 미래 수유도 마지막 수유');
  assert.equal(s.elapsedMin, 0);
  assert.equal(L.feedState([ev('formula', now + 10 * MIN, { ml: 90 })], now, stage('newborn')).last, null, '10분 미래는 무시');
  assert.equal(L.diaperState([ev('pee', now + MIN)], now).lastPee.ts, now + MIN);
  assert.ok(L.sleepState([ev('sleep', now + MIN)], now).ongoing);
});

test('feedState.burpPending: 트림 단계 + 트림 모름 + 90분 이내 + 뒤에 트림 기록 없음', () => {
  const nb = stage('newborn');
  const f = [ev('formula', at(10), { ml: 60 })];
  assert.equal(L.feedState(f, at(10, 20), nb).burpPending, true);
  assert.equal(L.feedState(f, at(11, 31), nb).burpPending, false, '90분 지나면 거둠');
  assert.equal(L.feedState([...f, ev('burp', at(10, 10))], at(10, 20), nb).burpPending, false, '트림 따로 기록');
  assert.equal(L.feedState([ev('formula', at(10), { ml: 60, burp: 'no' })], at(10, 20), nb).burpPending, false, '안 함도 답');
  assert.equal(L.feedState(f, at(10, 20), stage('rolling')).burpPending, false, '4개월부터 트림 재촉 안 함');
  assert.equal(L.feedState([ev('breast', at(10), { side: 'L' })], at(10, 5), stage('hundred')).burpPending, true);
});

test('nextFeedEstimate: 최근 간격 평균을 보통 간격으로 자르고, 30분 안 보충 수유는 한 번으로', () => {
  const nb = stage('newborn');
  // 간격 60분씩 → calm(120)으로 올림
  const fast = [ev('formula', at(8)), ev('formula', at(9)), ev('formula', at(10))];
  assert.equal(L.nextFeedEstimate(fast, at(10, 30), nb), at(12));
  // 간격 300분 → soon(180)으로 내림
  const slow = [ev('formula', at(1)), ev('formula', at(6))];
  assert.equal(L.nextFeedEstimate(slow, at(7), nb), at(9));
  // 간격 150 → 그대로
  const mid = [ev('formula', at(6)), ev('formula', at(8, 30)), ev('formula', at(11))];
  assert.equal(L.nextFeedEstimate(mid, at(11, 10), nb), at(13, 30));
  // 모유 10:00 + 분유 보충 10:25 → 한 번의 수유(10:00 시작)
  const topUp = [ev('formula', at(7, 30)), ev('breast', at(10), { side: 'L' }), ev('formula', at(10, 25), { ml: 40 })];
  assert.equal(L.nextFeedEstimate(topUp, at(10, 30), nb), at(12, 30));
  // 간격 기록 없음 → 보통 간격 가운데(150)
  assert.equal(L.nextFeedEstimate([ev('formula', at(10))], at(10, 5), nb), at(12, 30));
  // 없음 / 24시간 넘음 / 돌 이후
  assert.equal(L.nextFeedEstimate([], at(10), nb), null);
  assert.equal(L.nextFeedEstimate([ev('formula', at(9, 0, 27))], at(10), nb), null);
  assert.equal(L.nextFeedEstimate(mid, at(11, 10), stage('toddler')), null);
  // 최근 6개 간격만: 오래된 긴 간격은 무시
  const many = [0, 3, 6, 7, 8, 9, 10, 11, 12].map((h) => ev('formula', at(h)));
  assert.equal(L.nextFeedEstimate(many, at(12, 10), nb), at(14), '최근 간격 60분 → 120 으로 clamp');
});

test('lastMl · amountChips', () => {
  const evs = [ev('formula', at(8), { ml: 100 }), ev('formula', at(10), { ml: 130 }), ev('pumped', at(11), { ml: 70 })];
  assert.equal(L.lastMl(evs, 'formula'), 130);
  assert.equal(L.lastMl(evs, 'milk'), null);
  const chips = L.amountChips(stage('hundred'), 'formula', 130);
  assert.ok(chips.includes(130) && chips.includes(120));
  assert.deepEqual(chips, [...chips].sort((a, b) => a - b));
  assert.deepEqual(L.amountChips(stage('solids'), 'water'), D.AMOUNT_CHIPS.water);
});

// ---------- 기저귀 · 잠 ----------
test('diaperState: 마지막 소변/대변, 오늘 개수 (로컬 날짜)', () => {
  const evs = [ev('pee', at(23, 0, 27)), ev('pee', at(1)), ev('poop', at(2), { color: 'yellow' }), ev('pee', at(9, 15)), ev('potty', at(9, 20), { result: 'poop' })];
  const s = L.diaperState(evs, at(10));
  assert.equal(s.todayPee, 2);
  assert.equal(s.todayPoop, 2);
  assert.equal(s.lastPee.ts, at(9, 15));
  assert.equal(s.peeMin, 45);
  assert.equal(s.lastPoop.type, 'potty');
});

test('sleepState: 자는 중(가장 먼저 시작한 것) · 깨어 있는 시간 · 24시간 넘은 잠은 stale', () => {
  const evs = [ev('sleep', at(9), { end: at(10, 30) }), ev('sleep', at(13, 0)), ev('sleep', at(13, 5))];
  const s = L.sleepState(evs, at(14, 12));
  assert.equal(s.ongoing.ts, at(13, 0));
  assert.equal(s.ongoingAll.length, 2);
  assert.equal(s.elapsedMin, 72);
  assert.equal(L.fmtDur(s.elapsedMin), '1:12');
  assert.equal(s.last.data.end, at(10, 30));
  const awake = L.sleepState([ev('sleep', at(9), { end: at(10, 30) })], at(11));
  assert.equal(awake.ongoing, null);
  assert.equal(awake.elapsedMin, 30);
  const old = L.sleepState([ev('sleep', at(9, 0, 26))], at(11));
  assert.equal(old.ongoing, null);
  assert.equal(old.stale.length, 1);
  assert.equal(L.sleepState([], at(11)).elapsedMin, null);
});

// ---------- 미션 · 연속 · 도감 ----------
test('quests: 신생아 팀 미션 — 오늘 기록만, 필터 적용, 목표에서 멈춤', () => {
  const nb = stage('newborn');
  const now = at(18);
  const none = L.quests(nb, [], now);
  assert.equal(none.length, 4);
  assert.ok(none.every((q) => q.count === 0 && !q.done));
  const evs = [
    ev('poop', at(8)),                                   // 색 없음 → 안 셈
    ev('poop', at(9), { color: 'yellow' }),
    ev('formula', at(10), { ml: 60, burp: 'yes' }),
    ev('breast', at(12), { side: 'L', burp: 'no' }),
    ev('formula', at(14), { ml: 60 }),                   // 트림 모름 → 안 셈
    ev('burp', at(14, 10)),
    ev('burp', at(15)),                                  // 4번째 → 3에서 멈춤
    ev('thanks', at(11), { target: 'x' }, 'm2'),
    ev('handoff', at(17), { from: at(9), to: at(17) }),
    ev('poop', at(9, 0, 27), { color: 'green' }),       // 어제
    ev('handoff', at(16), {}, 'm1', { deleted: true }),
  ];
  const q = Object.fromEntries(L.quests(nb, evs, now).map((x) => [x.id, x]));
  assert.deepEqual(q['nb-poop-color'], { id: 'nb-poop-color', label: '대변 색 한 번 확인하기', emoji: '💩', count: 1, target: 1, done: true });
  assert.equal(q['nb-burp'].count, 3);
  assert.equal(q['nb-burp'].done, true);
  assert.equal(q['nb-thanks'].done, true);
  assert.equal(q['nb-handoff'].done, true);
  const y = L.quests(nb, evs, at(23, 0, 27));
  assert.equal(y.find((x) => x.id === 'nb-poop-color').done, true, '어제의 미션');
  assert.equal(y.find((x) => x.id === 'nb-burp').count, 0);
  // 뒤집기: 목욕 또는 교대 요약
  const rl = L.quests(stage('rolling'), [ev('bath', at(19))], at(20));
  assert.equal(rl.find((x) => x.id === 'rl-care').done, true);
  // 이유식 반응 필터
  const sd = L.quests(stage('solids'), [ev('solid', at(12), { food: '쌀미음' }), ev('solid', at(13), { reaction: 'good' })], at(20));
  assert.equal(sd.find((x) => x.id === 'sd-reaction').count, 1);
});

test('streakDays / longestStreak: 오늘 또는 어제부터 연속된 날', () => {
  const on = (d, h = 12) => ev('pee', at(h, 0, d));
  const now = at(9, 0, 28);
  assert.equal(L.streakDays([], now), 0);
  assert.equal(L.streakDays([on(28), on(27), on(26)], now), 3);
  assert.equal(L.streakDays([on(27), on(26)], now), 2, '오늘 아직 없으면 어제부터');
  assert.equal(L.streakDays([on(26), on(25)], now), 0, '어제도 없으면 0');
  assert.equal(L.streakDays([on(28), on(26), on(25)], now), 1);
  assert.equal(L.streakDays([on(28, 0), on(27, 23)], at(0, 5, 28)), 2, '자정 경계');
  assert.equal(L.streakDays([on(28), ev('pee', at(12, 0, 27), {}, 'm1', { deleted: true })], now), 1, '지운 기록은 안 셈');
  assert.equal(L.streakDays([on(28), ev('thanks', at(12, 0, 27), { target: 'x' })], now), 1, '고마워요만 있는 날은 안 셈');
  const month = Array.from({ length: 10 }, (_, i) => on(1 + i));
  assert.equal(L.longestStreak([...month, on(20), on(21)]), 10);
});

test('earnedBadges: 기록에서 계산 — 첫 기록·통잠·백일·팀·지원군·고마워요·바통·연속·잠금화면', () => {
  const now = at(12, 0, 28);
  const members = [{ id: 'm1', role: 'mom' }, { id: 's1', role: 'sitter' }];
  const events = [
    ev('pee', at(8)),
    ev('sleep', at(21, 0, 27), { end: at(3, 30, 28) }),     // 6시간 30분
    ev('thanks', at(9), { target: 'e1' }, 's1'),
    ev('handoff', at(10), { from: at(1), to: at(10) }),
    ev('pee', at(10, 5), { src: 'shortcut' }),
  ];
  const got = L.earnedBadges({ events, members, family: { birth: birthFor(99, now) }, now, prefs: {} });
  for (const id of ['first-log', 'first-night', 'day-100', 'team', 'support', 'first-thanks', 'first-baton', 'lockscreen']) assert.ok(got.has(id), id);
  for (const id of ['streak-7', 'logs-100', 'first-solid', 'birthday-1', 'potty-first']) assert.ok(!got.has(id), id);
  const young = L.earnedBadges({ events: [], members: [{ id: 'm1', role: 'mom' }, { id: 'd1', role: 'dad', revoked: true }], family: { birth: birthFor(98, now) }, now });
  assert.ok(!young.has('day-100'), '생후 98일은 아직 백일 전');
  assert.ok(!young.has('team'), '내보낸 구성원은 팀에 안 셈');
  assert.equal(young.size, 0);
  // 7일 연속은 끊겨도 도감 유지 / 100개 / 돌
  const week = Array.from({ length: 100 }, (_, i) => ev('pee', at(8, i % 60, 1 + (i % 7))));
  const later = L.earnedBadges({ events: week, members: [], family: { birth: '2025-09-28' }, now });
  assert.ok(later.has('streak-7') && later.has('logs-100') && later.has('birthday-1') && !later.has('birthday-2'));
  assert.ok(!L.earnedBadges({ events: [], family: { birth: '2025-09-29' }, now }).has('birthday-1'), '돌 하루 전');
  assert.deepEqual(L.newBadges(got, { seenBadges: ['first-log'] }).includes('first-log'), false);
});

// ---------- 팀 카드 ----------
test('team: 가족 합계와 고마움만 — 사람별 횟수 없음', () => {
  const members = [{ id: 'm1', name: '엄마', role: 'mom' }, { id: 'd1', name: '아빠', role: 'dad' }];
  const e1 = ev('formula', at(3, 10), { ml: 120 }, 'd1');
  const events = [
    e1, ev('pee', at(9), {}, 'm1'), ev('pee', at(23), {}, 'm1'),
    ev('thanks', at(8), { target: e1.id }, 'm1'),
    ev('thanks', at(8, 0, 25), { target: 'zzz' }, 'd1'),
  ];
  const t = L.team(events, members, at(0), at(0, 0, 29), 'd1');
  assert.deepEqual(Object.keys(t).sort(), ['lastThanksToMe', 'night', 'thanks', 'total', 'weekThanks']);
  assert.equal(t.total, 3);
  assert.equal(t.night, 2);
  assert.equal(t.thanks, 1);
  assert.equal(t.weekThanks, 2);
  assert.equal(t.lastThanksToMe.text, '💛 엄마가 새벽 3:10 수유에 고마워했어요');
  assert.equal(L.team(events, members, at(0), at(0, 0, 29), 'm1').lastThanksToMe, null);
  assert.deepEqual(L.thanksFor(events, e1.id), ['m1']);
  assert.deepEqual(L.thanksFor(events, 'none'), []);
  const h = ev('handoff', at(18), { from: at(9), to: at(18) }, 's1');
  assert.deepEqual(L.acksFor([h, ev('ack', at(18, 5), { target: h.id }, 'm1'), ev('ack', at(18, 6), { target: h.id }, 'm1')], h.id), ['m1']);
  assert.ok(!L.live([h, ev('ack', at(18, 5), { target: h.id })]).some((e) => e.type === 'ack'), 'ack 는 타임라인 행이 아님');
});

test('live(): 같은 배열이면 캐시(얼린 배열) · 고치기·지우기·추가·다른 탭 합치기(객체 교체)는 바로 반영', () => {
  const a = ev('pee', at(10)), b = ev('poop', at(9)), c = ev('formula', at(11), { ml: 100 });
  const events = [a, b, c];
  const l1 = L.live(events);
  assert.deepEqual(l1.map((e) => e.id), [b.id, a.id, c.id]);
  assert.equal(L.live(events), l1, '바뀐 게 없으면 같은 결과를 다시 씀');
  assert.ok(Object.isFrozen(l1));
  assert.throws(() => l1.reverse(), TypeError, '공유 결과를 몰래 고칠 수 없음');
  // store.updateEvent 처럼 제자리에서 시각을 바꾸고 updatedAt 을 올림 → 다시 정렬
  a.ts = at(8); a.updatedAt += 1;
  assert.deepEqual(L.live(events).map((e) => e.id), [a.id, b.id, c.id]);
  // 지우기(툼스톤)
  b.deleted = true; b.updatedAt += 1;
  assert.deepEqual(L.live(events).map((e) => e.id), [a.id, c.id]);
  // 추가
  const d = ev('pee', at(12));
  events.push(d);
  assert.deepEqual(L.live(events).map((e) => e.id), [a.id, c.id, d.id]);
  // 다른 탭 합치기: 객체를 새것으로 바꿈(updatedAt 이 더 큼)
  events[0] = { ...a, ts: at(13), updatedAt: a.updatedAt + 5 };
  assert.deepEqual(L.live(events).map((e) => e.id), [c.id, d.id, a.id]);
  // 배열이 다르면 따로
  assert.deepEqual(L.live([b]).map((e) => e.id), []);
  assert.deepEqual(L.live(null), []);
});

test('memberColor · josa · memberName', () => {
  const ms = [{ id: 'a', role: 'mom' }, { id: 'b', role: 'grandma' }, { id: 'c', role: 'grandma' }];
  assert.equal(L.memberColor(ms[0], ms), D.ROLE_BY_ID.mom.color);
  assert.equal(L.memberColor(ms[1], ms), D.ROLE_BY_ID.grandma.color);
  assert.notEqual(L.memberColor(ms[2], ms), D.ROLE_BY_ID.grandma.color, '같은 역할 두 번째는 다른 색');
  assert.equal(L.josa('엄마', '이/가'), '엄마가');
  assert.equal(L.josa('이모님', '이/가'), '이모님이');
  assert.equal(L.josa('할머니', '은/는'), '할머니는');
  assert.equal(L.josa('선생님', '을/를'), '선생님을');
  assert.equal(L.josa('집', '으로/로'), '집으로');
  assert.equal(L.josa('길', '으로/로'), '길로');
  assert.equal(L.memberName(null), '누군가');
  assert.equal(L.memberName({ role: 'dad' }), '아빠');
});

// ---------- 힌트 ----------
test('poopAlert: 흰색·회색 urgent, 피 check, 태변은 3일까지 info, 초록 info, 노랑 null', () => {
  const p = (color) => ev('poop', at(9), { color });
  assert.equal(L.poopAlert(p('pale'), 20).level, 'urgent');
  assert.match(L.poopAlert(p('pale'), 20).text, /소아청소년과/);
  assert.equal(L.poopAlert(p('red'), 20).level, 'check');
  assert.equal(L.poopAlert(p('black'), 2).level, 'info');
  assert.equal(L.poopAlert(p('black'), 3).level, 'info');
  assert.equal(L.poopAlert(p('black'), 4).level, 'check');
  assert.equal(L.poopAlert(p('green'), 20).level, 'info');
  assert.equal(L.poopAlert(p('yellow'), 20), null);
  assert.equal(L.poopAlert(ev('poop', at(9)), 20), null);
  assert.equal(L.poopAlert(ev('pee', at(9)), 20), null);
});

test('hints: 3개월 미만 38℃ urgent, 흰 변 urgent, 급한 것 먼저', () => {
  const now = at(12);
  const fam = { birth: birthFor(40, now) };
  const hs = L.hints(stage('hundred'), [ev('temp', at(11), { c: 38.3 }), ev('poop', at(10), { color: 'pale' }), ev('water', at(9))], now, fam);
  assert.equal(hs[0].level, 'urgent');
  assert.ok(hs.some((h) => h.id === 'fever' && h.level === 'urgent' && h.link === '../fever/'));
  assert.ok(hs.some((h) => h.id === 'poop-color' && h.level === 'urgent'));
  assert.ok(hs.some((h) => h.id === 'water-early'));
  // 나중에 잰 체온이 정상이면 안내 없음
  assert.ok(!L.hints(stage('hundred'), [ev('temp', at(9), { c: 38.3 }), ev('temp', at(11), { c: 37.2 })], now, fam).some((h) => h.id === 'fever'));
  // 4개월이면 38℃ 는 info
  const older = L.hints(stage('rolling'), [ev('temp', at(11), { c: 38.3 })], now, { birth: birthFor(130, now) });
  assert.equal(older.find((h) => h.id === 'fever').level, 'info');
});

test('hints: 소변 기저귀 적음은 기록이 꾸준할 때만 (24시간 8개 이상 + 첫 기록이 24시간보다 오래됨)', () => {
  const now = at(20);
  const fam = { birth: birthFor(10, now) };
  const feeds = Array.from({ length: 8 }, (_, i) => ev('formula', now - (i + 1) * 2.5 * HOUR, { ml: 60, burp: 'yes' }));
  const pees = [ev('pee', now - 3 * HOUR), ev('pee', now - 6 * HOUR)];
  const old = ev('pee', now - 30 * HOUR);
  const hs = L.hints(stage('newborn'), [old, ...feeds, ...pees], now, fam);
  const wet = hs.find((h) => h.id === 'wet-low');
  assert.ok(wet, '10일 아기 24시간 소변 2번');
  assert.equal(wet.level, 'check');
  assert.match(wet.text, /깜빡했을 수도/);
  assert.match(wet.text, /6번 이상/);
  assert.ok(!L.hints(stage('newborn'), [...feeds, ...pees], now, fam).some((h) => h.id === 'wet-low'), '첫 기록이 24시간 안 → 안내 안 함');
  assert.ok(!L.hints(stage('newborn'), [old, ...feeds.slice(0, 4), ...pees], now, fam).some((h) => h.id === 'wet-low'), '기록이 드문드문 → 안내 안 함');
  // 생후 2일(2일째 최소 2개) 이면 2번은 충분
  assert.ok(!L.hints(stage('newborn'), [old, ...feeds, ...pees], now, { birth: birthFor(1, now) }).some((h) => h.id === 'wet-low'));
});

test('hints: 8시간 소변 없음은 그 뒤 다른 기록이 3개 이상일 때만, 신생아 4시간 수유 공백', () => {
  const now = at(20);
  const fam = { birth: birthFor(200, now) };
  const base = [ev('pee', at(10))];
  assert.ok(!L.hints(stage('solids'), [...base, ev('formula', at(12), { ml: 150 })], now, fam).some((h) => h.id === 'no-pee'));
  const hs = L.hints(stage('solids'), [...base, ev('formula', at(12), { ml: 150 }), ev('solid', at(13)), ev('sleep', at(14), { end: at(15) })], now, fam);
  assert.ok(hs.some((h) => h.id === 'no-pee' && h.level === 'check'));
  const nb = L.hints(stage('newborn'), [ev('formula', at(15, 30), { ml: 60 })], now, { birth: birthFor(5, now) });
  assert.ok(nb.some((h) => h.id === 'wake-feed'));
  // 분유 하루 960 초과
  const lots = Array.from({ length: 7 }, (_, i) => ev('formula', at(8 + i), { ml: 150 }));
  const f = L.hints(stage('solids'), lots, now, fam).find((h) => h.id === 'formula-max');
  assert.match(f.text, /1,050ml/);
});

// ---------- 교대 요약 ----------
function handoffScenario() {
  const events = [
    ev('formula', at(9, 10), { ml: 140, burp: 'yes' }, 's1'),
    ev('pee', at(9, 40), {}, 's1'),
    ev('sleep', at(10, 0), { end: at(11, 30) }, 's1'),
    ev('formula', at(12, 30), { ml: 140, burp: 'yes' }, 's1'),
    ev('pee', at(13, 50), {}, 's1'),
    ev('poop', at(13, 50), { color: 'yellow', texture: 'soft' }, 's1'),
    ev('temp', at(13, 0), { c: 38.2 }, 's1'),
    ev('med', at(13, 10), { name: '해열제(챔프)' }, 's1'),
    ev('note', at(15, 0), { text: '오후에 조금 보챘어요' }, 's1'),
    ev('sleep', at(14, 40), {}, 'm1'),
    ev('formula', at(8, 0), { ml: 999 }, 's1', { deleted: true }),
    ev('thanks', at(15, 1), { target: 'x' }, 'm1'),
  ];
  return { events, family: { name: '하린', birth: '2026-07-10' }, members: [{ id: 'm1', name: '엄마', role: 'mom' }, { id: 's1', name: '이모님', role: 'sitter' }] };
}

test('handoffText: RESEARCH B 형식 스냅샷 (지금 상태가 먼저, 사람별 횟수 없음)', () => {
  const { events, family, members } = handoffScenario();
  const now = at(15, 45);
  const txt = L.handoffText({ family, members, events, from: at(9), to: now, now, stage: stage('hundred') });
  assert.equal(txt, [
    '[하린 교대 요약] 9/28(월) 오전 9:00~오후 3:45',
    '지금: 오후 2:40부터 낮잠 중 (1시간 5분째)',
    '다음 수유 예상: 오후 3:50쯤 (마지막 오후 12:30 · 분유 140ml · 트림 O)',
    '수유: 2회 · 분유 총 280ml',
    '기저귀: 소변 2 · 대변 1 (마지막 오후 1:50 · 소변+대변 노랑)',
    '잠: 2번 · 총 2시간 35분',
    '약/체온: 오후 1:00 38.2℃ · 오후 1:10 해열제(챔프)',
    '특이사항: 오후에 조금 보챘어요',
    '- uridaylog 함께 육아일지',
  ].join('\n'));
  assert.ok(txt.split('\n').length <= 15);
  assert.ok(!/이모님|엄마 \d/.test(txt), '사람 이름·횟수 없음');
});

test('handoffText: 깨어 있음·기록 없음·날짜를 넘는 범위·흰 변 경고', () => {
  const fam = { name: '', birth: '2026-09-20' };
  const now = at(8, 0, 28);
  const events = [
    ev('sleep', at(22, 0, 27), { end: at(5, 30, 28) }),
    ev('breast', at(5, 40), { side: 'R', min: 15 }),
    ev('poop', at(6, 0), { color: 'pale' }),
  ];
  const txt = L.handoffText({ family: fam, members: [], events, from: at(20, 0, 27), to: now, now });
  const lines = txt.split('\n');
  assert.equal(lines[0], '[우리 아기 교대 요약] 9/27(일) 오후 8:00~9/28(월) 오전 8:00');
  assert.equal(lines[1], '지금: 깨어 있어요 (마지막 잠 오전 5:30 끝)');
  assert.equal(lines[2], '다음 수유 예상: 오전 8:10쯤 (마지막 오전 5:40 · 모유 오른쪽 15분)');
  assert.ok(lines.includes('⚠ 대변 색 확인 필요: 오전 6:00 흰색·회색'));
  assert.ok(lines.includes('약/체온: 없음'));
  assert.ok(lines.includes('잠: 1번 · 총 7시간 30분'));
  // 기록이 전혀 없을 때
  const empty = L.handoffText({ family: { name: '하린', birth: '2026-09-20' }, events: [], from: at(9), to: at(18), now: at(18) });
  assert.deepEqual(empty.split('\n'), ['[하린 교대 요약] 9/28(월) 오전 9:00~오후 6:00', '지금: 깨어 있어요', '수유: 없음', '기저귀: 기록 없음', '잠: 기록 없음', '약/체온: 없음', '- uridaylog 함께 육아일지']);
});

test('handoffText: 3시간 이하 범위는 한 줄 새벽 교대 버전', () => {
  const now = at(3, 20);
  const events = [
    ev('formula', at(3, 10), { ml: 120, burp: 'yes' }),
    ev('pee', at(3, 0)),
    ev('formula', at(0, 20), { ml: 110 }),
  ];
  const txt = L.handoffText({ family: { name: '하린', birth: '2026-09-01' }, events, from: at(0, 20), to: now, now });
  assert.equal(txt, '[새벽 교대] 마지막 수유 03:10 · 분유 120ml · 트림 O / 기저귀 03:00 소변 / 다음 수유 06:00쯤');
  assert.equal(L.handoffText({ family: { name: '하린' }, events: [], from: at(10), to: at(12), now: at(12) }), '[하린 교대] 기록 없음');
});

// ---------- CSV ----------
test('toCSV: BOM·헤더·따옴표/쉼표/줄바꿈 이스케이프·수식 주입 방지', () => {
  const members = [{ id: 'm1', name: '엄마, "최고"', role: 'mom' }];
  const events = [
    ev('formula', at(14, 32), { ml: 120, burp: 'yes', note: '잘 먹음,\n더 달라고 함' }),
    ev('note', at(15, 0), { text: '=HYPERLINK("x")' }),
    ev('pee', at(15, 5), {}, null),
    ev('pee', at(16), {}, 'm1', { deleted: true }),
  ];
  const csv = L.toCSV(events, members);
  assert.ok(csv.startsWith('﻿날짜,시간,종류,내용,누가,메모\r\n'));
  const body = csv.slice(1).split('\r\n');
  assert.equal(body[1], '2026-09-28,14:32,분유,120ml · 트림 ✓,"엄마, ""최고""","잘 먹음,\n더 달라고 함"');
  assert.equal(body[2], `2026-09-28,15:00,메모,"'=HYPERLINK(""x"")","엄마, ""최고""",`);
  assert.equal(body[3], '2026-09-28,15:05,소변,,,');
  assert.equal(body.length, 5, '지운 기록 제외 + 마지막 빈 줄');
});

// ---------- describe · fmt ----------
test('describe: 종류별 짧은 내용', () => {
  assert.equal(L.describe(ev('formula', at(1), { ml: 120, burp: 'yes' })), '120ml · 트림 ✓');
  assert.equal(L.describe(ev('pumped', at(1), { ml: 80, burp: 'no' })), '80ml · 트림 안 함');
  assert.equal(L.describe(ev('breast', at(1), { side: 'L', min: 10 })), '왼쪽 10분');
  assert.equal(L.describe(ev('breast', at(1), { side: 'both' })), '양쪽');
  assert.equal(L.describe(ev('poop', at(1), { color: 'yellow', texture: 'watery' })), '노랑 · 묽음');
  assert.equal(L.describe(ev('pee', at(1))), '');
  assert.equal(L.describe(ev('sleep', at(14, 10), { end: at(15, 20) })), '~15:20 · 1시간 10분');
  assert.equal(L.describe(ev('sleep', at(14, 10))), '자는 중');
  assert.equal(L.describe(ev('temp', at(1), { c: 38 })), '38.0℃');
  assert.equal(L.describe(ev('med', at(1), { name: '챔프', note: '5ml' })), '챔프 · 5ml');
  assert.equal(L.describe(ev('potty', at(1), { result: 'pee' })), '쉬 성공 🎉');
  assert.equal(L.describe(ev('potty', at(1), { result: 'try' })), '시도만');
  assert.equal(L.describe(ev('solid', at(1), { food: '소고기죽', amount: 'half', reaction: 'good' })), '소고기죽 · 반 · 좋아함');
  assert.equal(L.describe(ev('tummy', at(1), { min: 5 })), '5분');
  assert.equal(L.describe(ev('note', at(1), { text: '가'.repeat(50) })), `${'가'.repeat(40)}…`);
  assert.equal(L.describe(ev('handoff', at(18), { from: at(9), to: at(18) })), '09:00~18:00');
  assert.equal(L.describe(ev('mystery', at(1), { x: 1 })), '');
  assert.equal(L.typeMeta('mystery').label, '기록');
});

test('fmtTime · fmtHM · fmtElapsed · fmtDur · fmtNum · fill', () => {
  assert.equal(L.fmtTime(at(14, 32)), '오후 2:32');
  assert.equal(L.fmtTime(at(0, 5)), '오전 12:05');
  assert.equal(L.fmtTime(at(12, 30)), '오후 12:30');
  assert.equal(L.fmtTime(at(9, 0)), '오전 9:00');
  assert.equal(L.fmtTimeSoft(at(3, 10)), '새벽 3:10');
  assert.equal(L.fmtTimeSoft(at(0, 10)), '새벽 12:10');
  assert.equal(L.fmtHM(at(3, 5)), '03:05');
  assert.equal(L.fmtHM(at(14, 32)), '14:32');
  assert.equal(L.fmtElapsed(0), '방금');
  assert.equal(L.fmtElapsed(0.9), '방금');
  assert.equal(L.fmtElapsed(-5), '방금');
  assert.equal(L.fmtElapsed(45), '45분');
  assert.equal(L.fmtElapsed(60), '1시간');
  assert.equal(L.fmtElapsed(130), '2시간 10분');
  assert.equal(L.fmtElapsed(1500), '1일 1시간');
  assert.equal(L.fmtElapsed(null), '');
  assert.equal(L.fmtDur(72), '1:12');
  assert.equal(L.fmtDur(40), '0:40');
  assert.equal(L.fmtDur(0), '0:00');
  assert.equal(L.fmtNum(1050), '1,050');
  assert.equal(L.fmtNum(960), '960');
  assert.equal(L.fill('{n}ml {x}', { n: 3 }), '3ml {x}');
});

test('uuid · isUuid', () => {
  const a = L.uuid();
  assert.ok(L.isUuid(a));
  assert.notEqual(a, L.uuid());
  assert.ok(!L.isUuid('nope'));
  const saved = globalThis.crypto.randomUUID;
  try {
    globalThis.crypto.randomUUID = undefined;
    const b = L.uuid();
    assert.match(b, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    globalThis.crypto.randomUUID = saved;
  }
});

// ---------- 데이터 정리 · 버튼 ----------
test('cleanData: 서버 범위로 자르고 모르는 키 버림', () => {
  assert.deepEqual(L.cleanData('formula', { ml: '120.4', burp: 'yes', junk: 1 }), { ml: 120, burp: 'yes' });
  assert.deepEqual(L.cleanData('formula', { ml: 0 }), {});
  assert.deepEqual(L.cleanData('formula', { ml: 501, burp: 'maybe' }), {});
  assert.deepEqual(L.cleanData('milk', { ml: 200, burp: 'yes' }), { ml: 200 }, '우유엔 트림 없음');
  assert.deepEqual(L.cleanData('breast', { side: 'X', min: 500 }), { side: 'both' });
  assert.deepEqual(L.cleanData('poop', { color: 'pale', texture: 'soft' }), { color: 'pale', texture: 'soft' });
  assert.deepEqual(L.cleanData('temp', { c: '38,25' }), { c: 38.3 });
  assert.deepEqual(L.cleanData('temp', { c: 3.75 }), {});
  assert.deepEqual(L.cleanData('sleep', { end: 100 }, 200), { end: 200 }, '끝이 시작보다 앞서면 시작으로');
  assert.deepEqual(L.cleanData('note', { text: `  ${'가'.repeat(300)}  ` }).text.length, 200);
  assert.deepEqual(L.cleanData('med', { name: '😀'.repeat(30), note: 'x' }), { name: '😀'.repeat(20), note: 'x' });
  assert.deepEqual(L.cleanData('pee', { note: ' 새 기저귀 ', src: 'shortcut' }), { note: '새 기저귀', src: 'shortcut' });
  assert.deepEqual(L.cleanData('pee', { src: 'evil' }), {});
  assert.deepEqual(L.cleanData('solid', { food: '쌀미음', amount: 'all', reaction: 'allergy' }), { food: '쌀미음', amount: 'all', reaction: 'allergy' });
  assert.deepEqual(L.cleanData('potty', { result: 'poop' }), { result: 'poop' });
  assert.deepEqual(L.cleanData('thanks', { target: 'abc' }), { target: 'abc' });
});

test('gridFor · moreActions · isActionVisible: 이유식은 120일부터, 가족이 고친 그리드 우선', () => {
  const rl = stage('rolling');
  assert.ok(!L.gridFor(rl, 110).includes('solid'));
  assert.ok(L.gridFor(rl, 120).includes('solid'));
  assert.ok(L.gridFor(rl, null).includes('solid'), '나이를 모르면 전부');
  assert.deepEqual(L.gridFor(rl, 110, { grid: { rolling: ['pee', 'both', 'thanks', 'nope'] } }), ['pee', 'both']);
  assert.deepEqual(L.gridFor(rl, 110, { grid: { newborn: ['pee'] } }), L.gridFor(rl, 110), '다른 단계 설정은 무시');
  const more = L.moreActions(rl, 110);
  assert.ok(more.includes('burp') === false, 'burp 는 그리드에 있음');
  assert.ok(more.includes('both') && more.includes('temp') && !more.includes('solid') && !more.includes('milk'));
  assert.equal(L.isActionVisible('water', 179), false);
  assert.equal(L.isActionVisible('water', 180), true);
  assert.equal(L.isActionVisible('potty', 547), false);
  assert.equal(L.isActionVisible('potty', 548), true);
  assert.equal(L.isActionVisible('tummy', 365), false);
  assert.equal(L.isActionVisible('thanks', 10), false);
  assert.ok(L.visibleActions(0).includes('both'));
  for (const s of D.STAGES) {
    const g = L.gridFor(s, s.fromDay + 30);
    assert.ok(g.length >= 8 && g.length <= 9, s.id);
  }
});
