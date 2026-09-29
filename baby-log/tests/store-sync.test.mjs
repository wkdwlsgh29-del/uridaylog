// '함께 육아일지' 저장소·동기화 테스트 — node --test baby-log/tests/
// localStorage / fetch / Cache Storage / document 를 흉내 내고, SPEC §6.3 계약대로 동작하는 가짜 서버를 쓴다.
process.env.TZ = 'Asia/Seoul';

import test from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../../shared/js/brand.js';
import { EVENT_TYPES } from '../log-data.js';
import * as St from '../store.js';
import * as Sy from '../sync.js';

const MIN = 60000, DAY = 86400000;
const at = (h = 0, m = 0, d = 28) => new Date(2026, 8, d, h, m).getTime();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 흉내: localStorage ----------
class MemStorage {
  constructor(quota = Infinity) { this.m = new Map(); this.quota = quota; }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) {
    const s = String(v);
    let total = s.length;
    for (const [kk, vv] of this.m) if (kk !== k) total += vv.length;
    if (total > this.quota) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; e.code = 22; throw e; }
    this.m.set(k, s);
  }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

// ---------- 흉내: Cache Storage ----------
class FakeCache {
  constructor() { this.m = new Map(); }
  async put(req, res) { this.m.set(typeof req === 'string' ? req : req.url, await res.text()); }
  async match(req) { const k = typeof req === 'string' ? req : req.url; return this.m.has(k) ? new Response(this.m.get(k)) : undefined; }
  async keys() { return [...this.m.keys()].map((u) => new Request(u)); }
  async delete(req) { return this.m.delete(typeof req === 'string' ? req : req.url); }
}
class FakeCaches {
  constructor() { this.c = new Map(); }
  async open(n) { if (!this.c.has(n)) this.c.set(n, new FakeCache()); return this.c.get(n); }
  async delete(n) { return this.c.delete(n); }
  async keys() { return [...this.c.keys()]; }
}

const DEV = 'http://localhost:5190/api';
function browserEnv({ host = 'localhost', dev = DEV } = {}) {
  globalThis.localStorage = new MemStorage();
  globalThis.location = { hostname: host, href: `http://${host}:5190/baby-log/index.html` };
  if (dev) localStorage.setItem(Sy.DEV_ENDPOINT_KEY, dev);
  globalThis.caches = new FakeCaches();
}

// ---------- 가짜 서버 (SPEC §6.3) ----------
function makeServer({ pageLimit = 1000, stringNums = false } = {}) {
  const S = { fams: new Map(), devices: new Map(), invites: new Map(), links: new Map(), rev: 0, calls: [], hook: null, pageLimit, stringNums };
  let n = 0;
  const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  const err = (status, error) => reply(status, { ok: false, error, message: `서버:${error}` });
  const num = (v) => (S.stringNums ? String(v) : v);
  const famView = (f) => ({ id: f.id, name: f.name, birth: f.birth, updatedAt: num(f.updatedAt) });
  const claimed = (f, id) => [...S.devices.values()].some((d) => d.fam === f.id && d.member === id && !d.revoked);
  const membersView = (f) => [...f.members.values()].map((m) => ({ ...m, updatedAt: num(m.updatedAt), claimed: claimed(f, m.id) }));
  const evView = (e) => ({ ...e, ts: num(e.ts), updatedAt: num(e.updatedAt), rev: num(e.rev) });
  const valid = (e) => e && typeof e.id === 'string' && EVENT_TYPES[e.type] && typeof e.ts === 'number'
    && !(['formula', 'pumped', 'milk'].includes(e.type) && !(e.data?.ml >= 1)) && !('dirty' in e) && !('rev' in e);
  const newToken = (fam, member) => { const t = `tok-${++n}`; S.devices.set(t, { fam, member, revoked: false }); return t; };
  const newInvite = (f) => { const c = `ABCDEFGHJKMNPQ${String(++n).padStart(2, '0')}`.slice(-16); for (const [k, v] of S.invites) if (v === f.id) S.invites.delete(k); S.invites.set(c, f.id); return c; };
  const upsert = (f, list) => {
    const rejected = [];
    for (const e of list || []) {
      if (!valid(e)) { rejected.push(e?.id); continue; }
      const ex = f.events.get(e.id);
      if (!ex || e.updatedAt > ex.updatedAt) f.events.set(e.id, { ...e, by: f.members.has(e.by) ? e.by : null, rev: ++S.rev });
    }
    return rejected;
  };
  const upsertMembers = (f, list) => {
    const rejected = [];
    for (const m of list || []) {
      if (!['mom', 'dad', 'sitter', 'grandma', 'grandpa', 'other'].includes(m.role)) { rejected.push(m.id); continue; }
      const ex = f.members.get(m.id);
      if (!ex) f.members.set(m.id, { id: m.id, name: m.name, role: m.role, emoji: m.emoji, updatedAt: m.updatedAt, isAdmin: false });
      else if (m.updatedAt > ex.updatedAt) Object.assign(ex, { name: m.name, role: m.role, emoji: m.emoji, updatedAt: m.updatedAt });
    }
    return rejected;
  };
  const maxRev = (f) => Math.max(0, ...[...f.events.values()].map((e) => e.rev));
  const auth = (k) => { const d = S.devices.get(k); return d && !d.revoked ? d : null; };

  async function handle(b) {
    switch (b.a) {
      case 'create': {
        const f = { id: `fam-${++n}`, name: b.family.name, birth: b.family.birth, updatedAt: b.family.updatedAt, members: new Map(), events: new Map() };
        S.fams.set(f.id, f);
        upsertMembers(f, b.members);
        f.members.get(b.meId).isAdmin = true;
        upsert(f, b.events);
        const token = newToken(f.id, b.meId);
        return reply(200, { ok: true, token, invite: newInvite(f), familyId: f.id, me: { memberId: b.meId, isAdmin: true }, family: famView(f), members: membersView(f), rev: S.rev });
      }
      case 'peek': {
        if (b.device) {
          const l = S.links.get(b.device);
          if (!l || l.used) return err(404, 'invite_invalid');
          const f = S.fams.get(l.fam);
          const m = f.members.get(l.member);
          return reply(200, { ok: true, family: { name: f.name }, member: { id: m.id, name: m.name, role: m.role, emoji: m.emoji } });
        }
        const f = S.fams.get(S.invites.get(b.invite));
        if (!f) return err(404, 'invite_invalid');
        return reply(200, { ok: true, family: { name: f.name }, members: membersView(f).map(({ id, name, role, emoji, claimed: c }) => ({ id, name, role, emoji, claimed: c })) });
      }
      case 'join': {
        if (b.device) {
          const l = S.links.get(b.device);
          if (!l || l.used) return err(404, 'invite_invalid');
          l.used = true;
          const f = S.fams.get(l.fam);
          return reply(200, { ok: true, token: newToken(f.id, l.member), familyId: f.id, me: { memberId: l.member, isAdmin: !!f.members.get(l.member).isAdmin }, family: famView(f), members: membersView(f), rev: 0 });
        }
        const f = S.fams.get(S.invites.get(b.invite));
        if (!f) return err(404, 'invite_invalid');
        let memberId;
        if (b.claim) {
          if (!f.members.has(b.claim)) return err(400, 'bad_request');
          if (claimed(f, b.claim)) return reply(403, { ok: false, error: 'forbidden', message: '이미 다른 기기에서 쓰는 사람이에요' });
          memberId = b.claim;
        }
        else { memberId = b.me.id; f.members.set(memberId, { id: memberId, name: b.me.name, role: b.me.role, emoji: b.me.emoji, updatedAt: Date.now(), isAdmin: false }); }
        const token = newToken(f.id, memberId);
        return reply(200, { ok: true, token, familyId: f.id, me: { memberId, isAdmin: !!f.members.get(memberId).isAdmin }, family: famView(f), members: membersView(f), rev: 0 });
      }
      case 'sync': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        const f = S.fams.get(d.fam);
        const rejectedMembers = upsertMembers(f, b.members);
        if (b.family && b.family.updatedAt > f.updatedAt) Object.assign(f, { name: b.family.name, birth: b.family.birth, updatedAt: b.family.updatedAt });
        const rejected = upsert(f, b.push);
        const reset = b.since > maxRev(f);
        const since = reset ? 0 : b.since;
        const all = [...f.events.values()].filter((e) => e.rev > since).sort((x, y) => x.rev - y.rev);
        const page = all.slice(0, S.pageLimit);
        const more = all.length > page.length;
        return reply(200, {
          ok: true, events: page.map(evView), more, rev: num(more ? page.at(-1).rev : maxRev(f)),
          members: membersView(f), family: famView(f), me: { memberId: d.member, isAdmin: !!f.members.get(d.member)?.isAdmin },
          serverTime: num(Date.now()), rejected, ...(rejectedMembers.length ? { rejectedMembers } : {}), ...(reset ? { reset: true } : {}),
        });
      }
      case 'invite': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        const f = S.fams.get(d.fam);
        if (!f.members.get(d.member).isAdmin) return err(403, 'forbidden');
        return reply(200, { ok: true, invite: newInvite(f) });
      }
      case 'devlink': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        const code = `DEV${String(++n).padStart(13, '0')}`.slice(-16).replace(/[ILOU]/g, '0');
        S.links.set(code, { fam: d.fam, member: d.member, used: false });
        return reply(200, { ok: true, code, expiresAt: Date.now() + 15 * MIN });
      }
      case 'unlink': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        for (const dv of S.devices.values()) if (dv.fam === d.fam && dv.member === b.memberId) dv.revoked = true;
        return reply(200, { ok: true, members: membersView(S.fams.get(d.fam)) });
      }
      case 'remove': case 'admin': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        const f = S.fams.get(d.fam);
        if (!f.members.get(d.member).isAdmin) return err(403, 'forbidden');
        if (b.a === 'remove') {
          for (const dv of S.devices.values()) if (dv.member === b.memberId) dv.revoked = true;
          f.members.get(b.memberId).revoked = true;
          return reply(200, { ok: true, members: membersView(f), invite: newInvite(f) });   // 초대 코드도 바뀜
        }
        f.members.get(b.memberId).isAdmin = !!b.on;
        return reply(200, { ok: true, members: membersView(f) });
      }
      case 'quickkey': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        d.quick = `qk-${++n}`;
        return reply(200, { ok: true, quick: d.quick });
      }
      case 'signout': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        for (const dv of S.devices.values()) if (dv !== d && dv.fam === d.fam && dv.member === d.member) dv.revoked = true;
        return reply(200, { ok: true, members: membersView(S.fams.get(d.fam)) });
      }
      case 'leave': {
        const d = auth(b.k);
        if (!d) return err(401, 'unauthorized');
        d.revoked = true;
        return reply(200, { ok: true });
      }
      default:
        return err(400, 'bad_request');
    }
  }
  S.handle = handle;
  S.fetch = async (url, init) => {
    assert.equal(url, DEV, '개발 엔드포인트로만 요청');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    S.calls.push({ body, init });
    if (S.hook) { const r = await S.hook(body, handle, init); if (r !== undefined) return r; }
    return handle(body);
  };
  return S;
}

