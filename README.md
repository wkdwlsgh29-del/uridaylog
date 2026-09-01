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

## 배포

- **웹**: GitHub Pages — `main`에 push하면 자동 배포. https://wkdwlsgh29-del.github.io/uridaylog/
- **캘린더 서버 함수**: Supabase Edge Function `uriday-ics` (프로젝트 bmedbitonzkggfenymog, 공개·JWT 없음).
  소스는 `supabase/functions/uriday-ics/` — **`schedule-data.js` 등 일정 파일을 수정하면 이 함수도 재배포**해야
  웹과 캘린더 파일의 일정이 어긋나지 않는다 (함수에 저장소 원본 파일을 동봉해 배포하는 구조).
