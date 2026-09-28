# baby-tools — 육아 미니 도구 모음

인스타그램으로 무료 배포하는 육아 도구 모음. 각 도구는 **가입·설치 없이 링크 하나로 열리는 모바일 웹앱**이다.

## 구조

```
baby-tools/
  shared/            ← 모든 도구가 공유하는 단일 소스
    css/base.css     ← 디자인 토큰 + 공통 컴포넌트 (색·폰트·버튼·카드)
    js/brand.js      ← 브랜드 설정 (이름, 인스타 핸들, URL) — 여기 한 곳만 수정
    js/date-utils.js ← 날짜 계산 유틸
    js/ics.js        ← 캘린더(.ics) 파일 생성
  vaccine-calendar/  ← 도구 1호: 접종·검진 캘린더 생성기
    index.html
    style.css        ← 이 도구 전용 스타일
    schedule-data.js ← 접종·검진 일정 데이터 (질병관리청/건보공단 기준) — 데이터 단일 소스
    app.js           ← 로직
  baby-log/          ← 도구 6호: 함께 육아일지 (엄마·아빠·시터 공유 기록 + 교대 요약 + 잠금화면 기록)
    index.html · style.css · app.js   ← 화면 (밤 모드 포함)
    log-data.js      ← 기록 종류·성장 단계(레벨)·팀 미션·도감·대변 색·참고 기준 — 데이터 단일 소스
    logic.js         ← 순수 계산 (통계·단계·교대 요약·CSV)
    store.js         ← 이 기기 저장 (localStorage 'bl:v1')
    sync.js          ← 가족 공유 서버 연결 · 병합 · 서비스워커 수신함
    sw.js · manifest.webmanifest · icons/  ← 홈 화면 앱(PWA) · 오프라인 · 안드로이드 알림 버튼
    tests/           ← node --test baby-log/tests/
supabase/
  migrations/20260928000000_uriday_log.sql  ← 함께 육아일지 전용 스키마 uriday
  functions/uriday-ics/   ← 캘린더 파일 서버 함수
  functions/uriday-log/   ← 함께 육아일지 동기화 서버 함수 (handler.js = 로직, index.ts = Deno 진입점)
```

## 원칙

- **데이터와 로직 분리**: 일정이 바뀌면 `schedule-data.js`만 수정한다.
- **브랜드 단일 소스**: 인스타 핸들·서비스명은 `shared/js/brand.js`에서만 관리.
- **의존성 제로**: 프레임워크·빌드 없이 정적 파일. 어디에나 배포 가능(Vercel/Netlify/GitHub Pages).
- **모바일 우선**: 인스타 인앱 브라우저에서 열리는 게 기본 시나리오. 가볍고 빠르게.

## 로컬 실행

```
npx -y serve . -l 5180
```

→ http://localhost:5180/vaccine-calendar/

함께 육아일지를 가족 공유까지 로컬에서 확인하려면 (PostgreSQL 필요):

```
cd supabase/functions/uriday-log && npm install
DATABASE_URL=postgresql://postgres@localhost:54329/babylog node dev-server.mjs   # 정적 파일 + /api
```

→ http://localhost:5190/baby-log/ 를 열고 브라우저 콘솔에서
`localStorage['bl:devEndpoint'] = 'http://localhost:5190/api'` 후 새로고침 (localhost 에서만 동작).

테스트: `node --test baby-log/tests/` (앱 로직) · `cd supabase/functions/uriday-log && npm test` (서버, DATABASE_URL 필요)

## 배포

- **웹**: GitHub Pages — `main`에 push하면 자동 배포. https://wkdwlsgh29-del.github.io/uridaylog/
- **캘린더 서버 함수**: Supabase Edge Function `uriday-ics` (프로젝트 bmedbitonzkggfenymog, 공개·JWT 없음).
  소스는 `supabase/functions/uriday-ics/` — **`schedule-data.js` 등 일정 파일을 수정하면 이 함수도 재배포**해야
  웹과 캘린더 파일의 일정이 어긋나지 않는다 (함수에 저장소 원본 파일을 동봉해 배포하는 구조).
- **함께 육아일지 서버 함수**: Supabase Edge Function `uriday-log` (같은 프로젝트 bmedbitonzkggfenymog, 공개·JWT 없음 —
  기기 토큰으로 인증). 비워 두면(`shared/js/brand.js` 의 `logEndpoint: ''`) 앱은 '이 기기만' 모드로 동작한다.
  배포 순서:
  1. 마이그레이션 먼저: `supabase/migrations/20260928000000_uriday_log.sql` (SQL Editor / `supabase db push`) —
     전용 스키마 `uriday`, 모든 테이블 RLS 켜고 정책 없음(anon·authenticated 접근 불가, 함수만 직접 접속).
  2. `supabase/functions/uriday-log/` 의 **index.ts · handler.js · parse.js** 세 파일을 함께 업로드, `verify_jwt=false`.
     (dev-server.mjs · package.json · test/ 는 로컬 전용 — 올리지 않는다)
  3. Secrets: `SUPABASE_DB_URL` 은 Supabase 기본 제공. `BL_SALT`(선택)는 레이트 리밋용 IP 해시 salt — 긴 랜덤 문자열.
  4. `shared/js/brand.js` 의 `logEndpoint` 를 `https://bmedbitonzkggfenymog.supabase.co/functions/v1/uriday-log` 로 바꾸고 push.
  5. (선택) 아이폰 잠금화면 단축어를 iCloud 링크로 배포하면 `brand.js` 의 `iosShortcuts` 에 종류별 링크를 넣는다
     (가져오기 질문으로 '코드'=기기 토큰을 받는 단축어). 비워 두면 앱이 단축어를 직접 만드는 안내를 보여준다.
  - **handler.js · parse.js 를 고치면 함수도 재배포**해야 한다. 기록 종류를 늘릴 땐 `baby-log/log-data.js` 와
    `handler.js` 의 TYPES 를 함께 바꾼다 (서버가 모르는 종류는 거부된다).
  - `baby-log/sw.js` 의 `CACHE` 이름은 앱 파일 구성이 크게 바뀔 때만 올린다. 데이터 캐시 `uriday-bl-data`
    (알림 버튼 설정·수신함)는 이름을 바꾸지 않는다 — 바꾸면 아직 가져오지 않은 알림 기록이 사라질 수 있다.
