// uridaylog — 함께 육아일지 가족 공유 동기화 함수 (uriday-log)
// 공개 엔드포인트: 가입 없는 가족 공유라 JWT 검증 없음. 인증은 요청의 기기 토큰(k)으로 한다.
// 저장: 전용 스키마 uriday — 토큰·초대코드는 sha256 해시만, IP 는 salt 해시 버킷으로만 남긴다.
// 로직은 전부 handler.js (Node 테스트·로컬 dev-server 와 같은 파일). 이 파일은 Deno 진입점일 뿐.
//
// ⚠ 배포 방법 (순서대로):
//   1) 마이그레이션 먼저 적용: supabase/migrations/20260928000000_uriday_log.sql
//      (대시보드 SQL Editor / supabase db push / MCP apply_migration — postgres 역할로 실행)
//   2) 아래 3개 파일을 같은 폴더로 함께 업로드:
//      - index.ts (이 파일)
//      - handler.js (서버 로직)
//      - parse.js (받아쓰기 한 문장 파서)
//      ※ dev-server.mjs, package.json, test/ 는 로컬 전용 — 올리지 않는다.
//   3) 배포 대상: 육아 기록 전용 Supabase 프로젝트 (무료 조직 uridaylog, 서울 리전 — 다른 서비스 DB 와 분리),
//      함수명 uriday-log, verify_jwt=false (단축어·앱이 Supabase JWT 없이 부른다)
//   4) 비밀값(Secrets):
//      - SUPABASE_DB_URL: Supabase 가 모든 Edge Function 에 기본으로 넣어 주는 secret — 따로 설정할 필요 없음.
//      - BL_SALT (선택): 레이트 리밋용 IP 해시 salt. 긴 랜덤 문자열 권장. 바꿔도 리밋 카운터만 초기화된다.
//   5) 웹 연결: shared/js/brand.js 의 logEndpoint =
//      'https://<육아일지 프로젝트 ref>.supabase.co/functions/v1/uriday-log'
//   handler.js·parse.js 를 고치면 이 함수도 재배포해야 한다.
//
// 로컬 확인: SUPABASE_DB_URL=postgresql://postgres@localhost:54329/babylog deno run -A index.ts  (포트 8000)
import postgres from 'npm:postgres@3';
import { createHandler } from './handler.js';

const dbUrl = Deno.env.get('SUPABASE_DB_URL');
if (!dbUrl) throw new Error('SUPABASE_DB_URL 이 없어요 (Supabase 기본 secret)');

// prepare:false — Supabase 풀러(트랜잭션 모드)에서도 안전하게. 동시 연결은 인스턴스당 3개.
const sql = postgres(dbUrl, { prepare: false, max: 3 });

Deno.serve(createHandler({ sql, salt: Deno.env.get('BL_SALT') ?? '' }));
