// handler.js — 로컬 PostgreSQL 대상 통합 테스트 (node --test)
// DATABASE_URL(기본: postgresql://postgres@localhost:54329/babylog) 서버에 전용 DB `uriday_test_handler` 를 만들고
// 그 안에서만 스키마 uriday 를 지우고 마이그레이션을 새로 적용한다 (기본 DB 는 건드리지 않음).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { createHandler, sha256hex, pairId } from '../handler.js';

const BASE = process.env.DATABASE_URL || 'postgresql://postgres@localhost:54329/babylog';
const TEST_DB = 'uriday_test_handler';
const MIGRATION = readFileSync(new URL('../../../migrations/20260928000000_uriday_log.sql', import.meta.url), 'utf8');

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 5, 32, 0); // 2026-09-28 14:32 KST (오후 2:32)
let clock = T0;
let sql;
let handler;

before(async () => {
  const admin = postgres(BASE, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database ${TEST_DB}`);
  } catch (e) {
    if (e.code !== '42P04') throw e; // 이미 있음
  } finally {
    await admin.end();
  }
  const u = new URL(BASE);
  u.pathname = `/${TEST_DB}`;
  sql = postgres(u.toString(), { max: 10, prepare: false, onnotice: () => {} });
  await sql.unsafe('drop schema if exists uriday cascade');
  await sql.unsafe(MIGRATION);
  handler = createHandler({ sql, now: () => clock, salt: 'test-salt' });
});
after(async () => {
  await sql?.end();
});

// ── 도우미 ───────────────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
let ipSeq = 1;
const freshIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

async function api(body, { ip = freshIp(), raw, headers = {} } = {}) {
  const res = await handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers },
      body: raw ?? JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* 텍스트 응답 */
  }
  return { status: res.status, json, text, headers: res.headers };
}
async function quick(params, { method = 'POST', body, contentType, headers = {}, query } = {}) {
  const u = query ? new URL(`http://localhost/api?${query}`) : new URL('http://localhost/api');
  if (!query) {
    u.searchParams.set('a', 'q');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  }
  const init = { method, headers: { ...headers } };
  if (body !== undefined) init.body = body;
  if (contentType) init.headers['content-type'] = contentType;
  const res = await handler(new Request(u, init));
  return { status: res.status, text: await res.text(), headers: res.headers };
}
const ev = (type, data = {}, over = {}) => ({
  id: uuid(), type, ts: clock, by: null, data, deleted: false, updatedAt: clock, rev: 0, dirty: true, ...over,
});

async function makeFamily({ events = [], extra = [] } = {}) {
  const mom = { id: uuid(), name: '엄마', role: 'mom', emoji: '👩', updatedAt: clock };
  const dad = { id: uuid(), name: '아빠', role: 'dad', emoji: '👨', updatedAt: clock };
  if (typeof events === 'function') events = events(mom, dad);
  const r = await api({
    a: 'create',
    family: { name: '하린', birth: '2026-09-05', updatedAt: clock },
    members: [mom, dad, ...extra],
    meId: mom.id,
    events,
  });
  assert.equal(r.status, 200, r.text);
  return { ...r.json, mom, dad, momToken: r.json.token };
}
async function joinAs(invite, claim) {
  const r = await api({ a: 'join', invite, claim });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}
async function joinNew(invite, name = '이모') {
  const r = await api({ a: 'join', invite, me: { name, role: 'other' } });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}
// 이미 기기가 있는 사람의 두 번째 기기: 기존 기기에서 devlink → 새 기기에서 join { device }
async function linkDevice(k) {
  const d = await api({ a: 'devlink', k });
  assert.equal(d.status, 200, d.text);
  const r = await api({ a: 'join', device: d.json.code });
  assert.equal(r.status, 200, r.text);
  return r.json.token;
}
const sync = (k, since = 0, extra = {}) => api({ a: 'sync', k, since, ...extra });
async function pullAll(k) {
  const out = new Map();
  let since = 0;
  for (;;) {
    const r = await sync(k, since);
    assert.equal(r.status, 200, r.text);
    for (const e of r.json.events) out.set(e.id, e);
    since = r.json.rev;
    if (!r.json.more) return out;
  }
}
const dbEvent = async (fid, id) => (await sql`select * from uriday.events where family_id = ${fid} and id = ${id}`)[0];

// ── HTTP 기본 ────────────────────────────────────────────────────────────
test('CORS preflight → 204', async () => {
  const res = await handler(new Request('http://localhost/api', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods'), /POST/);
  assert.match(res.headers.get('access-control-allow-headers'), /content-type/);
  const r = await api({ a: 'nope' });
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
});

test('GET quick → 405 + 한국어 안내 (텍스트)', async () => {
  const r = await quick({ k: 'x'.repeat(43), t: 'pee' }, { method: 'GET' });
  assert.equal(r.status, 405);
  assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.equal(r.text, '단축어에서 방법을 POST로 바꿔 주세요');
  const plain = await handler(new Request('http://localhost/api'));
  assert.equal(plain.status, 405);
});

test('잘못된 JSON → 400, 모르는 동작 → 400', async () => {
  let r = await api(null, { raw: '{"a":"sync",' });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.json).sort(), ['error', 'message', 'ok']);
  assert.equal(r.json.ok, false);
  assert.equal(r.json.error, 'bad_request');
  r = await api(null, { raw: '[1,2]' });
  assert.equal(r.status, 400);
  r = await api(null, { raw: '' });
  assert.equal(r.status, 400);
  r = await api({ a: 'drop_everything' });
  assert.equal(r.status, 400);
  r = await api({ a: 'toString' });
  assert.equal(r.status, 400);
});

test('본문 256KB 초과 → 413 (JSON·quick 모두)', async () => {
  const big = JSON.stringify({ a: 'sync', k: 'x', pad: 'x'.repeat(300 * 1024) });
  let r = await api(null, { raw: big });
  assert.equal(r.status, 413);
  assert.equal(r.json.error, 'too_large');
  r = await api(null, { raw: '{}', headers: { 'content-length': String(10 * 1024 * 1024) } });
  assert.equal(r.status, 413);
  const q = await quick({ k: 'x'.repeat(43), t: 'pee' }, { body: 'x'.repeat(300 * 1024) });
  assert.equal(q.status, 413);
  assert.match(q.headers.get('content-type'), /text\/plain/);
});

test('잘못된 토큰 → 401', async () => {
  for (const k of [undefined, '', 'short', 'x'.repeat(43), 'A'.repeat(42) + '!']) {
    const r = await sync(k);
    assert.equal(r.status, 401, String(k));
    assert.equal(r.json.error, 'unauthorized');
  }
  const q = await quick({ k: 'A'.repeat(43), t: 'pee' });
  assert.equal(q.status, 401);
  assert.match(q.text, /다시 복사/);
});

// ── 가족 만들기 · 초대 · 참여 ───────────────────────────────────────────
test('create → peek → join(claim · 새로) + 토큰은 해시로만 저장', async () => {
  clock = T0;
  let momEvent;
  const f = await makeFamily({ events: (mom) => [(momEvent = ev('pee', {}, { by: mom.id }))] });
  assert.equal(f.ok, true);
  assert.match(f.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(f.invite, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.deepEqual(f.me, { memberId: f.mom.id, isAdmin: true });
  assert.deepEqual(f.family, { id: f.familyId, name: '하린', birth: '2026-09-05', updatedAt: T0 });
  assert.equal(f.rev, 0);
  assert.deepEqual(f.rejected, []);
  assert.deepEqual(
    f.members.map((m) => [m.id, m.name, m.role, m.emoji, m.isAdmin, m.claimed, m.revoked]),
    [
      [f.mom.id, '엄마', 'mom', '👩', true, true, false],
      [f.dad.id, '아빠', 'dad', '👨', false, false, false],
    ],
  );
  // 토큰·초대코드는 sha256 해시만
  const [dev] = await sql`select * from uriday.devices where family_id = ${f.familyId}`;
  assert.equal(dev.token_hash, await sha256hex(f.token));
  const [fam] = await sql`select invite_hash from uriday.families where id = ${f.familyId}`;
  assert.equal(fam.invite_hash, await sha256hex(f.invite));
  const dump = JSON.stringify(await sql`select * from uriday.devices`) + JSON.stringify(await sql`select * from uriday.families`);
  assert.ok(!dump.includes(f.token) && !dump.includes(f.invite));

  // peek: 이름·구성원만 (생일 등 비공개). 하이픈·소문자·링크 형태도 받아 준다
  for (const inv of [f.invite, f.invite.toLowerCase().replace(/(.{4})/g, '$1-'), `https://x.github.io/uridaylog/baby-log/#join=${f.invite}`]) {
    const p = await api({ a: 'peek', invite: inv });
    assert.equal(p.status, 200, p.text);
    assert.deepEqual(p.json.family, { name: '하린' });
    assert.deepEqual(p.json.members.map((m) => [m.name, m.claimed]), [['엄마', true], ['아빠', false]]);
    assert.deepEqual(Object.keys(p.json.members[0]).sort(), ['claimed', 'emoji', 'id', 'name', 'role']);
  }
  const bad = await api({ a: 'peek', invite: 'ZZZZZZZZZZZZZZZZ' });
  assert.equal(bad.status, 404);
  assert.equal(bad.json.error, 'invite_invalid');

  // join: 기존 자리(아빠) 차지
  const j = await api({ a: 'join', invite: f.invite, claim: f.dad.id });
  assert.equal(j.status, 200, j.text);
  assert.match(j.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(j.json.token, f.token);
  assert.equal(j.json.familyId, f.familyId);
  assert.deepEqual(j.json.me, { memberId: f.dad.id, isAdmin: false });
  assert.equal(j.json.rev, 0);
  assert.equal(j.json.members.find((m) => m.id === f.dad.id).claimed, true);

  // join: 새 사람 (id 를 클라이언트가 정해도 됨)
  const auntId = uuid();
  const j2 = await api({ a: 'join', invite: f.invite, me: { id: auntId, name: '이모', role: 'other', emoji: '🙂' } });
  assert.equal(j2.status, 200, j2.text);
  assert.deepEqual(j2.json.me, { memberId: auntId, isAdmin: false });
  assert.equal(j2.json.members.length, 3);
  assert.deepEqual(j2.json.members.at(-1), { id: auntId, name: '이모', role: 'other', emoji: '🙂', updatedAt: 0, isAdmin: false, claimed: true, revoked: false });
  // 새 사람 id 없이 → 서버가 uuid 발급, 이름 비면 역할 이름
  const j3 = await api({ a: 'join', invite: f.invite, me: { name: '', role: 'grandma' } });
  assert.equal(j3.status, 200, j3.text);
  const gm = j3.json.members.find((m) => m.id === j3.json.me.memberId);
  assert.equal(gm.name, '할머니');
  assert.equal(gm.emoji, '👵');

  // 잘못된 참여
  assert.equal((await api({ a: 'join', invite: f.invite })).status, 400);
  assert.equal((await api({ a: 'join', invite: f.invite, claim: uuid() })).status, 400);
  assert.equal((await api({ a: 'join', invite: f.invite, claim: 'not-a-uuid' })).status, 400);
  assert.equal((await api({ a: 'join', invite: 'AAAAAAAAAAAAAAAA', claim: f.dad.id })).status, 404);

  // 새 기기(아빠)가 처음 sync 하면 create 때 올린 기록을 받는다
  const s = await sync(j.json.token, 0);
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.json.events.map((e) => [e.id, e.type, e.by]), [[momEvent.id, 'pee', f.mom.id]]);
});

test('create 입력 검증 + 같은 id 로 재시도(응답 유실)해도 새 가족이 따로 만들어짐', async () => {
  const mom = { id: uuid(), name: '엄마', role: 'mom' };
  const base = { a: 'create', family: { name: '하린', birth: '2026-09-05', updatedAt: clock }, members: [mom], meId: mom.id };
  assert.equal((await api({ ...base, members: [] })).status, 400);
  assert.equal((await api({ ...base, meId: uuid() })).status, 400);
  assert.equal((await api({ ...base, members: [{ ...mom, id: 'x' }] })).status, 400);
  assert.equal((await api({ ...base, members: Array.from({ length: 21 }, () => ({ id: uuid(), role: 'other' })) })).status, 400);
  assert.equal((await api({ ...base, family: 'x' })).status, 400);
  const e = ev('pee', {}, { by: mom.id });
  const a = await api({ ...base, events: [e] });
  const b = await api({ ...base, events: [e] });
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.notEqual(a.json.familyId, b.json.familyId);
  assert.equal((await pullAll(b.json.token)).get(e.id).by, mom.id);
  // 이름·생일 정리: 10자 자르기, 잘못된 생일은 빈 값
  const c = await api({ ...base, family: { name: '가나다라마바사아자차카타', birth: '2026-02-30', updatedAt: clock } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.family.name, '가나다라마바사아자차');
  assert.equal(c.json.family.birth, '');
});

// ── 동기화 ───────────────────────────────────────────────────────────────
test('sync: 양방향 push/pull · LWW · 툼스톤 · 서버 최신본 돌려주기', async () => {
  clock = T0;
  const f = await makeFamily();
  const dadToken = await joinAs(f.invite, f.dad.id);

  // 엄마 → 서버
  const e1 = ev('formula', { ml: 120, burp: 'yes' }, { by: f.mom.id });
  let r = await sync(f.momToken, 0, { push: [e1] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.rejected, []);
  const got1 = r.json.events.find((e) => e.id === e1.id);
  assert.ok(got1.rev > 0);
  assert.deepEqual({ ...got1, rev: 0 }, { id: e1.id, type: 'formula', ts: e1.ts, by: f.mom.id, data: { ml: 120, burp: 'yes' }, deleted: false, updatedAt: e1.updatedAt, rev: 0 });
  assert.equal(r.json.rev, got1.rev);
  assert.equal(r.json.more, false);
  assert.equal(r.json.serverTime, clock);
  assert.deepEqual(r.json.me, { memberId: f.mom.id, isAdmin: true });
  assert.equal(r.json.family.name, '하린');
  assert.equal(r.json.members.length, 2);
  const momCursor = r.json.rev;

  // 서버 → 아빠, 아빠 → 서버
  r = await sync(dadToken, 0);
  assert.deepEqual(r.json.events.map((e) => e.id), [e1.id]);
  const dadCursor = r.json.rev;
  clock += MIN;
  const e2 = ev('pee', {}, { by: f.dad.id });
  r = await sync(dadToken, dadCursor, { push: [e2] });
  assert.deepEqual(r.json.events.map((e) => e.id), [e2.id]);
  // 서버 → 엄마
  r = await sync(f.momToken, momCursor);
  assert.deepEqual(r.json.events.map((e) => [e.id, e.by]), [[e2.id, f.dad.id]]);
  let cursor = r.json.rev;

  // LWW: 더 최신 수정은 반영, 더 오래된 수정은 무시
  clock += MIN;
  const newer = { ...e1, data: { ml: 140, burp: 'yes' }, updatedAt: clock };
  r = await sync(f.momToken, cursor, { push: [newer] });
  const g = r.json.events.find((e) => e.id === e1.id);
  assert.equal(g.data.ml, 140);
  assert.ok(g.rev > got1.rev);
  cursor = r.json.rev;
  const older = { ...e1, data: { ml: 60 }, updatedAt: e1.updatedAt + 1 };
  r = await sync(dadToken, cursor, { push: [older] }); // 아빠 커서가 이미 최신이라도 서버본을 돌려준다
  assert.equal(r.status, 200);
  const back = r.json.events.find((e) => e.id === e1.id);
  assert.equal(back.data.ml, 140, '밀린 기록의 서버 최신본을 돌려줘야 함');
  assert.equal((await dbEvent(f.familyId, e1.id)).data.ml, 140);
  // 같은 updatedAt 은 덮어쓰지 않음
  r = await sync(dadToken, cursor, { push: [{ ...newer, data: { ml: 999 } }] });
  assert.deepEqual(r.json.rejected, [newer.id]); // 999ml 는 범위 밖 → 거부
  r = await sync(dadToken, cursor, { push: [{ ...newer, data: { ml: 100 } }] });
  assert.equal((await dbEvent(f.familyId, e1.id)).data.ml, 140);

  // 툼스톤 (data 없이 삭제만 보내도 됨) → 전파 → 되살리기도 LWW
  clock += MIN;
  r = await sync(f.momToken, cursor, { push: [{ id: e1.id, type: 'formula', ts: e1.ts, by: f.mom.id, deleted: true, updatedAt: clock }] });
  assert.deepEqual(r.json.rejected, []);
  const tomb = r.json.events.find((e) => e.id === e1.id);
  assert.equal(tomb.deleted, true);
  r = await sync(dadToken, 0);
  assert.equal(r.json.events.find((e) => e.id === e1.id).deleted, true);
  clock += MIN;
  r = await sync(dadToken, 0, { push: [{ ...newer, deleted: false, updatedAt: clock }] });
  assert.equal(r.json.events.find((e) => e.id === e1.id).deleted, false);
});

test('sync: 입력 검증 (화이트리스트·키 정리·길이 자르기·범위·jsonb 금지 문자)', async () => {
  const f = await makeFamily();
  const good = [
    ev('formula', { ml: '80', burp: 'maybe', evil: '<script>' }, { by: f.mom.id }),
    ev('breast', { side: 'L', min: 500 }),
    ev('poop', { color: 'yellow', texture: 'watery', extra: 1 }),
    ev('note', { text: '가'.repeat(250) + '\u0000끝', note: 'x'.repeat(150) }),
    ev('med', { name: '해열제\ud800', note: '메'.repeat(80) }),
    ev('temp', { c: 38.25 }),
    ev('sleep', { end: clock + 60 * MIN }),
    ev('thanks', { target: uuid() }),
    ev('handoff', { from: clock - 3 * 60 * MIN, to: clock, note: '오후에 좀 보챘어요' }),
    ev('ack', { target: uuid() }),
    ev('solid', { food: '쌀미음'.repeat(20), amount: 'all', reaction: 'good' }),
    ev('potty', { result: 'pee' }),
    ev('pee', { src: 'hacker' }, { by: uuid() }), // 가족 밖 by → null
    ev('water', { ml: 5000 }), // 선택값 범위 밖 → 키만 버림
  ];
  const badOnes = [
    ev('both'), ev('hack'), ev('PEE'), ev('formula', {}), ev('formula', { ml: 0 }), ev('formula', { ml: 600 }),
    ev('temp', { c: 45 }), ev('potty', { result: 'x' }), ev('note', { text: '   ' }), ev('thanks', { target: 'x' }),
    ev('ack', {}), ev('handoff', { from: 1 }), ev('pee', {}, { ts: 'yesterday' }), ev('pee', {}, { updatedAt: null }),
    { ...ev('pee'), id: 'not-a-uuid' },
  ];
  const r = await sync(f.momToken, 0, { push: [...good, ...badOnes, 'garbage', null] });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(new Set(r.json.rejected), new Set(badOnes.map((e) => e.id)));
  const by = new Map(r.json.events.map((e) => [e.id, e]));
  assert.equal(by.size, good.length);
  const d = (i) => by.get(good[i].id).data;
  assert.deepEqual(d(0), { ml: 80 });
  assert.equal(by.get(good[0].id).by, f.mom.id);
  assert.deepEqual(d(1), { side: 'L' });
  assert.deepEqual(d(2), { color: 'yellow', texture: 'watery' });
  assert.equal(Array.from(d(3).text).length, 200);
  assert.ok(!d(3).text.includes('\u0000'));
  assert.equal(d(3).note.length, 100);
  assert.equal(d(4).name, '해열제�');
  assert.equal(d(4).note.length, 60);
  assert.deepEqual(d(5), { c: 38.3 });
  assert.deepEqual(d(6), { end: clock + 60 * MIN });
  assert.equal(d(8).from, clock - 3 * 60 * MIN);
  assert.equal(d(8).note, '오후에 좀 보챘어요');
  assert.equal(d(10).food.length, 30);
  assert.deepEqual(d(12), {});
  assert.equal(by.get(good[12].id).by, null);
  assert.deepEqual(d(13), {});
  // 배열 한도
  const tooMany = Array.from({ length: 501 }, () => ev('pee'));
  const r2 = await sync(f.momToken, 0, { push: tooMany });
  assert.equal(r2.status, 413);
  const r3 = await sync(f.momToken, 0, { members: Array.from({ length: 21 }, () => ({ id: uuid(), role: 'other' })) });
  assert.equal(r3.status, 400);
  assert.equal((await sync(f.momToken, 0, { push: 'x' })).status, 400);
  assert.equal((await sync(f.momToken, -1)).status, 400);
  assert.equal((await sync(f.momToken, 'abc')).status, 400);
  // 같은 id 두 번 → 최신 것만
  const dupe = ev('pee');
  const r4 = await sync(f.momToken, 0, { push: [dupe, { ...dupe, type: 'poop', updatedAt: dupe.updatedAt + 5 }] });
  assert.equal(r4.status, 200, r4.text);
  assert.equal((await dbEvent(f.familyId, dupe.id)).type, 'poop');
});

test('sync: 구성원 패치(LWW, 자리표시 추가, 권한 필드 무시) · 가족 정보 LWW · 커서 리셋', async () => {
  clock = T0;
  const f = await makeFamily();
  const gma = { id: uuid(), name: '할머니', role: 'grandma', emoji: '👵', updatedAt: clock, isAdmin: true, revoked: true };
  let r = await sync(f.momToken, 0, { members: [gma, { ...f.dad, name: '아빠2', updatedAt: clock + 1 }] });
  assert.equal(r.status, 200, r.text);
  const g = r.json.members.find((m) => m.id === gma.id);
  assert.deepEqual(g, { id: gma.id, name: '할머니', role: 'grandma', emoji: '👵', updatedAt: clock, isAdmin: false, claimed: false, revoked: false });
  assert.equal(r.json.members.find((m) => m.id === f.dad.id).name, '아빠2');
  r = await sync(f.momToken, 0, { members: [{ ...f.dad, name: '옛날이름', updatedAt: clock - 1 }] });
  assert.equal(r.json.members.find((m) => m.id === f.dad.id).name, '아빠2');
  // 긴 ZWJ 이모지·긴 이름·모르는 역할
  r = await sync(f.momToken, 0, { members: [{ id: gma.id, name: '할머니할머니할머니할머니할머니', role: 'boss', emoji: '👨‍👩‍👧‍👦👨‍👩‍👧‍👦', updatedAt: clock + 5 }] });
  const g2 = r.json.members.find((m) => m.id === gma.id);
  assert.equal(g2.name.length, 12);
  assert.equal(g2.role, 'other');
  assert.equal(g2.emoji, '👨‍👩‍👧‍👦');
  // 가족 정보 LWW
  r = await sync(f.momToken, 0, { family: { name: '하린이', birth: '2026-09-06', updatedAt: clock + 10 } });
  assert.deepEqual(r.json.family, { id: f.familyId, name: '하린이', birth: '2026-09-06', updatedAt: clock + 10 });
  r = await sync(f.momToken, 0, { family: { name: '옛이름', birth: '2026-01-01', updatedAt: clock + 9 } });
  assert.equal(r.json.family.name, '하린이');
  // 형식이 틀린 생일은 무시(기존 값 유지), 이름만 보낸 패치는 생일을 건드리지 않음
  r = await sync(f.momToken, 0, { family: { name: '하린', birth: '2026-9-6', updatedAt: clock + 11 } });
  assert.deepEqual([r.json.family.name, r.json.family.birth], ['하린', '2026-09-06']);
  r = await sync(f.momToken, 0, { family: { name: '하린', updatedAt: clock + 12 } });
  assert.equal(r.json.family.birth, '2026-09-06');
  // 기기별 활동 정보(last_seen)는 응답에 절대 없다
  assert.ok(!/last_?seen/i.test(r.text));
  // 이 가족에 없는 커서(since) → 처음부터 다시
  const e = ev('pee');
  await sync(f.momToken, 0, { push: [e] });
  r = await sync(f.momToken, 9e12);
  assert.equal(r.json.reset, true);
  assert.ok(r.json.events.some((x) => x.id === e.id));
});

test('rev 단조 증가 · 1000개 페이지 (more=true)', async () => {
  const f = await makeFamily();
  const ids = [];
  for (let b = 0; b < 3; b++) {
    const batch = Array.from({ length: 500 }, (_, i) => ev('pee', {}, { ts: clock + b * 500 + i }));
    ids.push(...batch.map((e) => e.id));
    const r = await sync(f.momToken, 0, { push: batch });
    assert.equal(r.status, 200, r.text);
  }
  const p1 = await sync(f.momToken, 0);
  assert.equal(p1.json.events.length, 1000);
  assert.equal(p1.json.more, true);
  assert.equal(p1.json.rev, p1.json.events.at(-1).rev);
  const p2 = await sync(f.momToken, p1.json.rev);
  assert.equal(p2.json.events.length, 500);
  assert.equal(p2.json.more, false);
  const revs = [...p1.json.events, ...p2.json.events].map((e) => e.rev);
  for (let i = 1; i < revs.length; i++) assert.ok(revs[i] > revs[i - 1], 'rev 는 엄격히 증가');
  assert.deepEqual(new Set([...p1.json.events, ...p2.json.events].map((e) => e.id)), new Set(ids));
  const p3 = await sync(f.momToken, p2.json.rev);
  assert.deepEqual(p3.json.events, []);
  assert.equal(p3.json.rev, p2.json.rev);
});

test('가족 간 격리: 다른 가족 기록 id 를 덮어쓸 수 없고, 다른 가족 구성원 by 는 null', async () => {
  const A = await makeFamily();
  const B = await makeFamily();
  const e = ev('formula', { ml: 120 }, { by: A.mom.id });
  await sync(A.momToken, 0, { push: [e] });
  // B 가 같은 id, 더 최신 updatedAt 으로 밀어 넣기 + A 구성원을 by 로
  const r = await sync(B.momToken, 0, { push: [{ ...e, data: { ml: 10 }, updatedAt: e.updatedAt + 1000, by: A.mom.id }] });
  assert.equal(r.status, 200, r.text);
  const inB = r.json.events.find((x) => x.id === e.id);
  assert.equal(inB.by, null);
  assert.equal(inB.data.ml, 10);
  const inA = await dbEvent(A.familyId, e.id);
  assert.equal(inA.data.ml, 120);
  assert.equal(inA.member_id, A.mom.id);
  const aPull = await pullAll(A.momToken);
  assert.equal(aPull.get(e.id).data.ml, 120);
  assert.equal(aPull.size, 1);
  // B 는 A 의 구성원을 패치할 수 없다 (B 가족 안에 같은 id 의 새 자리가 생길 뿐)
  await sync(B.momToken, 0, { members: [{ ...A.dad, name: '해커', updatedAt: Date.now() + 1e6 }] });
  const [aDad] = await sql`select name from uriday.members where family_id = ${A.familyId} and id = ${A.dad.id}`;
  assert.equal(aDad.name, '아빠');
});

// ── 관리 ─────────────────────────────────────────────────────────────────
test('관리자 전용 403 · 나 자신 내보내기 금지 · 내보낸 사람 401 · 관리자 지정/해제 · 초대 갱신 · leave', async () => {
  const f = await makeFamily();
  const dadToken = await joinAs(f.invite, f.dad.id);
  const dad2 = await linkDevice(dadToken); // 아빠의 두 번째 기기 (기기 연결 코드로)
  // 아빠(관리자 아님) → 403
  for (const body of [{ a: 'invite' }, { a: 'remove', memberId: f.mom.id }, { a: 'admin', memberId: f.dad.id, on: true }]) {
    const r = await api({ ...body, k: dadToken });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.json.error, 'forbidden');
  }
  // 나 자신 내보내기 금지
  let r = await api({ a: 'remove', k: f.momToken, memberId: f.mom.id });
  assert.equal(r.status, 403);
  // 마지막 관리자 해제 금지
  r = await api({ a: 'admin', k: f.momToken, memberId: f.mom.id, on: false });
  assert.equal(r.status, 400);
  // 초대 링크 새로 만들기 → 옛 링크는 끝
  r = await api({ a: 'invite', k: f.momToken });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.invite, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.equal((await api({ a: 'peek', invite: f.invite })).status, 404);
  const invite2 = r.json.invite;
  assert.equal((await api({ a: 'peek', invite: invite2 })).status, 200);
  // 관리자 지정
  r = await api({ a: 'admin', k: f.momToken, memberId: f.dad.id, on: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.members.find((m) => m.id === f.dad.id).isAdmin, true);
  assert.equal((await api({ a: 'invite', k: dadToken })).status, 200);
  r = await api({ a: 'admin', k: dadToken, memberId: f.dad.id, on: false });
  assert.equal(r.status, 200);
  const invite3 = (await api({ a: 'invite', k: f.momToken })).json.invite;
  // 내보내기 → 그 사람의 모든 기기 401, 목록엔 revoked 로 남음(과거 기록 표시용), peek 에선 빠짐, 다시 차지 불가
  r = await api({ a: 'remove', k: f.momToken, memberId: f.dad.id });
  assert.equal(r.status, 200, r.text);
  const dadRow = r.json.members.find((m) => m.id === f.dad.id);
  assert.equal(dadRow.revoked, true);
  assert.equal(dadRow.claimed, false);
  for (const k of [dadToken, dad2]) {
    assert.equal((await sync(k, 0)).status, 401);
    assert.equal((await quick({ k, t: 'pee' })).status, 401);
    assert.equal((await api({ a: 'leave', k })).status, 401);
  }
  // 내보내면 초대 코드도 바뀐다 → 내보낸 사람이 갖고 있던 옛 링크로 '새 사람'이 되어 다시 들어올 수 없음
  const invite4 = r.json.invite;
  assert.match(invite4, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.notEqual(invite4, invite3);
  assert.equal((await api({ a: 'peek', invite: invite3 })).status, 404);
  assert.equal((await api({ a: 'join', invite: invite3, me: { name: '아빠', role: 'dad' } })).status, 404);
  const p = await api({ a: 'peek', invite: invite4 });
  assert.ok(!p.json.members.some((m) => m.id === f.dad.id));
  r = await api({ a: 'join', invite: invite4, claim: f.dad.id });
  assert.equal(r.status, 403);
  assert.equal((await api({ a: 'remove', k: f.momToken, memberId: uuid() })).status, 400);
  // 내보낸 사람의 옛 기록 by 는 그대로 받아 준다
  const old = ev('pee', {}, { by: f.dad.id });
  r = await sync(f.momToken, 0, { push: [old] });
  assert.equal(r.json.events.find((e) => e.id === old.id).by, f.dad.id);
  // leave: 이 기기만 끊김
  const aunt = await api({ a: 'join', invite: invite4, me: { name: '이모', role: 'other' } });
  const auntToken = aunt.json.token;
  r = await api({ a: 'leave', k: auntToken });
  assert.deepEqual(r.json, { ok: true });
  assert.equal((await sync(auntToken, 0)).status, 401);
  const after = await sync(f.momToken, 0);
  assert.equal(after.json.members.find((m) => m.id === aunt.json.me.memberId).claimed, false);
});

// ── 초대 링크 차지 제한 · 내 다른 기기 연결 (devlink) ───────────────────────
const CLAIMED_MSG = '이미 다른 기기에서 쓰는 사람이에요. 그 기기의 설정 > "내 다른 기기 연결"로 연결해 주세요.';
const DEVICE_MSG = '기기 연결 코드가 만료됐거나 이미 사용됐어요. 새로 만들어 주세요.';

test('join claim: 기기 없는 자리만 차지 가능, 이미 쓰는 사람(엄마·관리자)은 403', async () => {
  clock = T0;
  const f = await makeFamily();
  // 엄마(관리자, 기기 있음) 가로채기 시도 → 403 — claim 으로도, me.id 로도
  for (const body of [{ claim: f.mom.id }, { me: { id: f.mom.id, name: '엄마', role: 'mom' } }]) {
    const r = await api({ a: 'join', invite: f.invite, ...body });
    assert.equal(r.status, 403, r.text);
    assert.deepEqual(r.json, { ok: false, error: 'forbidden', message: CLAIMED_MSG });
  }
  // 아빠(자리표시, 기기 없음) → 차지 OK
  const dadToken = await joinAs(f.invite, f.dad.id);
  let p = await api({ a: 'peek', invite: f.invite });
  assert.deepEqual(p.json.members.map((m) => [m.id, m.claimed]), [[f.mom.id, true], [f.dad.id, true]]);
  // 아빠는 이제 기기가 있으니 두 번째 차지 → 403
  let r = await api({ a: 'join', invite: f.invite, claim: f.dad.id });
  assert.equal(r.status, 403);
  assert.equal(r.json.message, CLAIMED_MSG);
  r = await api({ a: 'join', invite: f.invite, me: { id: f.dad.id, name: '아빠', role: 'dad' } });
  assert.equal(r.status, 403);
  // 아빠 기기가 '공유 끊기'를 하면 다시 자리표시 → 다시 차지할 수 있음
  assert.equal((await api({ a: 'leave', k: dadToken })).status, 200);
  p = await api({ a: 'peek', invite: f.invite });
  assert.equal(p.json.members.find((m) => m.id === f.dad.id).claimed, false);
  const dadAgain = await joinAs(f.invite, f.dad.id);
  assert.equal((await sync(dadAgain, 0)).json.me.memberId, f.dad.id);
  // DB 확인: 엄마에게는 여전히 기기 1대뿐
  const [c] = await sql`select count(*)::int as n from uriday.devices where family_id = ${f.familyId} and member_id = ${f.mom.id}`;
  assert.equal(c.n, 1);
});

test('devlink → peek(안 씀) → join{device} → 같은 사람 토큰 · 재사용·만료·새 코드·내보낸 사람 → 404/401', async () => {
  clock = T0;
  const f = await makeFamily();
  // 발급: 16자 Crockford, 15분, 해시만 저장
  let d = await api({ a: 'devlink', k: f.momToken });
  assert.equal(d.status, 200, d.text);
  assert.deepEqual(Object.keys(d.json).sort(), ['code', 'expiresAt', 'ok']);
  assert.match(d.json.code, /^[0-9A-HJKMNP-TV-Z]{16}$/);
  assert.equal(d.json.expiresAt, T0 + 15 * MIN);
  const code = d.json.code;
  const rows = await sql`select * from uriday.device_links where family_id = ${f.familyId}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code_hash, await sha256hex(code));
  assert.ok(!JSON.stringify(rows).includes(code));
  assert.equal((await api({ a: 'devlink', k: 'x'.repeat(43) })).status, 401);

  // peek: 코드만 / 링크 / 소문자·하이픈 / invite 칸에 #dev= 링크 — 어느 쪽이든 그 사람을 보여 주고 코드는 쓰지 않는다
  for (const body of [
    { device: code },
    { device: `https://x.github.io/uridaylog/baby-log/#dev=${code}` },
    { device: code.toLowerCase().replace(/(.{4})/g, '$1-') },
    { invite: `https://x.github.io/uridaylog/baby-log/#dev=${code}` },
  ]) {
    const p = await api({ a: 'peek', ...body });
    assert.equal(p.status, 200, `${JSON.stringify(body)} ${p.text}`);
    assert.deepEqual(p.json, { ok: true, family: { name: '하린' }, member: { id: f.mom.id, name: '엄마', role: 'mom', emoji: '👩' } });
  }
  // 초대코드를 device 로 보내면(또는 반대) 안 됨
  assert.equal((await api({ a: 'peek', device: f.invite })).status, 404);
  assert.equal((await api({ a: 'join', invite: code, me: { name: 'x', role: 'other' } })).status, 404);

  // join: 코드를 만든 그 사람(엄마·관리자)으로 새 기기 연결
  clock = T0 + 14 * MIN;
  const j = await api({ a: 'join', device: `#dev=${code}` });
  assert.equal(j.status, 200, j.text);
  assert.deepEqual(Object.keys(j.json).sort(), ['family', 'familyId', 'me', 'members', 'ok', 'rev', 'token']);
  assert.deepEqual(j.json.me, { memberId: f.mom.id, isAdmin: true });
  assert.equal(j.json.familyId, f.familyId);
  assert.equal(j.json.rev, 0);
  assert.notEqual(j.json.token, f.momToken);
  const newTok = j.json.token;
  const s = await sync(newTok, 0, { push: [ev('pee', {}, { by: f.mom.id })] });
  assert.equal(s.status, 200, s.text);
  assert.deepEqual(s.json.me, { memberId: f.mom.id, isAdmin: true });
  assert.match((await quick({ k: newTok, t: 'pee' })).text, /· 엄마\n/);
  assert.equal((await sync(f.momToken, 0)).status, 200, '원래 기기도 그대로');
  // 재사용 → 404 (peek·join 모두)
  for (const a of ['join', 'peek']) {
    const r = await api({ a, device: code });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { ok: false, error: 'invite_invalid', message: DEVICE_MSG });
  }
  assert.equal((await api({ a: 'join', device: 'not a code' })).status, 404);

  // 만료: 15분이 지나면 404
  clock = T0 + 60 * MIN;
  d = await api({ a: 'devlink', k: f.momToken });
  clock += 15 * MIN; // 정확히 만료 시각
  assert.equal((await api({ a: 'peek', device: d.json.code })).status, 404);
  assert.equal((await api({ a: 'join', device: d.json.code })).status, 404);

  // 새 코드를 만들면 이전(안 쓴) 코드는 무효
  const a1 = (await api({ a: 'devlink', k: f.momToken })).json.code;
  const a2 = (await api({ a: 'devlink', k: newTok })).json.code; // 같은 사람(엄마)의 다른 기기에서 만들어도
  assert.equal((await api({ a: 'join', device: a1 })).status, 404);
  assert.equal((await api({ a: 'join', device: a2 })).status, 200);

  // 동시에 같은 코드로 두 기기가 연결 시도 → 하나만 성공
  const c2 = (await api({ a: 'devlink', k: f.momToken })).json.code;
  const both = await Promise.all([api({ a: 'join', device: c2 }), api({ a: 'join', device: c2 })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 404]);

  // 내보낸 사람: 만들어 둔 코드는 404, 그 사람 기기의 devlink 는 401
  const dadToken = await joinAs(f.invite, f.dad.id);
  const dadCode = (await api({ a: 'devlink', k: dadToken })).json.code;
  assert.equal((await api({ a: 'peek', device: dadCode })).status, 200);
  assert.equal((await api({ a: 'remove', k: f.momToken, memberId: f.dad.id })).status, 200);
  assert.equal((await api({ a: 'peek', device: dadCode })).status, 404);
  assert.equal((await api({ a: 'join', device: dadCode })).status, 404);
  assert.equal((await api({ a: 'devlink', k: dadToken })).status, 401);
  // 기기 연결 코드는 내보낸 사람을 되살리지 못한다 (혹시 코드 행이 남아 있어도 구성원 revoked 를 확인)
  const stray = 'ABCDEFGHJKMNPQRS';
  await sql`insert into uriday.device_links (code_hash, family_id, member_id, expires_at)
            values (${await sha256hex(stray)}, ${f.familyId}, ${f.dad.id}, ${clock + 10 * MIN})`;
  assert.equal((await api({ a: 'peek', device: stray })).status, 404);
  assert.equal((await api({ a: 'join', device: stray })).status, 404);
  const [cnt] = await sql`select count(*)::int as n from uriday.devices where family_id = ${f.familyId} and member_id = ${f.dad.id} and revoked_at is null`;
  assert.equal(cnt.n, 0);
});

test('unlink(관리자): 내보내지 않고 기기만 모두 끊기 → 옛 토큰 401 · 다시 차지 가능 · 기록 by 유지', async () => {
  clock = T0;
  const f = await makeFamily();
  const dadToken = await joinAs(f.invite, f.dad.id);
  const dad2 = await linkDevice(dadToken); // 아빠 두 번째 기기
  const pendingCode = (await api({ a: 'devlink', k: dadToken })).json.code; // 아직 안 쓴 연결 코드
  const dadEvent = ev('formula', { ml: 90 }, { by: f.dad.id });
  assert.equal((await sync(dadToken, 0, { push: [dadEvent] })).status, 200);

  // 관리자가 아니면 403, 나 자신은 403(안내 문구), 잘못된 대상은 400
  let r = await api({ a: 'unlink', k: dadToken, memberId: f.mom.id });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, 'forbidden');
  r = await api({ a: 'unlink', k: f.momToken, memberId: f.mom.id });
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { ok: false, error: 'forbidden', message: '내 기기 연결은 설정 > 이 기기 공유 끊기로 해 주세요' });
  assert.equal((await api({ a: 'unlink', k: f.momToken })).status, 400);
  assert.equal((await api({ a: 'unlink', k: f.momToken, memberId: uuid() })).status, 400);

  // 끊기
  r = await api({ a: 'unlink', k: f.momToken, memberId: f.dad.id });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ['members', 'ok']);
  const dadRow = r.json.members.find((m) => m.id === f.dad.id);
  assert.equal(dadRow.revoked, false);
  assert.equal(dadRow.claimed, false);
  for (const k of [dadToken, dad2]) {
    assert.equal((await sync(k, 0)).status, 401);
    assert.equal((await quick({ k, t: 'pee' })).status, 401);
  }
  assert.equal((await api({ a: 'join', device: pendingCode })).status, 404);
  const p = await api({ a: 'peek', invite: f.invite });
  assert.deepEqual(p.json.members.find((m) => m.id === f.dad.id).claimed, false);
  // 다시 초대 링크로 아빠 자리 차지 → 옛 기록의 by 그대로
  const again = await joinAs(f.invite, f.dad.id);
  const s = await sync(again, 0);
  assert.equal(s.json.me.memberId, f.dad.id);
  assert.equal(s.json.events.find((e) => e.id === dadEvent.id).by, f.dad.id);
  // 한 번 더 끊어도(이미 끊긴 사람 포함) 문제없음
  assert.equal((await api({ a: 'unlink', k: f.momToken, memberId: f.dad.id })).status, 200);
  assert.equal((await api({ a: 'unlink', k: f.momToken, memberId: f.dad.id })).status, 200);
  assert.equal((await sync(again, 0)).status, 401);
});

// ── quick (단축어) ───────────────────────────────────────────────────────
test('quick: 모든 종류 + 본문 형식 무관 + 토큰 위치·공백 무관', async () => {
  clock = T0; // 오후 2:32 KST
  const f = await makeFamily();
  const k = f.momToken;
  const ok = async (params, opts) => {
    const r = await quick(params, opts);
    assert.equal(r.status, 200, `${JSON.stringify(params)} → ${r.status} ${r.text}`);
    assert.match(r.headers.get('content-type'), /^text\/plain; charset=utf-8/);
    return r.text;
  };
  assert.equal(await ok({ k, t: 'pee' }), '✓ 소변 기록 · 오후 2:32 · 엄마\n오늘 소변 1번째');
  // 빈 본문 / JSON / form / 아무 텍스트 / multipart — 모두 쿼리대로
  assert.match(await ok({ k, t: 'pee' }, { body: '', contentType: 'application/json' }), /오늘 소변 2번째/);
  assert.match(await ok({ k, t: 'pee' }, { body: '{"foo":1}', contentType: 'application/json' }), /오늘 소변 3번째/);
  assert.match(await ok({ k, t: 'pee' }, { body: 'x=1&y=2', contentType: 'application/x-www-form-urlencoded' }), /오늘 소변 4번째/);
  assert.match(await ok({ k, t: 'pee' }, { body: 'hello 🙂', contentType: 'text/plain' }), /오늘 소변 5번째/);
  const fd = new FormData();
  fd.set('memo', 'x');
  assert.match(await ok({ k, t: 'pee' }, { body: fd }), /오늘 소변 6번째/);
  // 토큰이 URL 맨 끝 + 줄바꿈이 붙어 와도
  assert.match(await ok({}, { query: `a=q&t=pee&k=${encodeURIComponent(k + '\n')}` }), /오늘 소변 7번째/);
  assert.match(await ok({}, { query: `t=pee&k=${k}%20%0A&a=q` }), /오늘 소변 8번째/);
  // 토큰·종류를 본문(JSON)으로
  assert.match(await ok({}, { query: 'a=q', body: JSON.stringify({ k, t: 'pee' }), contentType: 'application/json' }), /9번째/);
  assert.match(await ok({}, { query: 'a=q', body: `k=${k}&t=pee`, contentType: 'application/x-www-form-urlencoded' }), /10번째/);
  // 헤더 토큰
  assert.match(await ok({ t: 'pee' }, { headers: { 'x-bl-key': k } }), /11번째/);
  // JSON API 경로로 a:'q'
  const viaJson = await api({ a: 'q', k, t: 'pee' });
  assert.equal(viaJson.status, 200);
  assert.match(viaJson.text, /12번째/);

  assert.equal(await ok({ k, t: 'poop', color: '노랑', texture: 'watery' }), '✓ 대변(노랑·묽음) 기록 · 오후 2:32 · 엄마\n오늘 대변 1번째');
  assert.match(await ok({ k, t: 'poop', color: 'white' }), /^✓ 대변\(흰색·회색\) 기록[^\n]*\n오늘 대변 2번째\n⚠️ 흰색·회색 변은 바로 소아과/);
  assert.match(await ok({ k, t: 'poop', color: '회색' }), /대변\(흰색·회색\)/);
  assert.equal(await ok({ k, t: 'both' }), '✓ 소변·대변 기록 · 오후 2:32 · 엄마\n오늘 소변 13번째 · 대변 4번째');
  // 분유: 처음엔 100ml 기본, 보낸 양, 다음엔 마지막 양
  assert.equal(await ok({ k, t: 'formula' }), '✓ 분유 100ml 기록 · 오후 2:32 · 엄마\n오늘 수유 1번째 · 총 100ml');
  assert.equal(await ok({ k, t: 'formula', ml: 120 }), '✓ 분유 120ml 기록 · 오후 2:32 · 엄마\n오늘 수유 2번째 · 총 220ml');
  assert.match(await ok({ k, t: 'formula' }), /^✓ 분유 120ml 기록/);
  assert.equal((await quick({ k, t: 'formula', ml: 900 })).status, 400);
  assert.match(await ok({ k, t: 'pumped', ml: 80 }), /^✓ 유축 수유 80ml 기록 .*\n오늘 수유 4번째 · 총 420ml$/);
  assert.match(await ok({ k, t: 'breast', side: 'L', min: 10 }), /^✓ 모유 왼쪽 10분 기록 · 오후 2:32 · 엄마\n오늘 수유 5번째 · 총 420ml$/);
  assert.match(await ok({ k, t: 'breast' }), /^✓ 모유 양쪽 기록/);
  assert.match(await ok({ k, t: 'bath' }), /^✓ 목욕 기록 · 오후 2:32 · 엄마\n오늘 목욕 1번째$/);
  assert.match(await ok({ k, t: 'tummy' }), /^✓ 터미타임 5분 기록/);
  assert.match(await ok({ k, t: 'brush' }), /^✓ 양치 기록/);
  assert.match(await ok({ k, t: 'water', ml: 50 }), /^✓ 물 50ml 기록/);
  assert.match(await ok({ k, t: 'note', text: '오후에 좀 보챘어요' }), /^✓ 메모 기록/);
  assert.equal((await quick({ k, t: 'note' })).status, 400);
  assert.match(await ok({ k, t: 'temp', c: 38.2 }), /^✓ 체온 38\.2℃ 기록[^\n]*\n오늘 체온 1번째\n⚠️ 3개월 미만/);
  assert.match(await ok({ k, t: 'med', name: '해열제' }), /^✓ 약\(해열제\) 기록/);
  assert.match(await ok({ k, t: 'potty', result: 'pee' }), /^✓ 변기 쉬 성공 기록/);
  assert.match(await ok({ k, t: 'solid', food: '쌀미음', amount: 'half' }), /^✓ 이유식 기록/);
  for (const t of ['thanks', 'handoff', 'ack', 'hack', '']) {
    const r = await quick({ k, t });
    assert.equal(r.status, 400, t);
  }
  // 기록 내용 확인: src·by·updatedAt
  const all = [...(await pullAll(k)).values()];
  const pee = all.find((e) => e.type === 'pee');
  assert.equal(pee.by, f.mom.id);
  assert.equal(pee.data.src, 'shortcut');
  assert.equal(pee.ts, T0);
  assert.equal(pee.updatedAt, T0);
  assert.equal(all.find((e) => e.type === 'poop' && e.data.color === 'yellow').data.texture, 'watery');
  // 알림(src=notif) + 같은 id 재전송은 한 번만
  const id = uuid();
  assert.match(await ok({ k, t: 'pee', src: 'notif', id }), /^✓ 소변 기록/);
  assert.match(await ok({ k, t: 'pee', src: 'notif', id }), /^✓ 이미 기록돼 있어요/);
  const again = await pullAll(k);
  assert.equal(again.get(id).data.src, 'notif');
  assert.equal([...again.values()].filter((e) => e.id === id).length, 1);

  // 'both' + id: 대변 id 는 pairId(id) (앱 수신함과 같은 계산) → 응답 유실 후 앱이 수신함으로 다시 올려도 중복 없음
  const bid = uuid();
  assert.match(await ok({ k, t: 'both', src: 'notif', id: bid }), /^✓ 소변·대변 기록/);
  const pid = pairId(bid);
  const ids = new Set((await pullAll(k)).keys());
  assert.ok(ids.has(bid) && ids.has(pid), '소변 = id, 대변 = pairId(id)');
  assert.match(await ok({ k, t: 'both', src: 'notif', id: bid }), /^✓ 이미 기록돼 있어요/);
  // 앱 수신함 경로: 같은 두 id 를 sync 로 올려도 새 기록이 생기지 않음 (LWW 로 기존 것 유지)
  const before = (await sql`select count(*)::int as n from uriday.events where family_id = ${f.familyId}`)[0].n;
  const r = await sync(k, 0, { push: [ev('pee', { src: 'notif' }, { id: bid, updatedAt: T0 }), ev('poop', { src: 'notif' }, { id: pid, updatedAt: T0 })] });
  assert.equal(r.status, 200, r.text);
  const after_ = (await sql`select count(*)::int as n from uriday.events where family_id = ${f.familyId}`)[0].n;
  assert.equal(after_, before);
});

test('pairId: 결정적 · uuid 모양 유지 · 두 번 적용하면 원래 id · 대문자 입력도 소문자로', () => {
  const id = '0f8e1c2a-3b4d-4e5f-8a6b-0123456789ab';
  assert.equal(pairId(id), '0f8e1c2a-3b4d-4e5f-8a6b-fedcba987654');
  assert.equal(pairId(pairId(id)), id);
  assert.equal(pairId(id.toUpperCase()), pairId(id));
  assert.match(pairId('nope'), /^[0-9a-f-]{36}$/);
});

test('quick: 트림 붙이기(90분 안 마지막 수유) · 잠 토글(시간 계산) · 서울 날짜 경계', async () => {
  clock = Date.UTC(2026, 8, 28, 12, 0); // 21:00 KST
  const f = await makeFamily();
  const k = f.momToken;
  const dadToken = await joinAs(f.invite, f.dad.id);
  await quick({ k, t: 'formula', ml: 120 });
  const s0 = await sync(dadToken, 0);
  const feed = s0.json.events.find((e) => e.type === 'formula');
  const cursor = s0.json.rev;
  clock += 15 * MIN; // 21:15
  let r = await quick({ k: dadToken, t: 'burp' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.text, '✓ 트림 기록 · 오후 9:15 · 아빠\n오늘 트림 1번째 · 오후 9:00 분유에 표시');
  let s = await sync(k, cursor);
  const bumped = s.json.events.find((e) => e.id === feed.id);
  assert.deepEqual(bumped.data, { ml: 120, src: 'shortcut', burp: 'yes' });
  assert.ok(bumped.rev > feed.rev);
  assert.ok(bumped.updatedAt > feed.updatedAt);
  assert.ok(!s.json.events.some((e) => e.type === 'burp'), '붙였으면 따로 트림 기록은 없음');
  // 이미 트림 값이 있으면 따로 기록
  r = await quick({ k, t: 'burp' });
  assert.equal(r.text, '✓ 트림 기록 · 오후 9:15 · 엄마\n오늘 트림 2번째');
  // 90분 넘은 수유엔 안 붙임
  clock += 10 * MIN;
  await quick({ k, t: 'breast', side: 'R' }); // 21:25
  clock += 91 * MIN; // 22:56
  r = await quick({ k, t: 'burp' });
  assert.match(r.text, /^✓ 트림 기록 · 오후 10:56 · 엄마\n오늘 트림 3번째$/);
  const breast = [...(await pullAll(k)).values()].find((e) => e.type === 'breast');
  assert.ok(!('burp' in breast.data));

  // 잠 토글: 23:00 시작 → 00:12 끝 (1시간 12분)
  clock = Date.UTC(2026, 8, 28, 14, 0); // 23:00 KST
  r = await quick({ k, t: 'sleep' });
  assert.equal(r.text, '✓ 잠 시작 · 오후 11:00 · 엄마\n😴 깨면 한 번 더 기록하면 끝나요');
  clock = Date.UTC(2026, 8, 28, 15, 12); // 다음날 00:12 KST
  r = await quick({ k: dadToken, t: 'sleep' });
  assert.equal(r.text, '✓ 잠 끝 (1시간 12분) · 오전 12:12 · 아빠\n😴 1시간 12분 잤어요');
  const sleeps = [...(await pullAll(k)).values()].filter((e) => e.type === 'sleep');
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0].data.end, clock);
  assert.equal(sleeps[0].ts, Date.UTC(2026, 8, 28, 14, 0));
  r = await quick({ k, t: 'sleep' }); // 다시 누르면 새 잠 시작
  assert.match(r.text, /^✓ 잠 시작/);
  // 24시간 넘게 열린 잠은 끝내지 않고 새로 시작
  clock += 25 * 60 * MIN;
  r = await quick({ k, t: 'sleep' });
  assert.match(r.text, /^✓ 잠 시작/);

  // 서울 날짜 경계: 23:50 KST 소변은 전날, 00:10 KST 소변은 새 날의 1번째
  const g = await makeFamily();
  clock = Date.UTC(2026, 9, 1, 14, 50); // 10/1 23:50 KST
  assert.equal((await quick({ k: g.momToken, t: 'pee' })).text, '✓ 소변 기록 · 오후 11:50 · 엄마\n오늘 소변 1번째');
  assert.match((await quick({ k: g.momToken, t: 'pee' })).text, /오늘 소변 2번째$/);
  clock = Date.UTC(2026, 9, 1, 15, 10); // 10/2 00:10 KST
  assert.equal((await quick({ k: g.momToken, t: 'pee' })).text, '✓ 소변 기록 · 오전 12:10 · 엄마\n오늘 소변 1번째');
  // 과거 시각(ts) 기록은 그날 기준
  assert.equal((await quick({ k: g.momToken, t: 'pee', ts: Date.UTC(2026, 9, 1, 3, 0) })).text, '✓ 소변 기록 · 오후 12:00 · 엄마\n10/1 소변 1번째');
});