function setupShared(server, now = at(9)) {
  const s = St.defaultState();
  St.setupFamily(s, { name: '하린', birth: '2026-09-01', me: { role: 'mom' } }, now);
  return s;
}
const peekEvents = (server, famId) => [...server.fams.get(famId).events.values()];

// =====================================================================
// store.js
// =====================================================================
test('load(): 없으면 새 상태, 깨진 JSON 은 백업 후 새 상태, 절대 throw 안 함', () => {
  browserEnv();
  const d = St.load();
  assert.deepEqual(d, St.defaultState());
  assert.equal(d.prefs.game, true);
  assert.deepEqual(d.prefs.quickActions, ['pee', 'poop']);
  for (const bad of ['{bad json', '[]', 'null', '"str"', '42']) {
    localStorage.clear();
    localStorage.setItem(St.KEY, bad);
    const s = St.load();
    assert.deepEqual(s, St.defaultState(), bad);
    assert.equal(localStorage.getItem(St.CORRUPT_KEY), bad, `백업 ${bad}`);
  }
  // localStorage 접근 자체가 막힌 환경
  const saved = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    assert.deepEqual(St.load(), St.defaultState());
    assert.equal(St.save(St.defaultState()), false);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: saved });
  }
});

test('load(): 일부만 잘못된 값은 걸러내고 나머지는 살린다 (모르는 키 보존)', () => {
  browserEnv();
  localStorage.setItem(St.KEY, JSON.stringify({
    v: 1, future: { keep: true },
    family: { name: '하린이름이아주아주길어요', birth: '2026-09-01', updatedAt: 5 },
    members: [{ id: 'm1', name: '', role: 'alien' }, 'junk', { id: 'm1', name: 'dup' }],
    meId: 'ghost',
    events: [
      { id: 'a', type: 'pee', ts: 100, updatedAt: 1, dirty: true },
      { id: 'a', type: 'pee', ts: 100, updatedAt: 9, data: { x: 1 } },
      { id: 'b', type: 'BAD TYPE', ts: 1 }, { id: 'c', type: 'pee', ts: 'x' }, null,
      { id: 'd', type: 'formula', ts: 200.7, data: [1, 2], rev: -3 },
    ],
    sync: { token: 'tok', rev: 'x', revoked: 1 },
    prefs: { theme: 'neon', game: false, lastMl: { formula: 120, bad: 'x' }, grid: { rolling: ['pee', 3] } },
  }));
  const s = St.load();
  assert.equal(s.future.keep, true);
  assert.equal(s.family.name, '하린이름이아주아주길');
  assert.equal(s.members.length, 1);
  assert.equal(s.members[0].role, 'other');
  assert.equal(s.members[0].name, '가족');
  assert.equal(s.meId, 'm1');
  assert.deepEqual(s.events.map((e) => e.id).sort(), ['a', 'd']);
  assert.equal(s.events.find((e) => e.id === 'a').updatedAt, 9, '중복 id 는 새 것');
  const d = s.events.find((e) => e.id === 'd');
  assert.deepEqual([d.ts, d.rev, d.by, d.deleted, d.dirty], [201, 0, null, false, false]);
  assert.deepEqual(d.data, {});
  assert.deepEqual([s.sync.token, s.sync.rev, s.sync.revoked], ['tok', 0, true]);
  assert.deepEqual([s.prefs.theme, s.prefs.game], ['auto', false]);
  assert.deepEqual(s.prefs.lastMl, { formula: 120 });
  assert.deepEqual(s.prefs.grid, { rolling: ['pee'] });
});

test('save()/load() 왕복 + dirty 표시도 저장', () => {
  browserEnv();
  const s = setupShared();
  St.addEvent(s, { type: 'formula', data: { ml: 120 } }, at(10));
  assert.equal(St.save(s), true);
  const r = St.load();
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].dirty, true);
  assert.equal(r.prefs.lastMl.formula, 120);
  assert.equal(r.meId, s.meId);
  St.wipe();
  assert.equal(localStorage.getItem(St.KEY), null);
});

test('save(): 용량 초과면 30일 지난 툼스톤을 지우고 다시 저장', () => {
  browserEnv();
  const now = at(12);
  const s = setupShared();
  for (let i = 0; i < 200; i++) {
    const e = St.addEvent(s, { type: 'note', data: { text: 'x'.repeat(150) } }, now - 40 * DAY);
    St.deleteEvent(s, e.id, now - 40 * DAY);
  }
  const keep = St.addEvent(s, { type: 'pee' }, now);
  const recentDel = St.addEvent(s, { type: 'pee' }, now);
  St.deleteEvent(s, recentDel.id, now);
  const size = JSON.stringify(s).length;
  globalThis.localStorage = new MemStorage(size - 1000);
  assert.equal(St.save(s, now), true);
  assert.equal(s.events.length, 2, '오래된 툼스톤만 정리 (공유 전이라 dirty 여도 정리)');
  assert.ok(s.events.some((e) => e.id === keep.id) && s.events.some((e) => e.id === recentDel.id));
  // 공유 중이면 dirty 툼스톤(아직 서버에 안 간 삭제)은 남긴다
  const s2 = setupShared();
  s2.sync.token = 'tok';
  const t = St.addEvent(s2, { type: 'pee' }, now - 40 * DAY);
  St.deleteEvent(s2, t.id, now - 40 * DAY);
  assert.equal(St.pruneTombstones(s2, now), 0);
  t.dirty = false;
  assert.equal(St.pruneTombstones(s2, now), 1);
  // 정말 공간이 없으면 false (메모리 상태는 그대로)
  globalThis.localStorage = new MemStorage(10);
  assert.equal(St.save(s, now), false);
  assert.equal(s.events.length, 2);
});

test('setupFamily · addEvent · updateEvent · deleteEvent · restoreEvent', () => {
  const s = St.defaultState();
  const me = St.setupFamily(s, { name: ' 하린 ', birth: '2026-09-01', me: { role: 'sitter', name: '  ' } }, at(9));
  assert.equal(s.meId, me.id);
  assert.equal(me.name, '시터');
  assert.equal(me.emoji, '🧑‍🍼');
  assert.equal(s.family.name, '하린');
  assert.equal(s.family.dirty, true);
  assert.equal(St.me(s), me);
  const e = St.addEvent(s, { type: 'formula', data: { ml: 120.2, burp: 'yes', junk: 1 } }, at(10));
  assert.deepEqual([e.by, e.ts, e.updatedAt, e.rev, e.dirty, e.deleted], [me.id, at(10), at(10), 0, true, false]);
  assert.deepEqual(e.data, { ml: 120, burp: 'yes' });
  assert.ok(Sy.toWireEvent(e).dirty === undefined && Sy.toWireEvent(e).rev === undefined, 'dirty/rev 는 전송 안 함');
  assert.equal(St.addEvent(s, { type: 'pee', ts: at(8), by: null }, at(10)).by, null);
  assert.throws(() => St.addEvent(s, { type: 'both' }), TypeError);
  // 같은 id 로 다시 추가하면 기존 것
  const dupId = St.addEvent(s, { id: e.id, type: 'pee' }, at(11));
  assert.equal(dupId, e);
  // 수정: data 얕은 병합, null 은 키 삭제, updatedAt 은 시계가 뒤로 가도 증가
  const u = St.updateEvent(s, e.id, { data: { burp: null, ml: 140 }, ts: at(9, 50) }, at(5));
  assert.deepEqual(u.data, { ml: 140 });
  assert.equal(u.ts, at(9, 50));
  assert.equal(u.updatedAt, at(10) + 1);
  assert.equal(St.updateEvent(s, 'nope', {}), null);
  assert.equal(s.prefs.lastMl.formula, 140);
  // 종류 바꾸기 → data 도 새 종류 기준으로 정리
  const p = St.addEvent(s, { type: 'pee' }, at(12));
  St.updateEvent(s, p.id, { type: 'poop', data: { color: 'green' } }, at(12, 1));
  assert.deepEqual([p.type, p.data.color], ['poop', 'green']);
  St.deleteEvent(s, p.id, at(13));
  assert.equal(p.deleted, true);
  St.restoreEvent(s, p.id, at(14));
  assert.equal(p.deleted, false);
  assert.equal(p.updatedAt, at(14));
  assert.equal(St.dirtyEvents(s).length, 3);
  assert.equal(St.familyDirty(s), true);
});

