// uridaylog — 함께 육아일지: 받아쓰기(Siri·빅스비) 한 문장 → 기록 한 건 파서
// 예) "분유 120", "120 먹였어", "쉬했어", "응가 노란색", "잠들었어", "깼어", "트림했어", "모유 왼쪽 10분",
//     "분유 백이십 미리", "체온 37.5", "38도 5부", "30분 전에 분유 120"
// 반환: { type, data, agoMin? } | { action: 'sleep_end', agoMin? } | null (못 알아들음)
//   opts.ageDays: 생후 일수(서버가 가족 생일로 계산). '생우유'는 늘 우유(milk), 그냥 '우유·밀크'는 돌(365일) 이후만
//     우유로 본다 — 돌 전 아기에게 '우유'는 보통 분유를 가리키는 말이라서.
//   · type 'both' = 소변+대변 동시 (UI 동작과 같음; data 는 대변 쪽 색·굳기)
//   · agoMin = "N분 전 / N시간 전" 이라고 말했을 때만 (서버가 기록 시각을 그만큼 당긴다)
//   · 숫자 범위 검증(분유 1~500ml 등)은 서버(handler.js)가 한다. 여기서는 말한 그대로 돌려준다.
// 의존성 없음 · 런타임 무관(Node / Deno / 브라우저).

// ── 한글 수사(백이십 → 120) ──────────────────────────────────────────────
const KO_DIGIT = { 영: 0, 공: 0, 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
const KO_UNIT = { 십: 10, 백: 100, 천: 1000 };
const KO_NATIVE_HOUR = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10 };

export function koNumber(word) {
  let total = 0;
  let cur = null;
  let lastUnit = Infinity;
  for (const ch of word) {
    if (ch in KO_DIGIT) {
      if (cur !== null) return null; // "이이" 같은 연속 숫자는 수사가 아님
      cur = KO_DIGIT[ch];
    } else if (ch in KO_UNIT) {
      const u = KO_UNIT[ch];
      if (u >= lastUnit) return null; // "십백" 같은 역순은 수사가 아님
      total += (cur ?? 1) * u;
      cur = null;
      lastUnit = u;
    } else {
      return null;
    }
  }
  return total + (cur ?? 0);
}

// 숫자 뒤에 오는 단위 (이게 붙어 있을 때만 한 글자 수사 "오 분"도 숫자로 본다)
const UNIT_AFTER = /^\s*(ml|미리|밀리|cc|씨씨|시시|분(?!유)|도|시간|번|개|그램|g\b)/;
const BOUNDARY_AFTER = /^($|[\s.,!?~]|을|를|은|는|만|정도|쯤|씩|이요|요)/;

function normalizeNumbers(s) {
  // "38도 5부" → 38.5도 (옛 체온 표기)
  s = s.replace(/(\d+)\s*도\s*(\d)\s*부/g, '$1.$2도');
  // 한글 수사: 단위가 뒤에 붙었거나(십오 분), 십·백·천이 들어간 독립 단어(백이십)일 때만 숫자로 바꾼다.
  //   "오른쪽", "이 닦았어", "일어났어", "이유식", "백신" 같은 낱말은 건드리지 않는다.
  s = s.replace(/([영공일이삼사오육륙칠팔구십백천]+)(?:\s*점\s*([영공일이삼사오육륙칠팔구]+))?/g, (m, a, b, off, str) => {
    const prev = off > 0 ? str[off - 1] : ' ';
    const next = str.slice(off + m.length);
    const big = /[십백천]/.test(a);
    const prevOk = /[\s\d.,!?~]/.test(prev);
    const unitNext = UNIT_AFTER.test(next);
    if (!((unitNext && (big || prevOk)) || (big && prevOk && BOUNDARY_AFTER.test(next)))) return m;
    const n = koNumber(a);
    if (n == null) return m;
    if (b) {
      const frac = Array.from(b).map((c) => KO_DIGIT[c]).join('');
      return `${n}.${frac}`;
    }
    return String(n);
  });
  // "37점5", "37 점 5" → 37.5
  s = s.replace(/(\d+)\s*점\s*(\d+)/g, '$1.$2');
  return s;
}

function normalize(input) {
  let s = String(input).normalize('NFKC').toLowerCase();
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  // 숫자 사이의 점(37.5)은 남기고 나머지 문장부호는 공백으로
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ').replace(/[,!?~…"'“”‘’()[\]{}·:;]/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return normalizeNumbers(s).replace(/\s+/g, ' ').trim();
}