test('quick: say(받아쓰기) 해석', async () => {
  clock = T0;
  const f = await makeFamily();
  const k = f.momToken;
  const say = (text, extra = {}) => quick({ k, t: 'say', say: text, ...extra });
  let r = await say('분유 120 먹였어');
  assert.equal(r.text, '✓ 분유 120ml 기록 · 오후 2:32 · 엄마\n오늘 수유 1번째 · 총 120ml');
  r = await say('쉬했어');
  assert.match(r.text, /^✓ 소변 기록/);
  r = await say('응가 노란색');
  assert.match(r.text, /^✓ 대변\(노랑\) 기록/);
  r = await say('쉬랑 응가');
  assert.match(r.text, /^✓ 소변·대변 기록/);
  r = await say('모유 왼쪽 10분');
  assert.match(r.text, /^✓ 모유 왼쪽 10분 기록/);
  r = await say('트림했어');
  assert.match(r.text, /^✓ 트림 기록/);
  r = await say('체온 38.5');
  assert.match(r.text, /^✓ 체온 38\.5℃ 기록/);
  r = await say('30분 전에 분유 백');
  assert.match(r.text, /^✓ 분유 100ml 기록 · 오후 2:02 · 엄마/);
  r = await say('맘마 먹였어'); // 양 없음 → 마지막 분유 양(가장 최근 ts 기준 = 120)
  assert.match(r.text, /^✓ 분유 120ml 기록/);
  r = await say('잠들었어');
  assert.match(r.text, /^✓ 잠 시작/);
  r = await say('잠들었어');
  assert.equal(r.status, 409);
  assert.match(r.text, /^⚠ 이미 재우는 중/, '기록 안 됨 — 성공(✓)처럼 보이지 않게');
  clock += 72 * MIN;
  r = await say('깼어');
  assert.match(r.text, /^✓ 잠 끝 \(1시간 12분\).*\n😴 1시간 12분 잤어요$/);
  r = await say('깼어');
  assert.equal(r.status, 409);
  assert.match(r.text, /^⚠ 진행 중인 잠 기록이 없어요/);
  // 잠 끝 낱말 ('잠 끝났어' · '낮잠 끝' · '다 잤어') = 깼어요 — 잠 시작이 아님
  r = await say('낮잠 끝');
  assert.equal(r.status, 409, '열린 잠이 없으면 새 잠을 시작하지 않는다');
  await say('잠들었어');
  clock += 30 * MIN;
  r = await say('잠 끝났어');
  assert.match(r.text, /^✓ 잠 끝 \(30분\)/);
  // '소변 봤어' = 소변 한 건 (대변 아님)
  r = await say('소변 봤어요');
  assert.match(r.text, /^✓ 소변 기록/);
  // 노란 변의 흰 알갱이(정상)를 흰색 변으로 읽지 않는다
  r = await say('응가 노란데 하얀 알갱이');
  assert.match(r.text, /^✓ 대변\(노랑\) 기록/);
  assert.ok(!/⚠️/.test(r.text));
  // 알아듣지 못함 → 400 + 들은 말
  r = await say('오늘 날씨 좋다');
  assert.equal(r.status, 400);
  assert.match(r.text, /^알아듣지 못했어요: 오늘 날씨 좋다/);
  // t 없이 say 만 / 본문(JSON·form)으로 받아쓰기
  r = await quick({ k, say: '목욕했어' });
  assert.match(r.text, /^✓ 목욕 기록/);
  r = await quick({}, { query: `a=q&t=say&k=${k}`, body: JSON.stringify({ say: '양치했어' }), contentType: 'application/json' });
  assert.match(r.text, /^✓ 양치 기록/);
  r = await quick({}, { query: `a=q&t=say&k=${k}`, body: `say=${encodeURIComponent('물 50')}`, contentType: 'application/x-www-form-urlencoded' });
  assert.match(r.text, /^✓ 물 50ml 기록/);
  const all = [...(await pullAll(k)).values()];
  assert.ok(all.filter((e) => e.type !== 'sleep').every((e) => e.data.src === 'say'));
  assert.equal(all.find((e) => e.type === 'formula' && e.data.ml === 100).ts, T0 - 30 * MIN);
});