test('upsertMember · memberById · setMe', () => {
  const s = St.defaultState();
  const g = St.upsertMember(s, { role: 'grandma', name: '외할머니이름이너무너무길어요' }, at(9));
  assert.equal(g.name, '외할머니이름이너무너무길', '12자까지');
  assert.equal(g.emoji, '👵');
  assert.equal(St.memberById(s, g.id), g);
  const again = St.upsertMember(s, { id: g.id, name: '할머니', isAdmin: true }, at(8));
  assert.equal(again, g);
  assert.equal(g.name, '할머니');
  assert.equal(g.isAdmin, undefined, '서버 소유 필드는 안 건드림');
  assert.equal(g.updatedAt, at(9) + 1);
  assert.equal(St.setMe(s, 'ghost'), false);
  assert.equal(St.setMe(s, g.id), true);
  assert.equal(St.dirtyMembers(s).length, 1);
});

test('logAction: 둘 다 = 두 건, 잠 토글(모두 끝내기), 터미타임 기본 5분, undoAction', () => {
  const s = setupShared();
  const both = St.logAction(s, 'both', { data: { color: 'yellow' } }, at(10));
  assert.equal(both.events.length, 2);
  assert.deepEqual(both.events.map((e) => e.type), ['pee', 'poop']);
  assert.equal(both.events[0].ts, both.events[1].ts);
  assert.equal(both.events[1].data.color, 'yellow');
  assert.equal(St.logAction(s, 'tummy', {}, at(10)).events[0].data.min, 5);
  const start = St.logAction(s, 'sleep', {}, at(11));
  assert.equal(start.kind, 'sleepStart');
  // 다른 기기에서도 '재우기'를 눌러 끝 없는 잠이 둘
  s.events.push({ id: 'other', type: 'sleep', ts: at(11, 5), by: null, data: {}, deleted: false, updatedAt: at(11, 5), rev: 3, dirty: false });
  const end = St.logAction(s, 'sleep', {}, at(12));
  assert.equal(end.kind, 'sleepEnd');
  assert.equal(end.events.length, 2);
  assert.ok(end.events.every((e) => e.data.end === at(12) && e.dirty));
  St.undoAction(s, end, at(12, 1));
  assert.ok(end.events.every((e) => e.data.end === undefined));
  St.undoAction(s, both, at(12, 2));
  assert.ok(both.events.every((e) => e.deleted));
  // 'N분 전' 칩으로 끝내기 — 시작보다 앞서면 시작 시각으로
  const r = St.toggleSleep(s, at(12, 5), { at: at(10) });
  assert.equal(r.kind, 'sleepEnd');
  assert.ok(r.events.every((e) => e.data.end >= e.ts));
});

test('absorb: 다른 탭이 저장한 상태를 LWW 로 합친다', () => {
  const a = setupShared();
  const b = JSON.parse(JSON.stringify(a));
  const e = St.addEvent(a, { type: 'pee' }, at(10));
  b.events.push({ ...JSON.parse(JSON.stringify(e)), data: { note: '탭B' }, updatedAt: at(11) });
  b.events.push({ id: 'only-b', type: 'poop', ts: at(9), by: null, data: {}, deleted: false, updatedAt: at(9), rev: 0, dirty: true });
  assert.equal(St.absorb(a, b), true);
  assert.equal(a.events.find((x) => x.id === e.id).data.note, '탭B');
  assert.ok(a.events.some((x) => x.id === 'only-b'));
  const c = JSON.parse(JSON.stringify(a));
  c.sync.familyId = 'other';
  assert.equal(St.absorb(a, c), false, '다른 가족이면 합치지 않음');
});

// =====================================================================
// sync.js — 순수 부분
// =====================================================================
test('parseInvite: 링크(#join= / ?join=), 코드만, 대소문자·하이픈·O/I/L 교정, 메시지 속 링크', () => {
  const C = '7K2M9PQRSTVWXYZ0';
  assert.equal(Sy.parseInvite(`https://wkdwlsgh29-del.github.io/uridaylog/baby-log/#join=${C}`), C);
  assert.equal(Sy.parseInvite(`http://localhost:5190/baby-log/?join=${C}&x=1`), C);
  assert.equal(Sy.parseInvite(`https://x.io/baby-log/?utm=a&join=${C.toLowerCase()}#top`), C);
  assert.equal(Sy.parseInvite(C), C);
  assert.equal(Sy.parseInvite(`  ${C.toLowerCase()}  `), C);
  assert.equal(Sy.parseInvite('7K2M-9PQR-STVW-XYZ0'), C);
  assert.equal(Sy.parseInvite('7K2M 9PQR STVW XYZO'), C, 'O → 0');
  assert.equal(Sy.parseInvite('IK2M9PQRSTVWXYZ0'), '1K2M9PQRSTVWXYZ0', 'I → 1');
  assert.equal(Sy.parseInvite(`하린 육아일지에 초대해요 👶\n링크를 눌러 '나는 누구'만 고르면 끝!\nhttps://wkdwlsgh29-del.github.io/uridaylog/baby-log/#join=${C}`), C);
  assert.equal(Sy.parseInvite(`초대 코드: ${C} 입니다`), C);
  assert.equal(Sy.parseInvite(`#join=${encodeURIComponent(C)}`), C);
  for (const bad of ['', '   ', 'hello', 'ABCD', `${C}X`, 'UUUUUUUUUUUUUUUU', '#join=', null, undefined, 42]) assert.equal(Sy.parseInvite(bad), null, String(bad));
});

test('endpoint(): 개발 덮어쓰기는 localhost·127.0.0.1 에서만, URL 파라미터로는 불가', () => {
  const brand = (BRAND.logEndpoint || '');
  browserEnv({ host: 'localhost' });
  assert.equal(Sy.endpoint(), DEV);
  assert.equal(Sy.canShare(), true);
  browserEnv({ host: '127.0.0.1' });
  assert.equal(Sy.endpoint(), DEV);
  browserEnv({ host: 'wkdwlsgh29-del.github.io' });
  assert.equal(Sy.endpoint(), brand, '배포 주소에서는 localStorage 덮어쓰기 무시');
  browserEnv({ host: 'localhost.evil.com' });
  assert.equal(Sy.endpoint(), brand);
  browserEnv({ host: 'localhost', dev: 'javascript:alert(1)' });
  assert.equal(Sy.endpoint(), brand, 'http(s) 만');
  globalThis.location = { hostname: 'wkdwlsgh29-del.github.io', href: `https://wkdwlsgh29-del.github.io/uridaylog/baby-log/?devEndpoint=${encodeURIComponent('https://evil.example/api')}#bl:devEndpoint=https://evil.example` };
  assert.equal(Sy.endpoint(), brand, 'URL 로는 못 바꿈');
  const savedLoc = globalThis.location;
  delete globalThis.location;
  assert.equal(Sy.endpoint(), brand, 'location 없으면 BRAND');
  globalThis.location = savedLoc;
});

test('inviteLink · quickUrl', () => {
  browserEnv();
  assert.equal(Sy.inviteLink('ABCD'), 'http://localhost:5190/baby-log/#join=ABCD');
  const saved = globalThis.location;
  delete globalThis.location;
  assert.equal(Sy.inviteLink('ABCD'), `${Sy.PUBLIC_URL}#join=ABCD`);
  globalThis.location = saved;
  const s = setupShared();
  assert.equal(Sy.quickUrl(s, 'pee'), '', '공유 전에는 없음');
  s.sync.token = 'tok_A-b';
  assert.equal(Sy.quickUrl(s, 'pee'), '', '기록 전용 키가 없으면 없음 — 기기 토큰은 절대 주소에 넣지 않는다');
  s.sync.quickKey = 'qk_Z-9';
  assert.equal(Sy.quickUrl(s, 'pee'), `${DEV}?a=q&k=qk_Z-9&t=pee`);
  assert.equal(Sy.quickUrl(s, 'formula', { ml: 120, side: undefined }), `${DEV}?a=q&k=qk_Z-9&t=formula&ml=120`);
  assert.ok(!Sy.quickUrl(s, 'pee').includes('tok_A-b'));
  s.sync.revoked = true;
  assert.equal(Sy.quickUrl(s, 'pee'), '');
});

