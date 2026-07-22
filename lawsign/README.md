# 로싸인 (LawSign) — 법무 특화 전자서명 워크스페이스

법무법인·기업 법무팀을 위한 차세대 전자계약 클라우드 워크스페이스의 **프론트엔드 기획·설계·프로토타입** 납품 패키지입니다.

## 구성

| 경로 | 내용 |
|---|---|
| [`docs/SPEC.md`](./docs/SPEC.md) | **고객 납품용 개발 명세서** — AS-IS/TO-BE 화면 설계, 반응형·성능·보안 아키텍처, 수용 기준·마일스톤 |
| [`docs/API.md`](./docs/API.md) | **백엔드 연동 계약서** — ERD, REST 엔드포인트, 트래픽 계약(디바운스 정책) |
| [`frontend/`](./frontend) | **동작하는 프로토타입** — 의존성·빌드 없이 브라우저에서 바로 실행되는 SPA |

## 프로토타입 실행

```sh
# 방법 1: 단일 파일 배포본 — 파일 하나로 어디서든 동작 (고객 전달용 권장)
open lawsign/frontend/lawsign-standalone.html

# 방법 2: 개발 소스 그대로 열기
open lawsign/frontend/index.html

# 방법 3: 로컬 서버
npx serve lawsign/frontend
```

단일 파일 배포본은 CSS를 JS에서 주입하므로 `<style>` 태그를 제거하는
뷰어·새니타이저 환경에서도 디자인이 깨지지 않습니다. 소스 수정 후에는
`node lawsign/scripts/build-standalone.mjs` 로 재생성합니다.
업그레이드 이력은 [`docs/UPGRADE_PLAN.md`](./docs/UPGRADE_PLAN.md) 참조.

## 구현된 화면

- **홈 대시보드** (`#/dashboard`) — 파이프라인 통계 카드, 30일 완료 추이 차트, 마감 임박 위젯(원클릭 독촉 알림), 퀵 템플릿
- **문서함** (`#/documents`) — 리스트 ⇄ **칸반 보드** 토글, Optimistic 드래그 앤 드롭(발송 확인 모달·실패 롤백), 디바운스 검색, URL 필터 상태 보존, 리마인드 필요 뱃지 자동화
- **서명 요청** (`#/request`) — 페이지 이동 없는 3단계 스테퍼: 스마트 연락처 자동완성 → **자석 스냅 필드 편집기**(Touch & Floating, 상대 좌표, 전 페이지 복사) → 발송 전 체크리스트 + 백그라운드 발송
- **검증 포털** (`#/validator`) — 브라우저 내 SHA-256(Web Crypto) Zero-Knowledge 원본 검증. 정품/변조 샘플 파일로 두 경로 모두 재현 가능
- **감사추적 인증서** (`#/certificate?id=…`) — 해시·TXID·타임라인·검증 QR, 인쇄 최적화

라이트/다크 테마 자동 대응, 768px 이하에서 하단 탭 내비게이션·칸반 가로 스와이프로 전환됩니다.

## 백엔드 연동 방식

`frontend/js/api.js` 가 [`docs/API.md`](./docs/API.md) 계약과 함수 단위 1:1로 대응하는 모의 백엔드입니다.
실 서버 연동 시 **화면 코드는 수정하지 않고** 이 파일의 함수 본문만 `fetch()` 호출로 교체합니다.
