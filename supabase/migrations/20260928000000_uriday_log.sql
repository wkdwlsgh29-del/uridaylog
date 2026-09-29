-- uridaylog 6호 도구「함께 육아일지」— 가족 공유 동기화 스키마 (schema: uriday)
--
-- 접근 원칙
--   · 이 스키마는 Edge Function `uriday-log` 가 SUPABASE_DB_URL(postgres 역할, 직접 연결)로만 읽고 쓴다.
--   · anon / authenticated / service_role 에는 스키마·테이블 권한을 주지 않는다 (PostgREST 로 노출 안 됨).
--   · 모든 테이블 RLS 활성 + 정책 없음 → 혹시 권한이 새어 나가도 행이 보이지 않는다.
--   · 토큰·초대코드·기기 연결 코드는 sha256 해시만 저장한다. IP 는 salt 와 함께 해시한 버킷 이름으로만 남는다.
--
-- 설계 메모
--   · members / events 의 기본키는 (family_id, id) 복합키다. id 는 클라이언트가 만든 uuid 라서,
--     '공유 끊기 → 다시 공유'나 '응답 유실 후 재시도'처럼 같은 id 가 다른 가족에 다시 올라와도
--     서로 덮어쓰지 않고 가족별로 따로 저장된다 (가족 간 격리가 스키마 수준에서 보장됨).
--   · rev 는 전역 시퀀스 uriday.rev_seq 에서 받는다. 같은 가족의 쓰기는 families 행 잠금
--     (select ... for update)으로 직렬화하므로, 한 가족 안에서 rev 는 커밋 순서대로 증가한다
--     → 클라이언트 커서(since)가 아직 커밋 안 된 작은 rev 를 건너뛰는 일이 없다.
--   · PostgreSQL 16(로컬 테스트) / 17(Supabase) 양쪽에서 동작. ON DELETE SET NULL (컬럼목록)은 15+.
--
-- 적용: Supabase 대시보드 SQL Editor(또는 supabase db push / MCP apply_migration)로 postgres 역할로 실행.

create schema if not exists uriday;

-- ── 가족 (아기 1명 = 가족 1개) ─────────────────────────────────────────────
create table if not exists uriday.families (
  id          uuid primary key default gen_random_uuid(),
  baby_name   text not null default '' check (char_length(baby_name) <= 10),
  birth_date  date,
  invite_hash text unique check (invite_hash ~ '^[0-9a-f]{64}$'),   -- sha256(초대코드)
  invite_at   timestamptz,
  updated_at  bigint not null default 0,                              -- epoch ms, LWW
  created_at  timestamptz not null default now()
);

-- ── 구성원 (엄마·아빠·시터…; 기기 없이 '기록만' 하는 자리표시 구성원 포함) ─────
create table if not exists uriday.members (
  family_id  uuid not null references uriday.families(id) on delete cascade,
  id         uuid not null,
  name       text not null check (char_length(name) between 1 and 12),
  role       text not null check (role in ('mom', 'dad', 'sitter', 'grandma', 'grandpa', 'other')),
  emoji      text not null default '' check (octet_length(emoji) <= 32),  -- ZWJ 이모지(👨‍👩‍👧 18B) 여유
  is_admin   boolean not null default false,
  revoked_at timestamptz,
  updated_at bigint not null default 0,                                  -- epoch ms, 프로필 LWW
  created_at timestamptz not null default now(),
  primary key (family_id, id)
);

-- ── 기기 (기기 토큰 = 이 기기가 누구로 기록하는지) ─────────────────────────
create table if not exists uriday.devices (
  token_hash   text primary key check (token_hash ~ '^[0-9a-f]{64}$'),  -- sha256(기기 토큰)
  family_id    uuid not null references uriday.families(id) on delete cascade,
  member_id    uuid not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at   timestamptz,
  foreign key (family_id, member_id) references uriday.members(family_id, id) on delete cascade
);
create index if not exists devices_member_idx on uriday.devices (family_id, member_id);
-- 기록 전용 키(잠금화면 단축어 주소에 넣는 키) — quick 기록만 되고 동기화·관리 동작은 안 된다. sha256 만 저장.
alter table uriday.devices add column if not exists quick_hash text unique check (quick_hash ~ '^[0-9a-f]{64}$');
-- 참여 요청 nonce 의 sha256 — 응답이 끊겨 같은 참여를 다시 보내면 그때 만든 기기를 이어 준다 (자리 중복·403 방지)
alter table uriday.devices add column if not exists join_hash text check (join_hash ~ '^[0-9a-f]{64}$');
create index if not exists devices_join_idx on uriday.devices (family_id, join_hash) where join_hash is not null;