test('mergeServer: LWW — 새 기록 추가, 서버가 같거나 새로우면 덮고 dirty 해제, 로컬 dirty 가 새로우면 유지', () => {
  const s = setupShared();
  const a = St.addEvent(s, { type: 'formula', data: { ml: 100 } }, at(10));   // dirty, updatedAt 10:00
  const b = St.addEvent(s, { type: 'pee' }, at(10));
  const c = St.addEvent(s, { type: 'pee' }, at(11));
  const w = (e, patch) => ({ ...Sy.toWireEvent(e), rev: 7, ...patch });
  const r = Sy.mergeServer(s, [
    w(a, { data: { ml: 100 } }),                                        // 같은 updatedAt → 확인
    w(b, { updatedAt: at(9), deleted: true }),                          // 서버가 더 오래됨 → 로컬 유지
    w(c, { updatedAt: at(12), data: { note: '아빠가 고침' } }),          // 서버가 새로움 → 서버
    { id: 'new-1', type: 'poop', ts: '1790500000000', by: 'x', data: { color: 'green' }, deleted: false, updatedAt: '1790500000001', rev: '9' },
    { id: 'junk' }, null, { id: 'bad-ts', type: 'pee', ts: null },
  ]);
  assert.deepEqual([r.added, r.updated, r.confirmed, r.changed], [1, 1, 2, true]);
  assert.equal(a.dirty, false);
  assert.equal(a.rev, 7);
  assert.equal(b.dirty, true);
  assert.equal(b.deleted, false);
  assert.equal(b.rev, 7, '로컬 유지해도 rev 는 기록');
  assert.equal(c.dirty, false);
  assert.equal(c.data.note, '아빠가 고침');
  const n = s.events.find((e) => e.id === 'new-1');
  assert.deepEqual([n.ts, n.updatedAt, n.rev, n.dirty], [1790500000000, 1790500000001, 9, false], '문자열 숫자(bigint)도 숫자로');
  assert.ok(!s.events.some((e) => e.id === 'junk' || e.id === 'bad-ts'));
  // 확인된 기록을 다른 기기가 다시 고침 → 반영
  const r2 = Sy.mergeServer(s, [w(a, { updatedAt: at(13), data: { ml: 120 }, rev: 12 })]);
  assert.equal(r2.updated, 1);
  assert.equal(a.data.ml, 120);
  // 서버에 없는 새 변경(깨끗한데 로컬이 더 새로움) → 다시 보내도록 dirty
  a.updatedAt = at(20);
  Sy.mergeServer(s, [w(a, { updatedAt: at(13), rev: 12 })]);
  assert.equal(a.dirty, true);
});

test('applyServerMeta: 구성원 LWW + 서버 소유 필드, 가족 LWW, meId 존중', () => {
  const s = setupShared();
  const meId = s.meId;
  const dad = St.upsertMember(s, { role: 'dad', name: '아빠' }, at(10));
  const changed = Sy.applyServerMeta(s, {
    members: [
      { id: meId, name: '엄마', role: 'mom', emoji: '👩', updatedAt: at(8), isAdmin: true, claimed: true },
      { id: dad.id, name: '서버아빠', role: 'dad', emoji: '👨', updatedAt: at(9) },
      { id: 'sit', name: '이모님', role: 'sitter', emoji: '', updatedAt: '5' },
    ],
    family: { id: 'fam-1', name: '서버하린', birth: '2026-09-02T00:00:00Z', updatedAt: at(8) },
    me: { memberId: 'sit', isAdmin: false },
  });
  assert.equal(changed, true);
  const m = St.memberById(s, meId);
  assert.equal(m.isAdmin, true);
  assert.equal(m.claimed, true);
  assert.equal(m.dirty, true, '로컬(9:00, dirty)이 서버(8:00)보다 새로우면 프로필 유지 — 서버 소유 필드만 반영');
  assert.equal(m.name, '엄마');
  assert.equal(dad.name, '아빠', '로컬 dirty 가 더 새로우면 유지');
  assert.equal(dad.dirty, true);
  const sit = St.memberById(s, 'sit');
  assert.deepEqual([sit.name, sit.role, sit.emoji, sit.updatedAt], ['이모님', 'sitter', '🧑‍🍼', 5]);
  assert.equal(s.family.name, '하린', '로컬 가족 정보가 dirty 이고 더 새로움');
  assert.equal(s.family.id, 'fam-1');
  assert.equal(s.meId, meId, '이 기기의 나는 그대로');
  assert.equal(s.sync.memberId, 'sit');
  s.family.dirty = false;
  Sy.applyServerMeta(s, { family: { name: '서버하린', birth: '2026-09-02', updatedAt: at(8) } });
  assert.deepEqual([s.family.name, s.family.birth], ['서버하린', '2026-09-02']);
  const fresh = St.defaultState();
  Sy.applyServerMeta(fresh, { members: [{ id: 'x', name: 'a', role: 'mom', updatedAt: 1 }], me: { memberId: 'x', isAdmin: true } });
  assert.equal(fresh.meId, 'x');
  assert.equal(fresh.sync.isAdmin, true);
});

// =====================================================================
// sync.js — API · 가짜 서버
// =====================================================================
test('api(): 성공 JSON, 오류 코드, 네트워크, 시간 초과(AbortController)', async () => {
  browserEnv();
  const ok = await Sy.api('peek', { invite: 'X' }, { fetch: async () => new Response(JSON.stringify({ ok: true, v: 1 }), { status: 200 }) });
  assert.equal(ok.v, 1);
  await assert.rejects(Sy.api('peek', {}, { fetch: async () => new Response(JSON.stringify({ ok: false, error: 'invite_invalid', message: '링크 만료' }), { status: 404 }) }),
    (e) => e instanceof Sy.ApiError && e.status === 404 && e.code === 'invite_invalid' && e.message === '링크 만료');
  await assert.rejects(Sy.api('sync', {}, { fetch: async () => new Response('<html>Bad gateway</html>', { status: 502 }) }),
    (e) => e.status === 502 && e.code === 'server' && e.message === Sy.ERROR_COPY.server);
  await assert.rejects(Sy.api('sync', {}, { fetch: async () => new Response('nope', { status: 200 }) }), (e) => e.code === 'bad_response');
  await assert.rejects(Sy.api('sync', {}, { fetch: async () => { throw new TypeError('Failed to fetch'); } }),
    (e) => e.status === 0 && e.code === 'network');
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));
  const t0 = Date.now();
  await assert.rejects(Sy.api('sync', {}, { fetch: hang, timeoutMs: 60 }), (e) => e.status === 0 && e.code === 'timeout');
  assert.ok(Date.now() - t0 < 1000);
  let sent;
  await Sy.api('sync', { k: 't' }, { fetch: async (u, init) => { sent = JSON.parse(init.body); return new Response('{"ok":true}'); } });
  assert.deepEqual(sent, { a: 'sync', k: 't' });
  browserEnv({ host: 'example.com' });
  if (!BRAND.logEndpoint) await assert.rejects(Sy.api('sync', {}), (e) => e.code === 'no_endpoint');
});

test('createFamily → 두 번째 기기 joinFamily → 양방향 동기화 → 동시 수정 LWW', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared(server);
  const f1 = St.addEvent(A, { type: 'formula', data: { ml: 120, burp: 'yes' } }, at(9, 10));
  const gone = St.addEvent(A, { type: 'pee' }, at(9, 20));
  St.deleteEvent(A, gone.id, at(9, 21));
  const res = await Sy.createFamily(A, at(9, 30));
  assert.ok(A.sync.token && A.sync.familyId && A.sync.isAdmin);
  assert.equal(A.sync.invite, res.invite);
  assert.equal(A.family.id, A.sync.familyId);
  assert.ok(A.events.filter((e) => !e.deleted).every((e) => !e.dirty && e.rev > 0), '올린 기록은 pull 로 확인됨');
  assert.equal(peekEvents(server, A.sync.familyId).length, 1, '툼스톤은 새 가족에 안 올림');
  assert.equal(JSON.parse(localStorage.getItem(St.KEY)).sync.token, A.sync.token, '토큰은 바로 저장');
  await assert.rejects(Sy.createFamily(A), (e) => e.code === 'already_shared');

  // 두 번째 기기 (다른 localStorage)
  const peek = await Sy.peekInvite(Sy.inviteLink(res.invite));
  assert.equal(peek.family.name, '하린');
  assert.equal(peek.members.length, 1);
  assert.equal(peek.members[0].claimed, true);
  const B = St.defaultState();
  await Sy.joinFamily(B, res.invite, { me: { role: 'dad', name: '아빠' } }, at(9, 40));
  assert.equal(B.family.name, '하린');
  assert.equal(B.family.birth, '2026-09-01');
  assert.equal(B.members.length, 2);
  assert.ok(B.events.some((e) => e.id === f1.id && e.data.ml === 120 && !e.dirty), 'A 의 기록을 받음');
  assert.equal(St.me(B).name, '아빠');

  // B 기록 → A 로
  const bp = St.addEvent(B, { type: 'poop', data: { color: 'yellow' } }, at(10));
  await Sy.syncNow(B, at(10, 1));
  assert.equal(bp.dirty, false);
  const ra = await Sy.syncNow(A, at(10, 2));
  assert.equal(ra.changed, true);
  const ap = A.events.find((e) => e.id === bp.id);
  assert.equal(ap.by, B.meId);

  // 같은 기록을 A 가 먼저(10:05), B 가 나중(10:07)에 오프라인으로 고침 → 먼저 올린 쪽과 무관하게 나중 수정이 이김
  St.updateEvent(B, f1.id, { data: { ml: 150 } }, at(10, 7));
  St.updateEvent(A, f1.id, { data: { ml: 130 } }, at(10, 5));
  await Sy.syncNow(B, at(10, 8));
  await Sy.syncNow(A, at(10, 9));
  const af = A.events.find((e) => e.id === f1.id);
  assert.equal(af.data.ml, 150);
  assert.equal(af.dirty, false);
  await Sy.syncNow(B, at(10, 10));
  assert.equal(B.events.find((e) => e.id === f1.id).data.ml, 150);
  assert.equal(peekEvents(server, A.sync.familyId).find((e) => e.id === f1.id).data.ml, 150);

  // 삭제(툼스톤)도 전달
  St.deleteEvent(A, bp.id, at(10, 20));
  await Sy.syncNow(A, at(10, 21));
  await Sy.syncNow(B, at(10, 22));
  assert.equal(B.events.find((e) => e.id === bp.id).deleted, true);

  // 구성원 프로필·아기 정보 변경도 전달
  St.upsertMember(B, { id: B.meId, name: '하린아빠' }, at(11));
  St.updateFamily(B, { name: '하린이' }, at(11));
  await Sy.syncNow(B, at(11, 1));
  assert.equal(St.dirtyMembers(B).length, 0);
  assert.equal(St.familyDirty(B), false);
  await Sy.syncNow(A, at(11, 2));
  assert.equal(St.memberById(A, B.meId).name, '하린아빠');
  assert.equal(A.family.name, '하린이');
});

