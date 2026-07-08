# 로싸인(LawSign) 백엔드 연동 API 계약서 (v1)

> 프론트엔드 프로토타입의 `js/api.js`는 본 계약과 **함수 단위 1:1**로 대응한다.
> 실 서버 연동 시 각 함수 본문만 `fetch()` 호출로 교체하며, 화면 코드는 수정하지 않는다.

- Base URL: `https://api.lawsign.example/api/v1`
- 인증: `Authorization: Bearer <JWT>` (워크스페이스 스코프 클레임 포함)
- 규약: JSON body, `snake_case`? → 본 계약은 `camelCase` 채택. 시간은 ISO-8601(UTC).
- 오류: `{ "error": { "code": "DOCUMENT_NOT_FOUND", "message": "..." } }` + HTTP 상태 코드

---

## 1. 데이터 모델 (ERD)

```
 Workspace 1 ─── * Document 1 ─── * Signer
                     │ 1                │
                     ├──── * Field ─────┘ (signerId)
                     ├──── * AuditEvent
                     └──── 0..1 VerificationRecord (완료 시 생성)
```

### Document

| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID | 문서 고유 식별자 |
| workspaceId | UUID | 소속 워크스페이스 |
| title | string | 문서 제목 |
| originalFileUrl | string | 원본 PDF 스토리지 경로(S3 등, 서명 URL로 응답) |
| status | enum | `DRAFT` `SCHEDULED` `NEED_MY_SIGN` `PENDING_OTHERS` `COMPLETED` `REJECTED` |
| label | string? | 라벨 (합의서·처벌불원서 등) |
| expirationDays | int | 서명 기한(일) |
| isLocked | bool | 완료 문서 잠금 여부 |
| scheduledAt | datetime? | 예약 발송 시각 |
| lastActivityAt | datetime | 마지막 활동 (칸반 정렬·리마인드 뱃지 기준) |
| completedAt | datetime? | 전체 서명 완료 시각 |

### Signer

| 필드 | 타입 | 설명 |
|---|---|---|
| id / documentId | UUID | |
| name | string | 서명자 이름 |
| contactType | enum | `EMAIL` `PHONE` `IN_PERSON` |
| contactValue | string | 이메일 또는 휴대폰 |
| signingOrder | int? | 순차 서명 시 순서 (null = 동시 발송) |
| authMethod | enum | `KAKAO` `EMAIL_LINK` `CERT` `IN_PERSON` |
| status | enum | `WAITING` `VIEWED` `SIGNED` `REJECTED` |

### Field (서명/입력 필드)

| 필드 | 타입 | 설명 |
|---|---|---|
| id / documentId / signerId | UUID | |
| fieldType | enum | `SIGNATURE` `TEXT` `CHECKBOX` `DATE` `IMAGE` |
| pageNumber | int | 배치 페이지 |
| x, y, w, h | decimal | **원본 대비 상대 좌표·크기(%)** — px 저장 금지 |
| value | string? | 서명 완료 후 입력값 |

### VerificationRecord (위변조 검증 원장)

| 필드 | 타입 | 설명 |
|---|---|---|
| documentId | UUID | PK/FK |
| fileHashSha256 | char(64) | 최종 PDF 버퍼의 SHA-256 (1바이트 변조 시 전면 변경) |
| blockchainTxId | string? | 프라이빗 체인 트랜잭션 ID (고도화 옵션) |
| issuerWorkspace | string | 발행처 표시명 |
| createdAt / completedAt | datetime | 발행·잠금 시각 |

### AuditEvent

| 필드 | 타입 | 설명 |
|---|---|---|
| documentId | UUID | |
| type | enum | `ISSUED` `VIEWED` `SIGNED` `LOCKED` `REMIND` `STATUS` |
| actor | string | 행위자 |
| occurredAt | datetime | 초 단위 타임스탬프 |
| ip / userAgent | string | 접속 환경 (부인 방지 근거) |

---

## 2. 엔드포인트

### 2.1 대시보드

`GET /dashboard/summary` → `api.getDashboardSummary()`

```json
{
  "counts": { "NEED_MY_SIGN": 1, "PENDING_OTHERS": 32, "COMPLETED": 325, "SCHEDULED": 1, "DRAFT": 3 },
  "trend": [ { "date": "06.08", "completed": 11 } ],
  "urgent": [ { "id": "…", "title": "합의서(장호철)_피해자 장태근 님", "lastActivityAt": "…" } ]
}
```

- `counts`는 CQRS 읽기 전용 리플리카에서 집계. `urgent`는 `PENDING_OTHERS` && 3일 < 경과 ≤ 15일.

### 2.2 문서