// "30분 전에", "1시간 반 전", "두 시간 전", "반 시간 전", "방금" → 분
function extractAgo(s) {
  let agoMin = null;
  const cut = (re, fn) => {
    if (agoMin != null) return;
    const m = s.match(re);
    if (!m) return;
    agoMin = fn(m);
    s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
  };
  const nativeHours = Object.keys(KO_NATIVE_HOUR).join('|');
  cut(/(\d+)\s*시간\s*(반)?\s*(?:(\d+)\s*분\s*)?전(?:에|쯤|부터)?/, (m) => Number(m[1]) * 60 + (m[2] ? 30 : 0) + (m[3] ? Number(m[3]) : 0));
  cut(new RegExp(`(${nativeHours})\\s*시간\\s*(반)?\\s*(?:(\\d+)\\s*분\\s*)?전(?:에|쯤|부터)?`), (m) => KO_NATIVE_HOUR[m[1]] * 60 + (m[2] ? 30 : 0) + (m[3] ? Number(m[3]) : 0));
  cut(/반\s*시간\s*전(?:에|쯤|부터)?/, () => 30);
  cut(/(\d+)\s*분\s*전(?:에|쯤|부터)?/, (m) => Number(m[1]));
  cut(/(?:^|\s)방금(?:\s|$)/, () => 0);
  return { text: s, agoMin };
}

// ── 낱말 사전 ────────────────────────────────────────────────────────────
const RE = {
  // 잠 끝: '잠 끝났어'·'낮잠 끝'·'다 잤어'도 깬 것 ('잠'이 들어 있어서 시작보다 먼저 본다)
  wake: /깼|깨었|깨어났|깨어남|깸|일어났|일어남|기상|깨웠|잠\s*깨|잠\s*(?:이|은|을)?\s*(?:다\s*)?끝|다\s*잤|잘\s*잤|푹\s*잤/,
  sleep: /잠들|잠\s*들|잠이\s*들|재웠|재움|재우|낮잠|밤잠|취침|꿀잠|코\s*자|잠\s*시작|자기\s*시작|자는\s*중|자고\s*있|잔다|자요|수면|(?:^|\s)잠(?:\s|$)/,
  // '잠 안 자'·'못 자'·'잠이 안 와' — 잠 시작이 아님 (추측해서 기록하지 않는다)
  sleepNo: /(?:안|못)\s*(?:자|잔|잠|잤)|잠\s*(?:이|을)?\s*안\s*(?:와|오|들)/,
  pee: /쉬(?![었어워운는])|소변|오줌/,
  diaper: /기저귀/,
  // '변 봤어' 는 대변 — 단 '소변 봤어'의 꼬리는 아님
  poop: /응가|응아|끙아|똥|대변|(?<!소)변\s*봤|(?<!소)변을|큰\s*거|떵/,
  bothWords: /둘\s*다/,
  potty: /변기|성공|실수|팬티|시도|앉아만/,
  formula: /분유|맘마|우유|젖병|밀크/,
  formulaOnly: /분유|맘마|젖병/,
  milkRaw: /생우유/,
  milkWord: /우유|밀크/,
  pumped: /유축/,
  breast: /모유|젖(?!병)|직수|수유|찌찌|쭈쭈/,
  eatVerb: /먹였|먹었|먹음|먹임|마셨|마심|먹어|드셨/,
  burp: /트림|꺼억|끄억|꺼윽/,
  burpNo: /트림[^0-9]{0,6}(?:안|못)|(?:안|못)\s*(?:하고\s*)?트림/,
  bath: /목욕|씻겼|씻김|씻었|샤워/,
  tummy: /터미|엎드려|엎드리|엎드림|배밀이|엎어/,
  brush: /양치|이\s*닦|칫솔|치카/,
  water: /(?:^|\s)물(?=$|\s|\d|을|를|도|만|좀|조금)/,
  med: /해열제|타이레놀|챔프|부루펜|맥시부펜|이부프로펜|아세트아미노펜|항생제|유산균|비타민|철분제|시럽|(?:^|\s)약(?:을|도|\s|$)/,
  solid: /이유식|미음|(?:^|\s)죽(?:\s|$|을|도)/,
  snack: /간식|과자|떡뻥|요거트|과일/,
  meal: /(?:^|\s)밥(?:\s|$|을|도)|식사|유아식/,
  tempWord: /체온|온도|발열|미열|고열|(?:^|\s)열(?:이|\s|$)|℃|°/,
};