test('syncNow: 서버 응답을 못 받아도 dirty 유지 → 다음 동기화에서 확인 (중복 없음)', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  await Sy.createFamily(A, at(9));
  const e = St.addEvent(A, { type: 'pee' }, at(9, 5));
  server.hook = async (body, handle) => { if (body.a === 'sync') { await handle(body); throw new TypeError('connection reset'); } };
  await assert.rejects(Sy.syncNow(A, at(9, 6)), (err) => err.code === 'network');
  assert.equal(e.dirty, true, '확인 못 받았으니 dirty');
  assert.equal(peekEvents(server, A.sync.familyId).filter((x) => x.id === e.id).length, 1, '서버엔 이미 저장');
  server.hook = null;
  await Sy.syncNow(A, at(9, 7));
  assert.equal(e.dirty, false);
  assert.equal(peekEvents(server, A.sync.familyId).filter((x) => x.id === e.id).length, 1);
  // 오프라인: 기록은 그대로 dirty
  const off = St.addEvent(A, { type: 'poop' }, at(9, 8));
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  await assert.rejects(Sy.syncNow(A, at(9, 9)));
  assert.equal(off.dirty, true);
  globalThis.fetch = server.fetch;
});

test('syncNow: 동기화 도중 사용자가 고친 기록은 dirty 로 남고 다음에 올라간다', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  await Sy.createFamily(A, at(9));
  const e = St.addEvent(A, { type: 'formula', data: { ml: 100 } }, at(10));
  let release;
  const gate = new Promise((r) => { release = r; });
  server.hook = async (body, handle) => { if (body.a === 'sync') { const r = await handle(body); await gate; return r; } };
  const p = Sy.syncNow(A, at(10, 1));
  await sleep(5);
  St.updateEvent(A, e.id, { data: { ml: 110 } }, at(10, 2));   // 요청이 날아가는 중에 수정
  const added = St.addEvent(A, { type: 'pee' }, at(10, 2));
  release();
  await p;
  server.hook = null;
  assert.equal(e.data.ml, 110, '로컬 수정이 이김');
  assert.equal(e.dirty, true, '서버 사본(100ml)이 더 오래됐으니 dirty 유지');
  assert.equal(added.dirty, true, '요청 뒤에 생긴 기록은 다음 동기화로');
  // syncNow 는 같은 호출 안에서 새로 생긴 dirty 도 다음 라운드에 보낸다
  await Sy.syncNow(A, at(10, 3));
  assert.equal(e.dirty, false);
  assert.equal(added.dirty, false);
  assert.equal(peekEvents(server, A.sync.familyId).find((x) => x.id === e.id).data.ml, 110);
});

test('syncNow: 페이지 나눔(more) 끝까지 받고, 많은 dirty 는 묶음으로 나눠 보냄, bigint 문자열 응답', async () => {
  browserEnv();
  const server = makeServer({ pageLimit: 3, stringNums: true });
  globalThis.fetch = server.fetch;
  const A = setupShared();
  for (let i = 0; i < 10; i++) St.addEvent(A, { type: 'pee', ts: at(8, i) }, at(8, i));
  await Sy.createFamily(A, at(9));
  assert.ok(A.events.every((e) => !e.dirty));
  const B = St.defaultState();
  await Sy.joinFamily(B, A.sync.invite, { me: { role: 'dad' } }, at(9, 1));
  assert.equal(B.events.length, 10, '3개씩 여러 번 받아 전부');
  assert.equal(typeof B.events[0].ts, 'number');
  assert.equal(B.sync.rev, Math.max(...B.events.map((e) => e.rev)));
  // 큰 묶음: 900개 → 한 요청 400개 이하로 나눠 보냄
  server.pageLimit = 1000;
  for (let i = 0; i < 900; i++) St.addEvent(B, { type: 'note', ts: at(10) + i, data: { text: `메모 ${i}` } }, at(10));
  const before = server.calls.length;
  await Sy.syncNow(B, at(11));
  const syncCalls = server.calls.slice(before).filter((c) => c.body.a === 'sync');
  assert.ok(syncCalls.length >= 3);
  assert.ok(syncCalls.every((c) => c.body.push.length <= 400 && c.init.body.length < 256 * 1024));
  assert.equal(B.events.filter((e) => e.dirty).length, 0);
  assert.equal(peekEvents(server, B.sync.familyId).length, 910);
});

test('syncNow: 401 → revoked=true 후 멈춤, 서버가 거부한 기록은 rejected 표시(무한 재전송 없음)', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  await Sy.createFamily(A, at(9));
  // 거부: 서버 검증에 안 맞는 기록 (분유인데 ml 없음)
  const bad = St.addEvent(A, { type: 'formula', data: {} }, at(9, 1));
  await Sy.syncNow(A, at(9, 2));
  assert.equal(bad.rejected, true);
  assert.equal(bad.dirty, false);
  assert.ok(A.events.includes(bad), '기기에는 남김');
  const n = server.calls.length;
  await Sy.syncNow(A, at(9, 3));
  assert.ok(server.calls.slice(n).every((c) => !c.body.push.some((e) => e.id === bad.id)), '다시 안 보냄');
  St.updateEvent(A, bad.id, { data: { ml: 90 } }, at(9, 4));
  await Sy.syncNow(A, at(9, 5));
  assert.equal(bad.rejected, undefined);
  assert.equal(bad.dirty, false, '고치면 다시 올라감');
  // 401
  server.devices.get(A.sync.token).revoked = true;
  const pending = St.addEvent(A, { type: 'pee' }, at(9, 6));
  await assert.rejects(Sy.syncNow(A, at(9, 7)), (e) => e.status === 401 && e.code === 'unauthorized');
  assert.equal(A.sync.revoked, true);
  assert.equal(pending.dirty, true, '기록은 그대로');
  const m = server.calls.length;
  assert.deepEqual(await Sy.syncNow(A, at(9, 8)), { changed: false, skipped: true });
  assert.equal(server.calls.length, m, '끊긴 뒤엔 요청 안 함');
  assert.equal(Sy.quickUrl(A, 'pee'), '');
  await assert.rejects(Sy.rotateInvite(A), (e) => e.code === 'not_shared');
});

test('joinFamily: 이 기기 기록 합치기(claim) — 내 기록은 참여한 구성원으로, 이미 공유 중이면 거부', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  const dadOnA = St.upsertMember(A, { role: 'dad', name: '아빠' }, at(9));
  await Sy.createFamily(A, at(9, 1));
  // 아빠 폰: 공유 전에 혼자 쓰던 기록 + 자리표시 할머니
  const B = St.defaultState();
  St.setupFamily(B, { name: '하린', birth: '2026-09-01', me: { role: 'dad' } }, at(8));
  const localMe = B.meId;
  const mine = St.addEvent(B, { type: 'formula', data: { ml: 90 } }, at(8, 30));
  const grandma = St.upsertMember(B, { role: 'grandma' }, at(8, 31));
  const byGrandma = St.addEvent(B, { type: 'pee', by: grandma.id }, at(8, 40));
  St.upsertMember(B, { role: 'grandpa' }, at(8, 41));   // 기록 없는 자리표시 → 안 올림
  await Sy.joinFamily(B, A.sync.invite, { claim: dadOnA.id, merge: true }, at(9, 2));
  assert.equal(B.meId, dadOnA.id);
  assert.equal(mine.by, dadOnA.id, '내 기록은 claim 한 구성원으로');
  assert.ok(!B.members.some((m) => m.id === localMe));
  assert.ok(!B.members.some((m) => m.role === 'grandpa'));
  const onServer = peekEvents(server, B.sync.familyId);
  assert.ok(onServer.some((e) => e.id === mine.id && e.by === dadOnA.id));
  assert.ok(onServer.some((e) => e.id === byGrandma.id && e.by === grandma.id), '할머니 기록과 구성원도 올림');
  await Sy.syncNow(A, at(9, 3));
  assert.ok(A.events.some((e) => e.id === mine.id));
  assert.ok(A.members.some((m) => m.id === grandma.id));
  await assert.rejects(Sy.joinFamily(B, A.sync.invite, {}), (e) => e.code === 'already_shared');
  // 버리고 참여
  const C = St.defaultState();
  St.setupFamily(C, { birth: '2026-01-01', me: { role: 'sitter' } }, at(8));
  const cLocal = St.addEvent(C, { type: 'pee' }, at(8));
  await Sy.joinFamily(C, `https://x/#join=${A.sync.invite}`, { me: { role: 'sitter', name: '이모님' }, merge: false }, at(9, 5));
  assert.ok(!C.events.some((e) => e.id === cLocal.id), '버리고 참여');
  assert.ok(!peekEvents(server, C.sync.familyId).some((e) => e.id === cLocal.id));
  assert.ok(C.events.some((e) => e.id === mine.id), '가족 기록은 받음');
  assert.equal(St.me(C).name, '이모님');
  assert.equal(C.family.birth, '2026-09-01');
  // 잘못된 초대
  await assert.rejects(Sy.joinFamily(St.defaultState(), 'ZZZZZZZZZZZZZZZZ', {}), (e) => e.code === 'invite_invalid' && e.status === 404);
});