test('레이트 리밋: create 30 · join 60 · peek 120 회/시간/IP', async () => {
  const ip = '203.0.113.7';
  const mom = { id: uuid(), name: '엄마', role: 'mom' };
  const body = { a: 'create', family: { name: '', birth: '2026-09-01', updatedAt: clock }, members: [mom], meId: mom.id };
  for (let i = 0; i < 30; i++) assert.equal((await api(body, { ip })).status, 200);
  const r = await api(body, { ip });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.equal((await api(body, { ip: '203.0.113.8' })).status, 200); // 다른 IP 는 영향 없음
  // peek 120 (초대·기기 연결 코드 같은 버킷) / join 60 (초대·기기 연결 코드 같은 버킷)
  const ip2 = '203.0.113.9';
  for (let i = 0; i < 120; i++) {
    const body2 = i % 2 ? { a: 'peek', invite: 'AAAAAAAAAAAAAAAA' } : { a: 'peek', device: 'AAAAAAAAAAAAAAAA' };
    assert.equal((await api(body2, { ip: ip2 })).status, 404);
  }
  assert.equal((await api({ a: 'peek', invite: 'AAAAAAAAAAAAAAAA' }, { ip: ip2 })).status, 429);
  assert.equal((await api({ a: 'peek', device: 'AAAAAAAAAAAAAAAA' }, { ip: ip2 })).status, 429);
  const ip3 = '203.0.113.10';
  for (let i = 0; i < 60; i++) {
    const body3 = i % 2 ? { a: 'join', invite: 'AAAAAAAAAAAAAAAA', claim: uuid() } : { a: 'join', device: 'AAAAAAAAAAAAAAAA' };
    assert.equal((await api(body3, { ip: ip3 })).status, 404);
  }
  assert.equal((await api({ a: 'join', invite: 'AAAAAAAAAAAAAAAA', claim: uuid() }, { ip: ip3 })).status, 429);
  assert.equal((await api({ a: 'join', device: 'AAAAAAAAAAAAAAAA' }, { ip: ip3 })).status, 429);
  // IP 는 해시로만 저장
  const rows = await sql`select bucket from uriday.rate`;
  assert.ok(rows.every((x) => !x.bucket.includes('203.0.113')));
});