-- ── 기록 ─────────────────────────────────────────────────────────────────
create sequence if not exists uriday.rev_seq as bigint;

create table if not exists uriday.events (
  family_id  uuid not null references uriday.families(id) on delete cascade,
  id         uuid not null,
  member_id  uuid,                                                        -- 누가 (null = 알 수 없음)
  type       text not null check (type ~ '^[a-z_]{2,16}$'),
  ts         bigint not null,                                             -- 사건 시각 epoch ms
  data       jsonb not null default '{}'::jsonb
             check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 2048),
  deleted    boolean not null default false,                              -- 툼스톤
  updated_at bigint not null,                                             -- epoch ms, LWW
  rev        bigint not null,                                             -- uriday.rev_seq
  created_at timestamptz not null default now(),
  primary key (family_id, id),
  foreign key (family_id, member_id) references uriday.members(family_id, id)
    on delete set null (member_id)
);
create unique index if not exists events_family_rev_idx on uriday.events (family_id, rev);
create index if not exists events_family_ts_idx on uriday.events (family_id, ts);

-- ── 기기 연결 코드 ("내 다른 기기 연결": 이미 기기가 있는 구성원에 새 기기를 붙이는 1회용 코드) ──
--   초대 링크로는 기기가 없는 자리(자리표시 구성원)만 차지할 수 있다. 이미 쓰는 사람의 두 번째 기기는
--   그 사람의 기존 기기에서 이 코드를 만들어야만 연결된다 (초대 링크만 가진 사람이 엄마·관리자를 가로채지 못하게).
--   15분 만료 · 한 번만 사용 · 같은 구성원이 새로 만들면 이전 코드는 지워짐.
create table if not exists uriday.device_links (
  code_hash  text primary key check (code_hash ~ '^[0-9a-f]{64}$'),   -- sha256(연결 코드)
  family_id  uuid not null references uriday.families(id) on delete cascade,
  member_id  uuid not null,
  expires_at bigint not null,                                           -- epoch ms (발급 시각 + 15분)
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  foreign key (family_id, member_id) references uriday.members(family_id, id) on delete cascade
);
create index if not exists device_links_member_idx on uriday.device_links (family_id, member_id);

-- ── 간단한 요청 제한 (create/join/peek; 버킷 = 동작 + sha256(ip+salt), 1시간 창) ──
create table if not exists uriday.rate (
  bucket       text primary key,
  count        integer not null default 0,
  window_start timestamptz not null default now()
);

-- ── 권한: 함수(postgres 역할) 외에는 아무도 못 본다 ──────────────────────────
alter table uriday.families enable row level security;
alter table uriday.members  enable row level security;
alter table uriday.devices  enable row level security;
alter table uriday.events   enable row level security;
alter table uriday.device_links enable row level security;
alter table uriday.rate     enable row level security;

revoke all on schema uriday from public;
revoke all on all tables in schema uriday from public;
revoke all on all sequences in schema uriday from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema uriday from %I', r);
      execute format('revoke all on all tables in schema uriday from %I', r);
      execute format('revoke all on all sequences in schema uriday from %I', r);
    end if;
  end loop;
end $$;
-- 함수가 접속하는 postgres 역할(SUPABASE_DB_URL)은 보통 소유자라 이미 모든 권한이 있다.
-- 다른 역할(예: supabase_admin)로 적용됐을 때를 대비해 명시적으로 준다 (소유자면 아무 변화 없음).
grant usage on schema uriday to postgres;
grant select, insert, update, delete on all tables in schema uriday to postgres;
grant usage, select on all sequences in schema uriday to postgres;

comment on schema uriday is 'uridaylog 함께 육아일지 — Edge Function uriday-log 전용 (직접 연결로만 접근)';
comment on table uriday.events is '육아 기록. 가족별 (family_id, id) 유일, rev 는 가족 행 잠금 아래에서 커밋 순서대로 증가';