test('rotateInvite · setAdmin · removeMember · leaveFamily', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  await Sy.createFamily(A, at(9));
  const old = A.sync.invite;
  const neu = await Sy.rotateInvite(A);
  assert.notEqual(neu, old);
  await assert.rejects(Sy.peekInvite(old), (e) => e.code === 'invite_invalid');
  const B = St.defaultState();
  await Sy.joinFamily(B, neu, { me: { role: 'dad' } }, at(9, 1));
  await assert.rejects(Sy.rotateInvite(B), (e) => e.code === 'forbidden' && e.status === 403);
  await Sy.syncNow(A, at(9, 2));
  await Sy.setAdmin(A, B.meId, true);
  assert.equal(St.memberById(A, B.meId).isAdmin, true);
  const inviteBefore = A.sync.invite;
  await Sy.removeMember(A, B.meId);
  assert.equal(St.memberById(A, B.meId).revoked, true);
  assert.ok(A.sync.invite && A.sync.invite !== inviteBefore, '내보내면 초대 링크도 새로');
  await assert.rejects(Sy.peekInvite(inviteBefore), (e) => e.code === 'invite_invalid');
  await assert.rejects(Sy.syncNow(B, at(9, 3)), (e) => e.status === 401);
  assert.equal(B.sync.revoked, true);
  // 공유 끊기: 남은 기록을 먼저 올리고, 기기 기록은 유지
  const last = St.addEvent(A, { type: 'pee' }, at(9, 4));
  await Sy.leaveFamily(A);
  assert.equal(A.sync.token, null);
  assert.equal(A.family.id, null);
  assert.ok(A.events.includes(last));
  assert.ok(peekEvents(server, [...server.fams.keys()][0]).some((e) => e.id === last.id), '끊기 전에 올림');
  assert.equal(JSON.parse(localStorage.getItem(St.KEY)).sync.token, null);
});

test('parseJoin · deviceLink: #dev= 는 기기 연결, #join= 은 초대, 코드만은 초대(explicit:false)', () => {
  browserEnv();
  const C = '7K2M9PQRSTVWXYZ0';
  assert.equal(Sy.deviceLink(C), `http://localhost:5190/baby-log/#dev=${C}`);
  assert.deepEqual(Sy.parseJoin(Sy.deviceLink(C)), { kind: 'device', code: C, explicit: true });
  assert.deepEqual(Sy.parseJoin(`이 링크를 새 폰에서 열어 주세요 https://x.io/baby-log/?dev=${C.toLowerCase()}`), { kind: 'device', code: C, explicit: true });
  assert.deepEqual(Sy.parseJoin(Sy.inviteLink(C)), { kind: 'invite', code: C, explicit: true });
  assert.deepEqual(Sy.parseJoin(C), { kind: 'invite', code: C, explicit: false });
  assert.equal(Sy.parseInvite(Sy.deviceLink(C)), null, '기기 연결 링크는 초대 코드가 아님');
  assert.equal(Sy.parseJoin('#dev=nope'), null);
  assert.equal(Sy.parseJoin('hello'), null);
});

test('여러 기기: 이미 쓰는 사람 claim 은 403 → 내 다른 기기 연결 코드로 같은 사람 연결 (코드만 붙여 넣어도 됨)', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  await Sy.createFamily(A, at(9));
  const mom = A.meId;
  // 엄마의 두 번째 기기(홈 화면 앱)가 초대 링크로 '엄마'를 고르면 403
  const A2 = St.defaultState();
  await assert.rejects(Sy.joinFamily(A2, A.sync.invite, { claim: mom }), (e) => e.status === 403 && e.code === 'forbidden');
  assert.equal(A2.sync.token, null, '실패하면 그대로');
  // 첫 기기에서 연결 코드 → 링크로 참여
  const dl = await Sy.createDeviceLink(A);
  assert.ok(dl.code && dl.expiresAt > Date.now());
  assert.equal(dl.link, Sy.deviceLink(dl.code));
  const pk = await Sy.peekInvite(dl.link);
  assert.equal(pk.kind, 'device');
  assert.equal(pk.member.id, mom);
  assert.deepEqual(pk.members.map((m) => m.id), [mom]);
  await Sy.joinFamily(A2, dl.link, { claim: 'ignored', merge: false }, at(9, 1));
  assert.equal(A2.meId, mom);
  assert.equal(St.me(A2).role, 'mom');
  await assert.rejects(Sy.joinFamily(St.defaultState(), dl.link, {}), (e) => e.code === 'invite_invalid', '1회용');
  // 코드만 붙여 넣기: 초대 404 → 기기 연결로 재시도
  const dl2 = await Sy.createDeviceLink(A);
  const pk2 = await Sy.peekInvite(dl2.code);
  assert.equal(pk2.kind, 'device');
  const A3 = St.defaultState();
  await Sy.joinFamily(A3, dl2.code.toLowerCase(), {}, at(9, 2));
  assert.equal(A3.meId, mom);
  // 둘 다 아니면 초대 오류 그대로
  await assert.rejects(Sy.peekInvite('ZZZZZZZZZZZZZZZZ'), (e) => e.code === 'invite_invalid');
  // 관리자: 기기만 끊기 → 그 자리를 다시 초대 링크로 차지 가능
  await Sy.unlinkMember(A, mom);
  await assert.rejects(Sy.syncNow(A2, at(9, 3)), (e) => e.status === 401);
  assert.equal(A2.sync.revoked, true);
});

test('syncNow: 서버가 reset(커서가 이상함) 이면 처음부터 받고 커서를 다시 맞춘다 · rejectedMembers 는 재전송 안 함', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  St.addEvent(A, { type: 'pee' }, at(8));
  await Sy.createFamily(A, at(9));
  const real = A.sync.rev;
  A.sync.rev = real + 5000;
  St.addEvent(A, { type: 'poop' }, at(9, 1));
  await Sy.syncNow(A, at(9, 2));
  assert.equal(A.sync.rev, Math.max(...peekEvents(server, A.sync.familyId).map((e) => e.rev)), '커서가 실제 최대 rev 로');
  assert.ok(A.events.every((e) => !e.dirty));
  const n = server.calls.length;
  await Sy.syncNow(A, at(9, 3));
  assert.equal(server.calls[n].body.since, A.sync.rev);
  // 서버가 거부한 구성원
  const bad = St.upsertMember(A, { role: 'dad', name: '아빠' }, at(9, 4));
  bad.role = 'alien';
  await Sy.syncNow(A, at(9, 5));
  assert.equal(bad.rejected, true);
  assert.equal(bad.dirty, false);
  const m = server.calls.length;
  await Sy.syncNow(A, at(9, 6));
  assert.ok(!server.calls[m].body.members.some((x) => x.id === bad.id));
});

test('syncNow: reset + more (여러 페이지) — 커서를 되돌려 끝까지 받고 멈춘다 (무한 반복·재다운로드 없음)', async () => {
  browserEnv();
  const server = makeServer({ pageLimit: 3, stringNums: true });
  globalThis.fetch = server.fetch;
  const A = setupShared();
  for (let i = 0; i < 10; i++) St.addEvent(A, { type: 'pee', ts: at(8, i) }, at(8, i));
  await Sy.createFamily(A, at(9));
  const real = A.sync.rev;
  assert.equal(real, Math.max(...peekEvents(server, A.sync.familyId).map((e) => e.rev)));
  // 서버 DB 를 옮기는 등으로 커서가 서버 최대 rev 보다 커짐 → 서버가 reset:true 로 처음부터 3개씩
  A.sync.rev = real + 10000;
  A.events = A.events.slice(0, 2);   // 로컬에서 사라진 기록도 다시 받아야 함
  const n0 = server.calls.length;
  await Sy.syncNow(A, at(9, 5));
  const calls = server.calls.slice(n0);
  assert.equal(calls[0].body.since, real + 10000);
  assert.equal(calls[1].body.since, 3, '리셋 뒤 커서는 첫 페이지 끝(3)으로 — 옛 큰 커서로 돌아가지 않음');
  assert.ok(calls.length <= 5, `페이지 수만큼만 요청 (${calls.length})`);
  assert.equal(A.events.length, 10);
  assert.equal(A.sync.rev, real);
  // 다음 동기화는 제자리 (아무것도 다시 받지 않음)
  const n1 = server.calls.length;
  const r = await Sy.syncNow(A, at(9, 6));
  assert.equal(server.calls.length - n1, 1);
  assert.equal(server.calls[n1].body.since, real);
  assert.equal(r.changed, false);
});

test('많은 기록 공유 시작: create 는 500개 이하로 싣고, 나머지는 sync 가 500개 이하씩 나눠 보냄', async () => {
  browserEnv();
  const server = makeServer();
  const LIMIT = 500;
  // 실제 서버처럼 한 요청 500개 초과면 413
  server.hook = async (b) => {
    const list = b.a === 'create' ? b.events : b.push;
    if (Array.isArray(list) && list.length > LIMIT) return new Response(JSON.stringify({ ok: false, error: 'too_large' }), { status: 413 });
    return undefined;
  };
  globalThis.fetch = server.fetch;
  const A = setupShared();
  for (let i = 0; i < 1300; i++) St.addEvent(A, { type: i % 2 ? 'pee' : 'poop', ts: at(0) + i * MIN }, at(0) + i * MIN);
  await Sy.createFamily(A, at(9));
  const create = server.calls.find((c) => c.body.a === 'create');
  assert.ok(create.body.events.length > 0 && create.body.events.length <= LIMIT, `create ${create.body.events.length}`);
  const pushes = server.calls.filter((c) => c.body.a === 'sync').map((c) => c.body.push.length);
  assert.ok(pushes.every((n) => n <= LIMIT), pushes.join(','));
  assert.equal(peekEvents(server, A.sync.familyId).length, 1300);
  assert.equal(A.events.filter((e) => e.dirty).length, 0);
});