// ── 동시성 ───────────────────────────────────────────────────────────────
test('동시성: 20개 동시 sync 푸시 중 폴링하는 커서가 기록을 하나도 건너뛰지 않음', async () => {
  clock = T0;
  const f = await makeFamily();
  const writers = [f.momToken, await joinAs(f.invite, f.dad.id), await joinNew(f.invite, '이모')];
  const readers = [await linkDevice(f.momToken), await joinNew(f.invite, '할머니')];
  const ROUNDS = 3; // 20개 동시 푸시를 3번
  const N = 20;
  const PER = 20;
  const pushed = new Set();
  let done = false;

  // 읽는 기기 2대가 쉬지 않고 커서로 폴링
  const readerLoop = async (k) => {
    const seen = new Map(); // id → 몇 번 봤나
    const polls = [];
    let cursor = 0;
    for (;;) {
      const finished = done;
      const r = await sync(k, cursor);
      assert.equal(r.status, 200, r.text);
      polls.push({ from: cursor, revs: r.json.events.map((e) => e.rev) });
      for (const e of r.json.events) seen.set(e.id, (seen.get(e.id) || 0) + 1);
      cursor = r.json.rev;
      if (finished && !r.json.more) return { seen, polls };
    }
  };
  const loops = readers.map(readerLoop);
  for (let round = 0; round < ROUNDS; round++) {
    const batches = Array.from({ length: N }, (_, b) =>
      Array.from({ length: PER }, (_, i) => ev(i % 2 ? 'pee' : 'poop', {}, { ts: T0 + (round * N + b) * PER + i, by: f.mom.id })),
    );
    for (const e of batches.flat()) pushed.add(e.id);
    const results = await Promise.all(batches.map((b, i) => sync(writers[i % writers.length], 0, { push: b })));
    assert.ok(results.every((r) => r.status === 200));
  }
  done = true;
  const dbRevs = (await sql`select rev from uriday.events where family_id = ${f.familyId} order by rev`).map((r) => Number(r.rev));
  assert.equal(dbRevs.length, ROUNDS * N * PER);

  for (const { seen, polls } of await Promise.all(loops)) {
    const missing = [...pushed].filter((id) => !seen.has(id));
    assert.equal(missing.length, 0, `읽는 쪽이 놓친 기록 ${missing.length}개`);
    assert.ok([...seen.values()].every((n) => n === 1), '같은 기록을 두 번 받지 않음');
    for (const p of polls) {
      for (let i = 0; i < p.revs.length; i++) assert.ok(p.revs[i] > (i ? p.revs[i - 1] : p.from));
    }
    // 최종 DB 의 rev 순서와 읽는 쪽이 받은 순서가 같다 (나중에 끼어든 작은 rev 없음)
    assert.deepEqual(polls.flatMap((p) => p.revs), dbRevs);
    assert.ok(polls.length > 2, `폴링 ${polls.length}회`);
  }
});