| Method | Path | 프로토타입 함수 | 비고 |
|---|---|---|---|
| GET | `/documents?status=&q=&label=&cursor=&size=` | `listDocuments(params)` | 커서 페이지네이션, 칸반은 상태별 병렬 호출 |
| GET | `/documents/{id}` | `getDocument(id)` | signers·fields·audit 포함(`?include=`) |
| POST | `/documents/upload` | — | `multipart/form-data` PDF → `{documentId, originalFileUrl}` |
| PUT | `/documents/{id}` | (편집기 자동 저장) | **디바운스 1s 후 Bulk Update** — fields 배열 통째 교체 |
| PATCH | `/documents/{id}` | `updateDocumentStatus(id, status)` | 칸반 DnD. Optimistic → 실패 시 클라이언트 롤백 |
| POST | `/documents/{id}/send` | `sendDocument(payload)` | 202 Accepted — 발송은 메시지 큐 비동기 처리 |
| POST | `/documents/{id}/remind` | `remindSigners(id)` | 미서명자 대상 카카오톡·이메일 독촉, `{sent: n}` |
| POST | `/documents/{id}/notify` | `sendNotification(id, payload)` | 메일함 발신. `channel: EMAIL`(Gmail API `users.messages.send`, OAuth2 `gmail.send` 스코프) 또는 `KAKAO`(비즈메시지 알림톡 승인 템플릿). 202 + `{sent, channel, messageId}`, 감사 로그 `NOTIFY` 기록 |
| GET | `/documents/calendar?year=&month=` | (클라이언트 집계) | 일자별 `{sent, signed, waiting}` 집계 — 발송약정=해당일 발송·예약, 서명됨=해당일 체결, 서명대기=해당일 발송분 중 미체결. 서명 기한·예약 발송은 Google Calendar API로 사용자 캘린더에 이벤트 동기화 |

`POST /documents/{id}/send` 요청 예:

```json
{
  "title": "260707 합의서(김영신)_피해자",
  "label": "합의서",
  "expirationDays": 14,
  "scheduledAt": null,
  "signers": [ { "name": "김영신", "contact": "ys.kim@example.com" } ],
  "fields": [ { "fieldType": "SIGNATURE", "signerIdx": 0, "pageNumber": 1, "x": 62.0, "y": 84.0, "w": 21.0, "h": 6.0 } ]
}
```

### 2.3 연락처·템플릿

| Method | Path | 프로토타입 함수 | 비고 |
|---|---|---|---|
| GET | `/contacts?q=` | `searchContacts(q)` | prefix 검색, 클라이언트 300ms 디바운스 전제, 최대 5건 |
| GET | `/templates` | `listTemplates()` | 필드 좌표 사전 세팅 포함 — 대량전송 시 2단계 생략 근거 |

### 2.4 대량전송 (M4)

- `POST /bulk-requests` — `{templateId, recipients[], options}` → 202 + `{jobId}`
- `GET /bulk-requests/{jobId}` — 진행률 폴링 or SSE. 실 발송은 큐 컨슈머(Worker)가 병렬 처리.

### 2.5 위변조 검증 (비인증 공개 API)

`POST /verify` → `api.verifyHash(hex)`

```json
// 요청 — 원본 파일이 아닌 해시 문자열만 전송 (Zero-Knowledge)
{ "hash": "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92" }

// 200 일치
{ "valid": true, "record": { "documentId": "…", "title": "…", "issuer": "법무법인청",
  "completedAt": "…", "txId": "0x1f98…" } }

// 200 불일치
{ "valid": false }
```

- Rate limit 필수(비인증 엔드포인트). 응답에 원본 파일·서명자 연락처 등 민감 정보 미포함.
- QR 딥링크: `GET /verify/{token}` — 토큰 디코딩 후 원본 뷰어 + 감사 타임라인 페이지 렌더.

---

## 3. 서버 아키텍처 요구사항 (요약)

1. **메시지 큐 비동기 발송**: `send`/`bulk` 는 Kafka·RabbitMQ 적재 후 즉시 202 응답. Worker가 알림톡·이메일·PDF 병합을 병렬 소비.
2. **MSA 분리**: PDF 파싱·병합(도장 렌더링)은 CPU 집약 → 전용 렌더링 서비스로 격리, L7 게이트웨이 라우팅 + 오토 스케일링.
3. **CQRS**: 대시보드 집계·문서함 조회는 읽기 리플리카로 분산. 쓰기 병목 격리.
4. **Redis 캐싱**: 템플릿 목록·메타데이터는 인메모리 캐시 응답.
5. **해시 파이프라인**: 잠금 시점에 최종 PDF 버퍼 SHA-256 생성 → `verification_records` 기록 → (옵션) 프라이빗 블록체인 트랜잭션 → 인증서 페이지 병합 + QR 워터마크.

## 4. 프론트엔드 트래픽 계약 (클라이언트 의무)

| 이벤트 | 의무 |
|---|---|
| 필드 드래그 | 조작 종료 후 1s 디바운스 1회 `PUT` (초당 60회 좌표 전송 금지) |
| 검색 입력 | 500ms 디바운스 |
| 자동완성 | 300ms 디바운스 + 2자 이상 |
| 칸반 DnD | Optimistic 반영 후 단일 `PATCH`, 실패 시 롤백 |
| 목록 | 커서 페이지네이션 준수, 무한 전체 조회 금지 |