test('pairId: 앱(sync.js)과 서버(handler.js)가 같은 대변 id 를 만든다 (알림 버튼 둘 다 · 응답 유실 중복 방지)', async () => {
  const { pairId: serverPairId } = await import('../../supabase/functions/uriday-log/handler.js');
  for (let i = 0; i < 50; i++) {
    const id = crypto.randomUUID();
    assert.equal(Sy.pairId(id), serverPairId(id));
    assert.notEqual(Sy.pairId(id), id);
    assert.equal(Sy.pairId(Sy.pairId(id)), id);
  }
  assert.equal(Sy.pairId('0F8E1C2A-3B4D-4E5F-8A6B-0123456789AB'), '0f8e1c2a-3b4d-4e5f-8a6b-fedcba987654');
  // 수신함의 'both' 한 건 → 소변(id) + 대변(pairId(id))
  browserEnv();
  const s = setupShared();
  const id = crypto.randomUUID();
  const cache = await caches.open(Sy.SW_DATA_CACHE);
  await cache.put(`http://localhost:5190/baby-log/__bl/inbox/${id}`, new Response(JSON.stringify({ id, type: 'both', ts: at(3), data: { src: 'notif' } })));
  await Sy.drainInbox(s, at(3, 1));
  assert.deepEqual(s.events.map((e) => [e.type, e.id]).sort(), [['pee', id], ['poop', serverPairId(id)]]);
});

// =====================================================================
// 서비스워커 연결
// =====================================================================
test('writeSwConfig · drainInbox(한 건씩 + 배열 호환, id 중복 제거, 저장 후 삭제) · clearSwData', async () => {
  browserEnv();
  const s = setupShared();
  s.sync.token = 'tok-9';
  s.prefs.lastMl.formula = 130;
  assert.equal(await Sy.writeSwConfig(s), true);
  const cache = await caches.open(Sy.SW_DATA_CACHE);
  const cfg = await (await cache.match('http://localhost:5190/baby-log/__bl/config')).json();
  assert.deepEqual(cfg, { v: 1, endpoint: DEV, token: 'tok-9', meId: s.meId, selfId: s.meId, meName: '엄마', meEmoji: '👩', quickActions: ['pee', 'poop'], lastMl: { formula: 130 }, babyName: '하린' });
  // 이 기기에서 고른 양이 없으면 가족의 마지막 기록 양 (다른 가족이 160 을 기록 → 알림 버튼도 160)
  const s2 = setupShared();
  s2.events.push({ id: 'srv-1', type: 'formula', ts: at(7), by: null, data: { ml: 160 }, deleted: false, updatedAt: at(7), rev: 3, dirty: false });
  assert.deepEqual(Sy.swConfig(s2).lastMl, { formula: 160 });
  // 수신함 기록의 '누가' = 이 기기 주인 (구성원 전환과 무관 — 온라인이면 서버가 토큰의 사람으로 기록하므로)
  const gma = St.upsertMember(s2, { role: 'grandma' }, at(8));
  St.setMe(s2, gma.id);
  assert.equal(Sy.swConfig(s2).selfId, s2.selfId);
  assert.notEqual(Sy.swConfig(s2).selfId, gma.id);
  s.sync.revoked = true;
  await Sy.writeSwConfig(s);
  assert.equal((await (await cache.match('http://localhost:5190/baby-log/__bl/config')).json()).token, null, '끊기면 토큰 안 줌');

  const base = 'http://localhost:5190/baby-log/__bl/inbox';
  const id1 = '11111111-1111-4111-8111-111111111111';
  const id2 = '22222222-2222-4222-8222-222222222222';
  await cache.put(`${base}/${id1}`, new Response(JSON.stringify({ id: id1, type: 'pee', ts: at(3, 10) })));
  await cache.put(`${base}/${id2}`, new Response(JSON.stringify({ id: id2, type: 'both', ts: at(3, 20), by: 'dad-id' })));
  await cache.put(`${base}/bad`, new Response('{not json'));
  await cache.put(base, new Response(JSON.stringify([{ id: id1, type: 'pee', ts: at(3, 10) }, { type: 'thanks', ts: 1 }, { type: 'formula', ts: at(3, 30), data: { ml: 120 } }])));
  const r = await Sy.drainInbox(s, at(8));
  assert.equal(r.imported, 4, 'pee + both(2) + 배열의 formula (중복 pee·숨은 종류 제외)');
  const pee = s.events.find((e) => e.id === id1);
  assert.deepEqual([pee.by, pee.dirty, pee.data.src, pee.ts], [s.meId, true, 'notif', at(3, 10)]);
  const pair = s.events.filter((e) => e.ts === at(3, 20));
  assert.deepEqual(pair.map((e) => e.type).sort(), ['pee', 'poop']);
  assert.ok(pair.every((e) => e.by === 'dad-id'));
  assert.equal((await cache.keys()).filter((k) => k.url.includes('/__bl/inbox')).length, 0, '가져온 뒤 비움');
  assert.ok(JSON.parse(localStorage.getItem(St.KEY)).events.some((e) => e.id === id1), '지우기 전에 저장');
  // 같은 항목이 다시 와도 중복 없음 (both 의 대변 id 도 결정적)
  await cache.put(`${base}/${id2}`, new Response(JSON.stringify({ id: id2, type: 'both', ts: at(3, 20) })));
  assert.equal((await Sy.drainInbox(s, at(8, 1))).imported, 0);
  // 저장 실패하면 수신함을 지우지 않음
  await cache.put(`${base}/x`, new Response(JSON.stringify({ id: '33333333-3333-4333-8333-333333333333', type: 'poop', ts: at(4) })));
  globalThis.localStorage = new MemStorage(10);
  assert.equal((await Sy.drainInbox(s, at(8, 2))).imported, 1);
  assert.equal((await cache.keys()).filter((k) => k.url.includes('/__bl/inbox')).length, 1, '저장 못 했으니 남김');
  assert.equal(await Sy.clearSwData(), true);
  assert.deepEqual(await caches.keys(), []);
  delete globalThis.caches;
  assert.deepEqual(await Sy.drainInbox(s), { imported: 0 });
  assert.equal(await Sy.writeSwConfig(s), false);
});

// =====================================================================
// 자동 동기화 루프
// =====================================================================
test('startAutoSync: kick 디바운스 → 동기화·저장·onChange, 가려질 때 한 번 밀어내기(keepalive), 가려진 동안 주기 동기화 없음, 401 이면 멈춤', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const win = new EventTarget();
  globalThis.document = doc;
  globalThis.window = win;
  let ctrl;
  try {
    let state = setupShared();
    await Sy.createFamily(state, at(9));
    const changes = [];
    ctrl = Sy.startAutoSync(() => state, (s, info) => changes.push(info), { debounceMs: 20, intervalMs: 60 });
    await sleep(30);
    assert.equal(ctrl.status(), 'ok');
    const e = St.addEvent(state, { type: 'pee' }, Date.now());
    ctrl.kick();
    ctrl.kick();
    await sleep(80);
    assert.equal(e.dirty, false);
    assert.ok(JSON.parse(localStorage.getItem(St.KEY)).events.some((x) => x.id === e.id && !x.dirty), '동기화 후 저장');
    assert.ok(changes.some((c) => c.status === 'ok'));

    // 가려짐: 보낼 게 있으면 keepalive 로 한 번
    const h = St.addEvent(state, { type: 'poop' }, Date.now());
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await sleep(30);
    const hideCall = server.calls.filter((c) => c.body.a === 'sync').at(-1);
    assert.equal(hideCall.init.keepalive, true);
    assert.ok(hideCall.body.push.some((x) => x.id === h.id));
    const n = server.calls.length;
    await sleep(200);
    assert.equal(server.calls.length, n, '가려진 동안 주기 동기화 없음');
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await sleep(30);
    assert.ok(server.calls.length > n, '다시 보이면 바로');

    // 오프라인 → 대기 → online 이벤트로 바로 재시도
    globalThis.fetch = async () => { throw new TypeError('offline'); };
    ctrl.now();
    await sleep(20);
    assert.equal(ctrl.status(), 'offline');
    globalThis.fetch = server.fetch;
    win.dispatchEvent(new Event('online'));
    await sleep(30);
    assert.equal(ctrl.status(), 'ok');

    // 401 → revoked, 더 이상 요청 안 함
    server.devices.get(state.sync.token).revoked = true;
    ctrl.now();
    await sleep(30);
    assert.equal(ctrl.status(), 'revoked');
    assert.equal(state.sync.revoked, true);
    assert.ok(changes.at(-1).status === 'revoked');
    const m = server.calls.length;
    ctrl.kick();
    await sleep(150);
    assert.equal(server.calls.length, m);

    // getState 가 새 객체로 바뀌면(초기화) 옛 결과를 저장하지 않음
    state = St.defaultState();
    St.save(state);
    await ctrl.now();
    assert.equal(JSON.parse(localStorage.getItem(St.KEY)).events.length, 0);
    assert.equal(ctrl.status(), 'off');
  } finally {
    ctrl?.stop();
    delete globalThis.document;
    delete globalThis.window;
  }
});

// =====================================================================
// 리뷰 수정분: 기기 주인(ownerId) · 같은 가족 다시 참여 · 기록 전용 키 · updatedAt 잘림
// =====================================================================
const byCount = (list) => list.filter((e) => !e.deleted).reduce((m, e) => { m[e.by] = (m[e.by] || 0) + 1; return m; }, {});