// ── 리뷰 수정분 ────────────────────────────────────────────────────────────
test('quickkey: 잠금화면 주소용 기록 전용 키 — quick 만 되고 sync·관리 동작은 401, 새로 만들면 옛 키 멈춤, 기기 끊기면 같이 멈춤', async () => {
  clock = T0;
  const f = await makeFamily();
  let r = await api({ a: 'quickkey', k: f.momToken });
  assert.equal(r.status, 200, r.text);
  const q1 = r.json.quick;
  assert.match(q1, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(q1, f.momToken);
  // 기록은 된다 (그 기기의 사람으로)
  r = await quick({ k: q1, t: 'pee' });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /^✓ 소변 기록 · 오후 2:32 · 엄마/);
  // 본문(form)·x-bl-key 헤더로 보내도 된다 (주소에 키를 안 싣는 방법)
  r = await quick({}, { query: 'a=q&t=poop', body: `k=${q1}`, contentType: 'application/x-www-form-urlencoded' });
  assert.equal(r.status, 200, r.text);
  r = await quick({}, { query: 'a=q&t=pee', headers: { 'x-bl-key': q1 } });
  assert.equal(r.status, 200, r.text);
  // 전체 기록 읽기·초대·기기 연결·관리·키 발급은 안 된다
  for (const body of [{ a: 'sync', since: 0 }, { a: 'invite' }, { a: 'devlink' }, { a: 'quickkey' }, { a: 'signout' },
    { a: 'remove', memberId: f.dad.id }, { a: 'unlink', memberId: f.dad.id }, { a: 'admin', memberId: f.dad.id, on: true }, { a: 'leave' }]) {
    assert.equal((await api({ ...body, k: q1 })).status, 401, JSON.stringify(body));
  }
  // 새로 만들면 옛 키는 멈춤
  const q2 = (await api({ a: 'quickkey', k: f.momToken })).json.quick;
  assert.equal((await quick({ k: q1, t: 'pee' })).status, 401);
  assert.equal((await quick({ k: q2, t: 'pee' })).status, 200);
  // 그 기기의 공유를 끊으면 기록 전용 키도 멈춤
  await api({ a: 'leave', k: f.momToken });
  assert.equal((await quick({ k: q2, t: 'pee' })).status, 401);
});