// 순서가 중요: 검정·빨강 → 분명한 회색·회백색 → 노랑·초록·갈색 → (다른 색 낱말이 없을 때만) 흰·하얀.
//   '노란 변에 흰 알갱이'(모유 변의 흔한 정상 모양)·'옅은 노란색'을 흰색 변(급함)으로 읽지 않게. '옅은'은 색이 아니다.
const COLORS = [
  [/검정|검은|까만|까맣|검붉|흑변|검은색/, 'black'],
  [/빨강|빨간|빨갛|붉은|혈변|피가|피\s*섞/, 'red'],
  [/회색|회백|잿빛|창백|쌀뜨물/, 'pale'], // 앱 POOP_COLORS 의 id 'pale'(흰색·회색)
  [/초록|녹색|녹변|풀색|연두/, 'green'],
  [/갈색|밤색|황갈|고동|브라운/, 'brown'],
  [/노랑|노란|노랗|황금|누런|누렇/, 'yellow'],
  [/흰|하얀|하얗|백색/, 'pale'],
];
const TEXTURES = [
  [/묽|설사|물똥|물변|물\s*같|주르륵/, 'watery'],
  [/단단|딱딱|토끼\s*똥|굳은/, 'hard'],
  [/무른|무름|부드|질척|진흙/, 'soft'],
  [/보통|정상|적당/, 'normal'],
];
const MED_NAMES = ['해열제', '타이레놀', '챔프', '부루펜', '맥시부펜', '이부프로펜', '아세트아미노펜', '항생제', '유산균', '비타민', '철분제', '시럽'];

// ── 숫자 뽑기 ────────────────────────────────────────────────────────────
const num = (x) => Number(x);
function mlAmount(s) {
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:ml|미리|밀리|cc|씨씨|시시)/);
  return m ? Math.round(num(m[1])) : null;
}
function minutes(s) {
  const m = s.match(/(\d+)\s*분(?!유)/);
  return m ? num(m[1]) : null;
}
function bareNumber(s) {
  // 단위 없는 숫자 (시간·분 단위가 붙은 숫자는 제외)
  const re = /(\d+(?:\.\d+)?)(?![\d.]|\s*(?:분(?!유)|시간|도|번|개))/g;
  let m;
  while ((m = re.exec(s))) return Math.round(num(m[1]));
  return null;
}
function poopData(s) {
  const data = {};
  for (const [re, id] of COLORS) if (re.test(s)) { data.color = id; break; }
  for (const [re, id] of TEXTURES) if (re.test(s)) { data.texture = id; break; }
  return data;
}
function breastSide(s) {
  const l = /왼|좌측|좌\s*쪽/.test(s);
  const r = /오른|우측|우\s*쪽/.test(s);
  if ((l && r) || /양쪽|양\s*쪽|둘\s*다/.test(s)) return 'both';
  if (l) return 'L';
  if (r) return 'R';
  return 'both';
}
function tempValue(s, hasFeedWord) {
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)(\s*도)?/g)].map((m) => ({ v: num(m[1]), deg: !!m[2] }));
  const inRange = (v) => v >= 34 && v <= 42.5;
  if (RE.tempWord.test(s)) {
    const hit = nums.find((n) => inRange(n.v));
    if (hit) return hit.v;
  }
  if (!hasFeedWord) {
    const deg = nums.find((n) => n.deg && inRange(n.v));
    if (deg) return deg.v;
    // "37.5" 처럼 소수 하나만 말한 경우
    if (/^\d{2}\.\d$/.test(s) && inRange(num(s))) return num(s);
  }
  return null;
}

