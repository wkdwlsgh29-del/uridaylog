// parse.js — 받아쓰기 한 문장 파서 테스트 (DB 불필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSay, koNumber } from '../parse.js';

const CASES = [
  // 분유·맘마·우유 (+ ml 단위 여러 표기, 한글 수사)
  ['분유 120', { type: 'formula', data: { ml: 120 } }],
  ['분유 120ml', { type: 'formula', data: { ml: 120 } }],
  ['분유 120 ML 먹였어요.', { type: 'formula', data: { ml: 120 } }],
  ['분유 120미리 먹였어', { type: 'formula', data: { ml: 120 } }],
  ['맘마 80밀리', { type: 'formula', data: { ml: 80 } }],
  ['우유 150cc', { type: 'formula', data: { ml: 150 } }],
  ['분유 １６０㎖', { type: 'formula', data: { ml: 160 } }],
  ['120 먹였어', { type: 'formula', data: { ml: 120 } }],
  ['120ml', { type: 'formula', data: { ml: 120 } }],
  ['120', { type: 'formula', data: { ml: 120 } }],
  ['분유 백이십', { type: 'formula', data: { ml: 120 } }],
  ['분유 이백사십 미리', { type: 'formula', data: { ml: 240 } }],
  ['분유 백', { type: 'formula', data: { ml: 100 } }],
  ['맘마 구십 미리 먹었어', { type: 'formula', data: { ml: 90 } }],
  ['맘마 먹였어', { type: 'formula', data: {} }],
  ['분유 120 먹고 트림했어', { type: 'formula', data: { ml: 120, burp: 'yes' } }],
  ['분유 100 트림 안 했어', { type: 'formula', data: { ml: 100, burp: 'no' } }],
  // 유축·모유
  ['유축 150', { type: 'pumped', data: { ml: 150 } }],
  ['유축한 모유 100 먹였어', { type: 'pumped', data: { ml: 100 } }],
  ['모유 80미리', { type: 'pumped', data: { ml: 80 } }],
  ['모유 왼쪽 10분', { type: 'breast', data: { side: 'L', min: 10 } }],
  ['모유 오른쪽 15분', { type: 'breast', data: { side: 'R', min: 15 } }],
  ['오른쪽 모유 20분', { type: 'breast', data: { side: 'R', min: 20 } }],
  ['젖 양쪽 20분 먹였어', { type: 'breast', data: { side: 'both', min: 20 } }],
  ['모유 왼쪽 십오 분', { type: 'breast', data: { side: 'L', min: 15 } }],
  ['모유 먹였어', { type: 'breast', data: { side: 'both' } }],
  ['모유 수유 왼쪽 오른쪽 10분씩', { type: 'breast', data: { side: 'both', min: 10 } }],
  // 기저귀
  ['쉬했어', { type: 'pee', data: {} }],
  ['쉬 했어요', { type: 'pee', data: {} }],
  ['소변', { type: 'pee', data: {} }],
  ['오줌 쌌어', { type: 'pee', data: {} }],
  ['기저귀 갈았어', { type: 'pee', data: {} }],
  ['응가 노란색', { type: 'poop', data: { color: 'yellow' } }],
  ['응가했어', { type: 'poop', data: {} }],
  ['똥 쌌어 초록색 묽어', { type: 'poop', data: { color: 'green', texture: 'watery' } }],
  ['대변 갈색 단단해', { type: 'poop', data: { color: 'brown', texture: 'hard' } }],
  ['응가 검은색', { type: 'poop', data: { color: 'black' } }],
  ['까만 똥', { type: 'poop', data: { color: 'black' } }],
  ['빨간 똥 쌌어', { type: 'poop', data: { color: 'red' } }],
  ['흰색 응가', { type: 'poop', data: { color: 'pale' } }],
  ['회색 변 봤어', { type: 'poop', data: { color: 'pale' } }],
  ['설사했어 똥', { type: 'poop', data: { texture: 'watery' } }],
  ['똥기저귀 갈았어', { type: 'poop', data: {} }],
  ['쉬랑 응가', { type: 'both', data: {} }],
  ['쉬하고 응가 했어 노란색', { type: 'both', data: { color: 'yellow' } }],
  ['둘 다', { type: 'both', data: {} }],
  ['소변 대변 둘다 했어', { type: 'both', data: {} }],
  ['변기에 쉬 성공', { type: 'potty', data: { result: 'pee' } }],
  ['응가 실수했어 팬티에', { type: 'potty', data: { result: 'accident' } }],
  // 트림·잠
  ['트림했어', { type: 'burp', data: {} }],
  ['꺼억 트림', { type: 'burp', data: {} }],
  ['잠들었어', { type: 'sleep', data: {} }],
  ['재웠어', { type: 'sleep', data: {} }],
  ['낮잠 시작', { type: 'sleep', data: {} }],
  ['잠', { type: 'sleep', data: {} }],
  ['분유 먹고 잠들었어', { type: 'sleep', data: {} }],
  ['깼어', { action: 'sleep_end' }],
  ['일어났어요', { action: 'sleep_end' }],
  ['잠에서 깼어', { action: 'sleep_end' }],
  ['잠 깼어', { action: 'sleep_end' }],
  // 돌봄
  ['목욕했어', { type: 'bath', data: {} }],
  ['목욕 시켰어', { type: 'bath', data: {} }],
  ['터미타임 10분', { type: 'tummy', data: { min: 10 } }],
  ['엎드려 놀기 5분', { type: 'tummy', data: { min: 5 } }],
  ['양치했어', { type: 'brush', data: {} }],
  ['이 닦았어', { type: 'brush', data: {} }],
  ['물 50', { type: 'water', data: { ml: 50 } }],
  ['물 30미리 마셨어', { type: 'water', data: { ml: 30 } }],
  ['물 마셨어', { type: 'water', data: {} }],
  // 체온·약·먹거리
  ['체온 37.5', { type: 'temp', data: { c: 37.5 } }],
  ['열 38.2도', { type: 'temp', data: { c: 38.2 } }],
  ['열이 38도 5부', { type: 'temp', data: { c: 38.5 } }],
  ['38도 5부', { type: 'temp', data: { c: 38.5 } }],
  ['체온 삼십칠점오', { type: 'temp', data: { c: 37.5 } }],
  ['37.8', { type: 'temp', data: { c: 37.8 } }],
  ['해열제 먹였어', { type: 'med', data: { name: '해열제' } }],
  ['약 먹였어', { type: 'med', data: { name: '약' } }],
  ['이유식 다 먹었어', { type: 'solid', data: { amount: 'all' } }],
  ['이유식 거부했어', { type: 'solid', data: { reaction: 'refuse' } }],
  ['간식 조금', { type: 'snack', data: { amount: 'little' } }],
  // "N분 전에"
  ['30분 전에 분유 120', { type: 'formula', data: { ml: 120 }, agoMin: 30 }],
  ['10분 전에 깼어', { action: 'sleep_end', agoMin: 10 }],
  ['1시간 반 전에 모유 왼쪽 10분', { type: 'breast', data: { side: 'L', min: 10 }, agoMin: 90 }],
  ['두 시간 전에 쉬했어', { type: 'pee', data: {}, agoMin: 120 }],
  ['방금 응가했어', { type: 'poop', data: {}, agoMin: 0 }],
  // '소변 봤어'의 꼬리 '변 봤'을 대변으로 읽지 않는다
  ['소변 봤어', { type: 'pee', data: {} }],
  ['소변 봤어요', { type: 'pee', data: {} }],
  ['소변봤어', { type: 'pee', data: {} }],
  ['소변을 봤어', { type: 'pee', data: {} }],
  ['대변 봤어', { type: 'poop', data: {} }],
  ['변 봤어', { type: 'poop', data: {} }],
  // 잠 끝 낱말 = 깼어요 (잠 시작이 아님), 부정은 잠 시작이 아님
  ['잠 끝났어', { action: 'sleep_end' }],
  ['낮잠 끝', { action: 'sleep_end' }],
  ['낮잠 끝났어', { action: 'sleep_end' }],
  ['잠 끝', { action: 'sleep_end' }],
  ['다 잤어', { action: 'sleep_end' }],
  ['수유 끝나고 잠들었어', { type: 'sleep', data: {} }],
  ['잠 안 자', null],
  ['못 잤어', null],
  // 흰 알갱이 섞인 노란 변(정상)·옅은 노란색은 흰색 변(급함)이 아니다 — 다른 색 낱말이 먼저
  ['응가 옅은 노란색', { type: 'poop', data: { color: 'yellow' } }],
  ['응가 흰 우유 덩어리 섞인 노란색', { type: 'poop', data: { color: 'yellow' } }],
  ['대변 노란데 하얀 알갱이', { type: 'poop', data: { color: 'yellow' } }],
  ['응가 초록색 흰 몽글이', { type: 'poop', data: { color: 'green' } }],
  ['응가 옅은 갈색', { type: 'poop', data: { color: 'brown' } }],
  ['하얀 똥', { type: 'poop', data: { color: 'pale' } }],
  ['응가 회색인데 노란 것도', { type: 'poop', data: { color: 'pale' } }],
  // 생우유는 늘 우유 (그냥 '우유'는 나이를 모르면 분유 — 아래 따로)
  ['생우유 180', { type: 'milk', data: { ml: 180 } }],
  // 못 알아듣는 말
  ['오늘 날씨 좋다', null],
  ['', null],
  ['   ', null],
  ['안녕', null],
  ['백신 맞았어', null],
];