test('signout: 내 다른 기기 연결만 모두 끊기 (이 기기·다른 사람은 그대로)', async () => {
  clock = T0;
  const f = await makeFamily();
  const dadToken = await joinAs(f.invite, f.dad.id);
  const mom2 = await linkDevice(f.momToken);
  const mom3 = await linkDevice(mom2);
  const pending = (await api({ a: 'devlink', k: mom2 })).json.code;
  const r = await api({ a: 'signout', k: mom2 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.members.find((m) => m.id === f.mom.id).claimed, true);
  assert.equal((await sync(mom2, 0)).status, 200, '이 기기는 그대로');
  assert.equal((await sync(f.momToken, 0)).status, 401);
  assert.equal((await sync(mom3, 0)).status, 401);
  assert.equal((await sync(dadToken, 0)).status, 200, '다른 사람은 그대로');
  assert.equal((await api({ a: 'join', device: pending })).status, 404, '만들어 둔 연결 코드도 지움');
});

test('join nonce: 응답이 끊겨 같은 참여를 다시 보내면 같은 자리로 이어 준다 (자리 중복·403 없음)', async () => {
  clock = T0;
  const f = await makeFamily();
  const nonce = 'n0nce-' + 'x'.repeat(20);
  // ① 새 사람: 같은 me.id + nonce 로 두 번 → 구성원 하나, 두 번째 응답의 토큰만 살아 있음
  const me = { id: uuid(), name: '이모님', role: 'sitter' };
  const a1 = await api({ a: 'join', invite: f.invite, me, nonce });
  const a2 = await api({ a: 'join', invite: f.invite, me, nonce });
  assert.equal(a1.status, 200, a1.text);
  assert.equal(a2.status, 200, a2.text);
  assert.equal(a2.json.me.memberId, me.id);
  assert.notEqual(a2.json.token, a1.json.token);
  assert.equal(a2.json.members.filter((m) => m.name === '이모님').length, 1);
  assert.equal((await sync(a1.json.token, 0)).status, 401, '아무도 못 받은 첫 토큰은 바뀜');
  assert.equal((await sync(a2.json.token, 0)).status, 200);
  // ② 자리 차지(claim): 두 번째도 200 (403 '이미 쓰는 사람' 아님)
  const n2 = 'second-nonce-' + 'y'.repeat(10);
  const c1 = await api({ a: 'join', invite: f.invite, claim: f.dad.id, nonce: n2 });
  const c2 = await api({ a: 'join', invite: f.invite, claim: f.dad.id, nonce: n2 });
  assert.equal(c1.status, 200, c1.text);
  assert.equal(c2.status, 200, c2.text);
  assert.equal(c2.json.me.memberId, f.dad.id);
  // nonce 가 다르면(다른 기기) 여전히 403
  assert.equal((await api({ a: 'join', invite: f.invite, claim: f.dad.id, nonce: 'other-nonce-zzzzzzzz' })).status, 403);
  // ③ 기기 연결 코드: 이미 쓴 코드라도 같은 nonce 면 이어 준다, 다른 nonce 면 404
  const code = (await api({ a: 'devlink', k: c2.json.token })).json.code;
  const n3 = 'device-nonce-' + 'z'.repeat(10);
  const d1 = await api({ a: 'join', device: code, nonce: n3 });
  const d2 = await api({ a: 'join', device: code, nonce: n3 });
  assert.equal(d1.status, 200, d1.text);
  assert.equal(d2.status, 200, d2.text);
  assert.equal(d2.json.me.memberId, f.dad.id);
  assert.equal((await api({ a: 'join', device: code, nonce: 'another-nonce-aaaaaa' })).status, 404);
  assert.equal((await api({ a: 'join', device: code })).status, 404);
  // ④ 같은 nonce 로 다른 자리를 고르면: 아무도 못 받은 옛 기기는 끊고 새 자리로
  const gma = { id: uuid(), name: '할머니', role: 'grandma', emoji: '👵', updatedAt: clock };
  await sync(f.momToken, 0, { members: [gma] });
  const n4 = 'switch-nonce-' + 'w'.repeat(10);
  const s1 = await api({ a: 'join', invite: f.invite, me: { id: uuid(), name: '새 사람', role: 'other' }, nonce: n4 });
  const s2 = await api({ a: 'join', invite: f.invite, claim: gma.id, nonce: n4 });
  assert.equal(s2.status, 200, s2.text);
  assert.equal((await sync(s1.json.token, 0)).status, 401);
  // 잘못된 nonce 는 무시(보통 참여)
  assert.equal((await api({ a: 'join', invite: f.invite, me: { name: '가족', role: 'other' }, nonce: 'short' })).status, 200);
});

test('updatedAt 은 서버 시각 + 10분까지로 잘린다 — 먼 미래 값으로 기록·프로필·아기 정보를 잠가도 다른 기기가 고칠 수 있다', async () => {
  clock = T0;
  const f = await makeFamily();
  const dadToken = await joinAs(f.invite, f.dad.id);
  const FAR = 4102444800000; // 2100-01-01
  const e = ev('pee', {}, { updatedAt: FAR });
  let r = await sync(dadToken, 0, {
    push: [e],
    members: [{ ...f.mom, name: '바보', updatedAt: FAR * 3 }],
    family: { name: '잠금', updatedAt: FAR },
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.rejected, []);
  const got = r.json.events.find((x) => x.id === e.id);
  assert.equal(got.updatedAt, T0 + 10 * MIN, '잘린 값을 돌려준다');
  assert.equal(r.json.members.find((m) => m.id === f.mom.id).updatedAt, T0 + 10 * MIN);
  assert.equal(r.json.family.updatedAt, T0 + 10 * MIN);
  // 엄마 기기: (조금 뒤) 받은 값 +1 로 고치면 이긴다
  clock += MIN;
  const fix = T0 + 10 * MIN + 1;
  r = await sync(f.momToken, 0, {
    push: [{ ...e, deleted: true, updatedAt: fix }],
    members: [{ ...f.mom, updatedAt: fix }],
    family: { name: '하린', updatedAt: fix },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.events.find((x) => x.id === e.id).deleted, true);
  assert.equal(r.json.members.find((m) => m.id === f.mom.id).name, '엄마');
  assert.equal(r.json.family.name, '하린');
  // 너무 이른 값은 여전히 거부
  const old = ev('pee', {}, { updatedAt: 1000 });
  r = await sync(f.momToken, 0, { push: [old] });
  assert.deepEqual(r.json.rejected, [old.id]);
});

test('관리자 자리: 기기 연결 해제(unlink)하면 관리자 권한도 해제 · 공유 끊기(leave)는 다른 관리자가 있을 때만 해제', async () => {
  clock = T0;
  const f = await makeFamily();
  const dadToken = await joinAs(f.invite, f.dad.id);
  await api({ a: 'admin', k: f.momToken, memberId: f.dad.id, on: true });
  // 아빠 폰 분실 → 엄마가 연결 해제 → 아빠 자리는 관리자가 아님 (초대 링크로 누가 먼저 차지해도 관리자가 안 됨)
  let r = await api({ a: 'unlink', k: f.momToken, memberId: f.dad.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.members.find((m) => m.id === f.dad.id).isAdmin, false);
  assert.equal((await sync(dadToken, 0)).status, 401);
  const j = await api({ a: 'join', invite: f.invite, claim: f.dad.id });
  assert.equal(j.json.me.isAdmin, false);
  assert.equal((await api({ a: 'invite', k: j.json.token })).status, 403);
  // 관리자 둘일 때 한 명이 마지막 기기에서 공유 끊기 → 그 자리는 관리자 해제
  await api({ a: 'admin', k: f.momToken, memberId: f.dad.id, on: true });
  await api({ a: 'leave', k: j.json.token });
  r = await sync(f.momToken, 0);
  assert.equal(r.json.members.find((m) => m.id === f.dad.id).isAdmin, false);
  // 관리자가 혼자면 끊어도 유지 (가족에 관리자가 없어지지 않게)
  await api({ a: 'leave', k: f.momToken });
  const g = await makeFamily();
  await api({ a: 'leave', k: g.momToken });
  const p = await api({ a: 'join', invite: g.invite, claim: g.mom.id });
  assert.equal(p.json.me.isAdmin, true);
});

test('quick: 끝나지 않은 잠이 둘이면 깼어요는 둘 다 끝내고 가장 먼저 잠든 때부터 잰다', async () => {
  clock = Date.UTC(2026, 8, 28, 4, 0); // 13:00 KST
  const f = await makeFamily();
  const k = f.momToken;
  // 엄마 앱 13:00 '재우기'(아직 못 보냄) + 아빠 단축어 13:02 → 서버에 열린 잠 둘
  const appSleep = ev('sleep', {}, { ts: clock, updatedAt: clock });
  clock += 2 * MIN;
  let r = await quick({ k, t: 'sleep' });
  assert.match(r.text, /^✓ 잠 시작/);
  await sync(k, 0, { push: [appSleep] });
  clock = Date.UTC(2026, 8, 28, 5, 30); // 14:30
  r = await quick({ k, t: 'sleep' });
  assert.equal(r.text, '✓ 잠 끝 (1시간 30분) · 오후 2:30 · 엄마\n😴 1시간 30분 잤어요');
  const sleeps = [...(await pullAll(k)).values()].filter((e) => e.type === 'sleep');
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((e) => e.data.end === clock), '둘 다 끝남');
  // 다음 탭은 새 잠 시작
  clock = Date.UTC(2026, 8, 28, 6, 0);
  r = await quick({ k, t: 'sleep' });
  assert.match(r.text, /^✓ 잠 시작/);
});

test('quick: 트림을 수유에 붙인 요청의 id 를 남긴다 (응답 유실 → 알림 수신함 재전송이 중복 트림이 되지 않게) · 자정 넘긴 트림 횟수', async () => {
  clock = Date.UTC(2026, 8, 28, 14, 30); // 23:30 KST
  const f = await makeFamily();
  const k = f.momToken;
  await quick({ k, t: 'formula', ml: 100 });
  clock = Date.UTC(2026, 8, 28, 15, 5); // 다음날 00:05 KST
  const id = uuid();
  const ts = clock;
  let r = await quick({ k, t: 'burp', src: 'notif', id, ts });
  assert.equal(r.text, '✓ 트림 기록 · 오전 12:05 · 엄마\n9/28 트림 1번째 · 오후 11:30 분유에 표시');
  // 같은 id 로 다시 (응답을 못 받은 서비스워커가 한 번 더 / 수신함)
  r = await quick({ k, t: 'burp', src: 'notif', id, ts });
  assert.match(r.text, /^✓ 이미 기록돼 있어요/);
  // 앱이 수신함에서 가져와 같은 id 의 트림을 올려도(updatedAt = 탭 시각) 서버 툼스톤이 이긴다
  clock += MIN;
  r = await sync(k, 0, { push: [{ id, type: 'burp', ts, by: f.mom.id, data: { src: 'notif' }, deleted: false, updatedAt: ts }] });
  const burpRow = r.json.events.find((e) => e.id === id);
  assert.equal(burpRow.deleted, true);
  const alive = r.json.events.filter((e) => !e.deleted);
  assert.equal(alive.filter((e) => e.type === 'burp').length, 0);
  assert.equal(alive.find((e) => e.type === 'formula').data.burp, 'yes');
});

test('quick say: "우유" 는 돌 이후엔 우유(milk), 돌 전엔 분유 · "생우유" 는 늘 우유', async () => {
  clock = T0;
  const baby = await makeFamily(); // 2026-09-05 생 (23일)
  let r = await quick({ k: baby.momToken, t: 'say', say: '우유 120' });
  assert.match(r.text, /^✓ 분유 120ml 기록/);
  const toddler = await api({
    a: 'create', family: { name: '도윤', birth: '2025-06-01', updatedAt: clock },
    members: [{ id: uuid(), name: '엄마', role: 'mom', emoji: '👩', updatedAt: clock }], events: [],
    meId: undefined,
  });
  assert.equal(toddler.status, 400); // meId 없음
  const mom = { id: uuid(), name: '엄마', role: 'mom', emoji: '👩', updatedAt: clock };
  const t2 = await api({ a: 'create', family: { name: '도윤', birth: '2025-06-01', updatedAt: clock }, members: [mom], meId: mom.id, events: [] });
  r = await quick({ k: t2.json.token, t: 'say', say: '우유 200 마셨어' });
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /^✓ 우유 200ml 기록 · 오후 2:32 · 엄마\n오늘 우유 1번째$/);
  r = await quick({ k: t2.json.token, t: 'say', say: '분유 180' });
  assert.match(r.text, /^✓ 분유 180ml 기록/);
  r = await quick({ k: baby.momToken, t: 'say', say: '생우유 100' });
  assert.match(r.text, /^✓ 우유 100ml 기록/);
});