// ── 본체 ─────────────────────────────────────────────────────────────────
export function parseSay(input, opts = {}) {
  if (typeof input !== 'string') return null;
  const ageDays = Number.isFinite(opts?.ageDays) ? opts.ageDays : null;
  const norm = normalize(input.slice(0, 300));
  if (!norm) return null;
  const { text: s, agoMin } = extractAgo(norm);
  const out = (r) => (agoMin != null ? { ...r, agoMin } : r);
  if (!s) return null;

  const isFormula = RE.formula.test(s);
  // 우유(milk): '생우유'는 늘, '우유·밀크'는 돌 이후에만 (분유·맘마·젖병이란 말이 같이 있으면 분유)
  const isMilk = RE.milkRaw.test(s) || (ageDays != null && ageDays >= 365 && RE.milkWord.test(s) && !RE.formulaOnly.test(s));
  const isPumped = RE.pumped.test(s);
  const isBreast = RE.breast.test(s);
  const feedWord = isFormula || isPumped || isBreast;

  // 1) 체온
  const c = tempValue(s, feedWord);
  if (c != null) return out({ type: 'temp', data: { c } });

  // 2) 깼다 → 잠 끝 ("잠 깼어"에도 '잠'이 있으므로 시작보다 먼저)
  if (RE.wake.test(s)) return out({ action: 'sleep_end' });

  // 3) 기저귀·배변훈련
  const poop = RE.poop.test(s);
  const pee = RE.pee.test(s) || (RE.diaper.test(s) && !poop); // "기저귀 갈았어" = 보통 소변
  if (pee || poop || (RE.bothWords.test(s) && !feedWord)) {
    if (RE.potty.test(s)) {
      let result = 'try';
      if (/실수/.test(s)) result = 'accident';
      else if (/성공/.test(s)) result = poop ? 'poop' : 'pee';
      return out({ type: 'potty', data: { result } });
    }
    if ((pee && poop) || (RE.bothWords.test(s) && !feedWord)) return out({ type: 'both', data: poopData(s) });
    if (poop) return out({ type: 'poop', data: poopData(s) });
    return out({ type: 'pee', data: {} });
  }

  // 4) 수유
  const burp = RE.burp.test(s) ? (RE.burpNo.test(s) ? 'no' : 'yes') : null;
  const withBurp = (data) => (burp ? { ...data, burp } : data);
  const ml = mlAmount(s);
  const bare = bareNumber(s);
  const min = minutes(s);
  const sleepy = RE.sleep.test(s) && !RE.sleepNo.test(s);
  const feed = () => {
    if (isMilk && !isPumped) {
      const amount = ml ?? bare;
      return { type: 'milk', data: amount != null ? { ml: amount } : {} };
    }
    if (isPumped) {
      const amount = ml ?? bare;
      return { type: 'pumped', data: withBurp(amount != null ? { ml: amount } : {}) };
    }
    if (isBreast && !isFormula) {
      if (ml != null) return { type: 'pumped', data: withBurp({ ml }) }; // "모유 100미리" = 젖병에 담은 모유
      const data = { side: breastSide(s) };
      const m = min ?? (bare != null && bare <= 60 ? bare : null);
      if (bare != null && bare > 60 && min == null) return { type: 'pumped', data: withBurp({ ml: bare }) };
      if (m != null) data.min = m;
      return { type: 'breast', data: withBurp(data) };
    }
    const amount = ml ?? bare;
    return { type: 'formula', data: withBurp(amount != null ? { ml: amount } : {}) };
  };
  const hasAmount = ml != null || bare != null || min != null;
  if (feedWord && (hasAmount || !sleepy)) return out(feed());

  // 5) 잠 시작 ('잠 안 자'처럼 부정이면 sleepy=false — 다른 뜻을 못 찾으면 null)
  if (sleepy) return out({ type: 'sleep', data: {} });

  // 6) 트림만
  if (burp === 'yes') return out({ type: 'burp', data: {} });

  // 7) 돌봄
  if (RE.bath.test(s)) return out({ type: 'bath', data: {} });
  if (RE.tummy.test(s)) return out({ type: 'tummy', data: min != null ? { min } : {} });
  if (RE.brush.test(s)) return out({ type: 'brush', data: {} });
  if (RE.water.test(s)) {
    const w = ml ?? bare;
    return out({ type: 'water', data: w != null ? { ml: w } : {} });
  }
  if (RE.med.test(s)) {
    const name = MED_NAMES.find((n) => s.includes(n)) || '약';
    return out({ type: 'med', data: { name } });
  }
  const foodType = RE.solid.test(s) ? 'solid' : RE.snack.test(s) ? 'snack' : RE.meal.test(s) ? 'meal' : null;
  if (foodType) {
    const data = {};
    if (/다\s*먹|싹\s*비|완밥|완식|남김\s*없/.test(s)) data.amount = 'all';
    else if (/더\s*먹|리필|한\s*번\s*더/.test(s)) data.amount = 'more';
    else if (/(?:^|\s)반(?:\s|$|만|쯤|정도)/.test(s)) data.amount = 'half';
    else if (/조금|약간|쪼금|몇\s*숟/.test(s)) data.amount = 'little';
    if (/알레르기|두드러기|발진/.test(s)) data.reaction = 'allergy';
    else if (/거부|안\s*먹|뱉/.test(s)) data.reaction = 'refuse';
    else if (/잘\s*먹|좋아/.test(s)) data.reaction = 'good';
    return out({ type: foodType, data });
  }

  // 8) 숫자만: "120 먹였어", "120ml", "120"
  if (ml != null) return out({ type: 'formula', data: withBurp({ ml }) });
  if (bare != null && (RE.eatVerb.test(s) || /^\d+$/.test(s))) return out({ type: 'formula', data: withBurp({ ml: bare }) });

  return null;
}