test(`parseSay: ${CASES.length}가지 말투`, () => {
  const failures = [];
  for (const [input, want] of CASES) {
    const got = parseSay(input);
    try {
      assert.deepEqual(got, want);
    } catch {
      failures.push(`${JSON.stringify(input)} → ${JSON.stringify(got)} (기대 ${JSON.stringify(want)})`);
    }
  }
  assert.equal(failures.length, 0, '\n' + failures.join('\n'));
  assert.ok(CASES.length >= 30);
});

test('parseSay: 문자열이 아니면 null', () => {
  assert.equal(parseSay(null), null);
  assert.equal(parseSay(undefined), null);
  assert.equal(parseSay(120), null);
  assert.equal(parseSay({}), null);
});

test('parseSay: 아주 긴 입력도 안전하게 처리', () => {
  const r = parseSay('쉬 '.repeat(10000));
  assert.deepEqual(r, { type: 'pee', data: {} });
});

test('koNumber: 한글 수사', () => {
  assert.equal(koNumber('백이십'), 120);
  assert.equal(koNumber('이백사십'), 240);
  assert.equal(koNumber('십오'), 15);
  assert.equal(koNumber('삼십칠'), 37);
  assert.equal(koNumber('천'), 1000);
  assert.equal(koNumber('오'), 5);
  assert.equal(koNumber('이이'), null);
  assert.equal(koNumber('십백'), null);
});

test('parseSay: 우유 — 돌(365일) 이후엔 우유(milk), 돌 전·나이 모름은 분유 (분유·맘마·젖병이란 말이 있으면 분유)', () => {
  assert.deepEqual(parseSay('우유 200'), { type: 'formula', data: { ml: 200 } });
  assert.deepEqual(parseSay('우유 200', { ageDays: 200 }), { type: 'formula', data: { ml: 200 } });
  assert.deepEqual(parseSay('우유 200', { ageDays: 365 }), { type: 'milk', data: { ml: 200 } });
  assert.deepEqual(parseSay('우유 200 마셨어', { ageDays: 480 }), { type: 'milk', data: { ml: 200 } });
  assert.deepEqual(parseSay('밀크 150', { ageDays: 480 }), { type: 'milk', data: { ml: 150 } });
  assert.deepEqual(parseSay('분유 우유 180', { ageDays: 480 }), { type: 'formula', data: { ml: 180 } });
  assert.deepEqual(parseSay('젖병으로 우유 120', { ageDays: 480 }), { type: 'formula', data: { ml: 120 } });
  assert.deepEqual(parseSay('생우유 100', { ageDays: 100 }), { type: 'milk', data: { ml: 100 } });
});