test('다시 참여(같은 가족): 구성원 전환(할머니)으로 남긴 기록이 새 사람에게 옮겨지지 않는다 — 합치기/버리기 모두', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  const gma = St.upsertMember(A, { role: 'grandma', name: '할머니' }, at(8));
  const dadOnA = St.upsertMember(A, { role: 'dad', name: '아빠' }, at(8));
  St.setMe(A, gma.id);
  for (let i = 0; i < 3; i++) St.addEvent(A, { type: 'pee' }, at(8, 10 + i));   // 엄마 폰에서 할머니 이름으로 3건
  St.setMe(A, A.selfId);
  await Sy.createFamily(A, at(9));
  assert.equal(A.sync.memberId, A.selfId, '기기는 엄마');
  // 아빠 폰: 아빠로 참여 → 전환을 할머니로 두고 1건
  const B = St.defaultState();
  await Sy.joinFamily(B, A.sync.invite, { claim: dadOnA.id }, at(9, 1));
  St.setMe(B, gma.id);
  St.addEvent(B, { type: 'formula', data: { ml: 100 } }, at(9, 2));
  await Sy.syncNow(B, at(9, 3));
  const fid = A.sync.familyId;
  assert.deepEqual(byCount(peekEvents(server, fid)), { [gma.id]: 4 });
  // 관리자가 아빠 폰 연결 해제 → 아빠가 자기 자리로 다시 참여 (버리고 참여)
  await Sy.unlinkMember(A, dadOnA.id);
  await assert.rejects(Sy.syncNow(B, at(9, 4)), (e) => e.status === 401);
  assert.equal(B.sync.revoked, true);
  assert.equal(St.ownerId(B), dadOnA.id, '끊겨도 기기 주인은 아빠 (전환은 할머니)');
  St.addEvent(B, { type: 'pee' }, at(9, 5));   // 끊긴 사이 (전환이 할머니라 by=할머니)
  await Sy.joinFamily(B, A.sync.invite, { claim: dadOnA.id, merge: false }, at(9, 6));
  assert.deepEqual(byCount(peekEvents(server, fid)), { [gma.id]: 5 }, '서버의 할머니 기록 그대로 + 끊긴 사이 기록도 올라감');
  assert.deepEqual(byCount(B.events), { [gma.id]: 5 });
  await Sy.syncNow(A, at(9, 7));
  assert.deepEqual(byCount(A.events), { [gma.id]: 5 }, '다른 기기에서도 그대로');
});

test('물려받은 폰(공유 끊기 → 다른 사람으로 같은 가족에 참여 + 합치기): 옛 주인의 서버 기록은 그대로, 끊긴 뒤 새로 남긴 것만 새 사람으로', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  const mom = A.selfId;
  const gma = St.upsertMember(A, { role: 'grandma', name: '할머니' }, at(8));
  for (let i = 0; i < 5; i++) St.addEvent(A, { type: 'pee' }, at(8, 10 + i));
  await Sy.createFamily(A, at(9));
  const fid = A.sync.familyId;
  const invite = A.sync.invite;
  await Sy.leaveFamily(A);
  assert.equal(A.selfFamilyId, fid, '끊어도 어느 가족이었는지 기억');
  const after = St.addEvent(A, { type: 'formula', data: { ml: 90 } }, at(9, 30));   // 끊긴 뒤 이 폰에서 새로
  await Sy.joinFamily(A, invite, { claim: gma.id, merge: true }, at(10));
  assert.deepEqual(byCount(peekEvents(server, fid)), { [mom]: 5, [gma.id]: 1 });
  assert.equal(after.by, gma.id);
  assert.equal(A.meId, gma.id);
  assert.equal(A.selfId, gma.id);
});

test('공유 끊은 뒤 같은 가족에 "새 사람"으로 참여: 옛 내 자리(빈 자리)를 몰래 차지하지 않고 새 구성원으로', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  const mom = A.selfId;
  const gma = St.upsertMember(A, { role: 'grandma', name: '할머니' }, at(8));
  St.addEvent(A, { type: 'pee' }, at(8, 30));
  await Sy.createFamily(A, at(9));
  const invite = A.sync.invite;
  await Sy.leaveFamily(A);
  St.setMe(A, gma.id);   // 전환을 할머니로 둔 채
  await Sy.joinFamily(A, invite, { me: { role: 'dad', name: '새아빠' }, merge: true }, at(10));
  const joined = server.calls.filter((c) => c.body.a === 'join').pop().body;
  assert.ok(joined.me.id !== mom && joined.me.id !== gma.id, '옛 id 를 다시 쓰지 않음');
  assert.equal(St.me(A).name, '새아빠');
  assert.equal(A.sync.memberId, joined.me.id);
  assert.deepEqual(byCount(peekEvents(server, A.sync.familyId)), { [mom]: 1 });
});

test('가족 공유 켜기: 구성원 전환을 할머니로 둔 채 켜도 이 기기(와 관리자)는 기기 주인', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  const mom = A.selfId;
  const gma = St.upsertMember(A, { role: 'grandma' }, at(8));
  St.setMe(A, gma.id);
  await Sy.createFamily(A, at(9));
  assert.equal(server.calls[0].body.meId, mom);
  assert.equal(A.sync.memberId, mom);
  assert.equal(A.meId, gma.id, '전환은 그대로');
  assert.equal(St.ownerId(A), mom);
});

test('joinFamily: nonce·me.id 를 그대로 보내 다시 시도해도 같은 참여 (응답 유실)', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  await Sy.createFamily(A, at(9));
  const nonce = Sy.makeJoinNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(Sy.makeJoinNonce(), nonce);
  const meId = '44444444-4444-4444-8444-444444444444';
  let first = true;
  server.hook = async (body, handle) => {
    if (body.a === 'join' && first) { first = false; await handle(body); throw new TypeError('network'); }   // 서버엔 들어갔는데 응답이 끊김
  };
  const B = St.defaultState();
  await assert.rejects(Sy.joinFamily(B, A.sync.invite, { me: { id: meId, role: 'sitter', name: '이모님' }, nonce }, at(9, 1)), (e) => e.code === 'network');
  await Sy.joinFamily(B, A.sync.invite, { me: { id: meId, role: 'sitter', name: '이모님' }, nonce }, at(9, 2));
  const joins = server.calls.filter((c) => c.body.a === 'join').map((c) => c.body);
  assert.equal(joins.length, 2);
  assert.ok(joins.every((j) => j.nonce === nonce && j.me.id === meId));
  assert.equal(B.meId, meId);
});

test('mergeServer · applyServerMeta: 서버가 미래 updatedAt 을 잘라 돌려주면 그 서버본을 받아들인다 (끝없이 다시 보내지 않음)', async () => {
  browserEnv();
  const s = setupShared();
  const now = at(9);
  const far = now + 365 * DAY;
  const e = St.addEvent(s, { type: 'pee' }, far);   // 시계가 1년 빠른 기기
  const serverTime = now;
  const clamped = serverTime + Sy.UPDATED_AT_FUTURE_MS;
  const r = Sy.mergeServer(s, [{ ...Sy.toWireEvent(e), updatedAt: clamped, rev: 7 }], serverTime);
  assert.equal(r.confirmed, 1);
  assert.equal(e.dirty, false);
  assert.equal(e.updatedAt, clamped);
  // serverTime 없이(옛 방식)면 로컬 유지
  const e2 = St.addEvent(s, { type: 'pee' }, far);
  Sy.mergeServer(s, [{ ...Sy.toWireEvent(e2), updatedAt: clamped, rev: 8 }]);
  assert.equal(e2.dirty, true);
  // 로컬이 정말 더 새로우면(서버본이 잘린 값보다 작음) 여전히 로컬 유지
  const e3 = St.addEvent(s, { type: 'pee' }, far);
  Sy.mergeServer(s, [{ ...Sy.toWireEvent(e3), updatedAt: now - MIN, rev: 9 }], serverTime);
  assert.equal(e3.dirty, true);
  // 구성원·가족도 같게
  const m = St.me(s);
  St.upsertMember(s, { id: m.id, name: '엄마2' }, far);
  St.updateFamily(s, { name: '하린2' }, far);
  Sy.applyServerMeta(s, { serverTime, members: [{ ...Sy.toWireMember(m), updatedAt: clamped }], family: { name: '하린2', birth: s.family.birth, updatedAt: clamped } });
  assert.equal(m.dirty, false);
  assert.equal(s.family.dirty, false);
});

test('ensureQuickKey: 기록 전용 키를 받아 잠금화면 주소에 넣고, 새로 만들면 바뀐다 · signOutOtherDevices', async () => {
  browserEnv();
  const server = makeServer();
  globalThis.fetch = server.fetch;
  const A = setupShared();
  assert.equal(Sy.quickUrl(A, 'pee'), '');
  await Sy.createFamily(A, at(9));
  assert.equal(Sy.quickUrl(A, 'pee'), '', '키 받기 전');
  const k1 = await Sy.ensureQuickKey(A);
  assert.equal(await Sy.ensureQuickKey(A), k1, '있으면 다시 안 받음');
  assert.equal(Sy.quickUrl(A, 'pee'), `${DEV}?a=q&k=${k1}&t=pee`);
  assert.ok(!Sy.quickUrl(A, 'pee').includes(A.sync.token));
  const k2 = await Sy.ensureQuickKey(A, { rotate: true });
  assert.notEqual(k2, k1);
  assert.equal(A.sync.quickKey, k2);
  // 내 다른 기기 모두 끊기
  const dl = await Sy.createDeviceLink(A);
  const A2 = St.defaultState();
  await Sy.joinFamily(A2, dl.link, {}, at(9, 1));
  await Sy.signOutOtherDevices(A);
  await assert.rejects(Sy.syncNow(A2, at(9, 2)), (e) => e.status === 401);
  await Sy.syncNow(A, at(9, 2));
  // 공유를 끊으면 키도 사라짐
  await Sy.leaveFamily(A);
  assert.equal(A.sync.quickKey, null);
  assert.equal(Sy.quickUrl(A, 'pee'), '');
});
