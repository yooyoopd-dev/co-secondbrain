# CO-Hub — 사내 로컬 동기화 서버

프로젝트 단위 CO 영역을 동료와 주고받기 위한 사내망 서버.
클라우드 없음. 사내 IP로만 접근.

> 설계 원칙 한 줄: **허브는 멍청하다.** LLM도, 비즈니스 로직도 없다.
> 페이지 버전 관리 · blob 보관 · 이벤트 로그 · 토큰 확인이 전부다.

---

## 1. 왜 멍청한 서버인가

| 결과 | 이유 |
|---|---|
| 서버에 LLM API 키가 없음 | 인제스트·질의·린트는 각자 PC의 CLI가 수행 |
| 서버가 죽어도 일이 멈추지 않음 | 로컬 미러만으로 읽기·인제스트·질의 전부 가능 |
| 구형 사내 PC 한 대로 충분 | 파일 서빙과 SQLite 쓰기가 전부 |
| 백업이 파일 복사 | `hub.sqlite` + `blobs/` 디렉터리 |

---

## 2. 배포

```
Node 20+ / Fastify / better-sqlite3 / 파일시스템 blob store
단일 프로세스. 외부 DB 없음.
```

```
C:\co-hub\
├─ hub.sqlite
├─ blobs\
│   └─ 9f\2a\9f2a3c...            # sha256 앞 4자리로 분산
├─ config.json
└─ co-hub.exe                     # 또는 node server.js
```

Windows 서비스 등록은 `nssm`. Docker 이미지도 제공하되 사내에서 Docker를 못 쓰는 경우가
많으므로 **단일 실행 파일이 기본 배포 형태**입니다.

`config.json`:

```json
{
  "bind": "0.0.0.0",
  "port": 7777,
  "dataDir": "C:\\co-hub",
  "tls": null,
  "maxBlobBytes": 268435456
}
```

---

## 3. 데이터 모델

```sql
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,            -- 'ACME'
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 0   -- 검토 큐 강제 여부
);

CREATE TABLE members (
  space_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,         -- 'hong@corp'
  role     TEXT NOT NULL,         -- 'admin' | 'writer' | 'reader'
  PRIMARY KEY (space_id, user_id)
);

CREATE TABLE tokens (
  token_hash TEXT PRIMARY KEY,    -- sha256. 평문 저장 안 함
  user_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked    INTEGER NOT NULL DEFAULT 0
);

-- 페이지의 현재 상태
CREATE TABLE pages (
  space_id TEXT NOT NULL,
  page_id  TEXT NOT NULL,         -- 'ent-acme-corp'
  path     TEXT NOT NULL,         -- 'wiki/entities/acme-corp.md'
  version  INTEGER NOT NULL,
  hash     TEXT NOT NULL,         -- sha256(content)
  content  TEXT NOT NULL,         -- front-matter 포함 전문
  deleted  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (space_id, page_id)
);

-- 전 버전 보관 → 3-way 병합의 base, 되돌리기
CREATE TABLE page_versions (
  space_id TEXT NOT NULL, page_id TEXT NOT NULL, version INTEGER NOT NULL,
  hash TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  PRIMARY KEY (space_id, page_id, version)
);

-- 원본 파일 메타. 실물은 blobs/
CREATE TABLE blobs (
  space_id TEXT NOT NULL, sha256 TEXT NOT NULL,
  filename TEXT NOT NULL, bytes INTEGER NOT NULL, mime TEXT,
  uploaded_at TEXT NOT NULL, uploaded_by TEXT NOT NULL,
  PRIMARY KEY (space_id, sha256)
);

-- 동기화 커서의 기준이자 log.md의 정본
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- ingest | query | lint | contribute | page | blob
  page_id TEXT, ref TEXT, title TEXT,
  actor TEXT NOT NULL, at TEXT NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL,           -- open | approved | rejected
  note TEXT, changeset TEXT NOT NULL,   -- ChangeSet JSON
  decided_by TEXT, decided_at TEXT
);
```

`page_versions`를 전량 보관하는 이유: 3-way 병합의 base와 되돌리기가 여기서 나옵니다.
마크다운이라 용량 부담이 없습니다 (원본 500건 프로젝트 기준 수십 MB 예상 — M0에서 실측).

---

## 4. API

전부 `Authorization: Bearer <token>`. 응답은 JSON (blob 제외).

### 동기화

```
GET  /v1/spaces
GET  /v1/spaces/{s}/changes?since={seq}&limit=500
     → { events:[...], nextSeq, hasMore }

GET  /v1/spaces/{s}/pages/{pageId}[?version=N]
     → { pageId, path, version, hash, content, updatedBy, updatedAt }

PUT  /v1/spaces/{s}/pages/{pageId}
     If-Match: {baseVersion}          # 신규는 If-None-Match: *
     body: { path, content }
     → 200 { version, hash }
     → 409 { serverVersion, serverContent, baseContent }   # 3-way 병합 재료 동봉
     → 403 권한 없음 / 412 검토 큐 필수 공간

DELETE /v1/spaces/{s}/pages/{pageId}   If-Match: {baseVersion}
```

409 응답이 병합에 필요한 세 조각(base / 서버 / 내 것 중 앞의 둘)을 **한 번에** 돌려주는 것이
왕복을 줄이는 핵심입니다.

### Blob (지연 다운로드)

```
POST /v1/spaces/{s}/blobs            # multipart. 서버가 sha256 계산·검증
     → { sha256, bytes, dedup: true|false }
HEAD /v1/spaces/{s}/blobs/{sha256}   # 존재·크기만
GET  /v1/spaces/{s}/blobs/{sha256}   # Range 지원
```

콘텐츠 주소 방식이라 동일 파일을 여러 명이 올려도 한 번만 저장됩니다.

### 검토 큐

```
POST /v1/spaces/{s}/proposals        body: { note, changeset }
GET  /v1/spaces/{s}/proposals?status=open
POST /v1/spaces/{s}/proposals/{id}/approve    # 서버가 ops를 순차 적용. 하나라도 409면 전체 롤백
POST /v1/spaces/{s}/proposals/{id}/reject     body: { note }
```

### 관리

```
POST /v1/admin/spaces                 { id, title, reviewRequired }
POST /v1/admin/members                { spaceId, userId, role }
POST /v1/admin/tokens                 { userId, expiresAt }  → 평문 토큰 1회만 반환
POST /v1/admin/tokens/{id}/revoke
GET  /v1/health
```

---

## 5. 클라이언트 동기화 알고리즘

```
1. GET /changes?since=<로컬 커서>
2. 원격 변경을 로컬 미러에 반영
   - 로컬에 보류 변경이 없는 페이지 → 그대로 덮어씀
   - 보류 변경이 있는 페이지 → 충돌 표시, 사람이 해결
3. .sb/sync/pending 을 순회하며 PUT
   - 200 → 보류 제거, 로컬 버전 갱신
   - 409 → base/서버/내 것으로 3-way 병합 화면
4. 커서 저장
5. index.md · log.md 재생성 (동기화 대상 아님)
```

**조용한 덮어쓰기는 어느 방향으로도 일어나지 않습니다.**

blob은 이 흐름에 없습니다. 인용을 클릭하거나 "오프라인 고정"을 켤 때 개별로 받습니다.

---

## 5.5 MCP 엔드포인트 (조건부 — `PLAN.md` §7.2 안 B 채택 시)

허브가 동기화 API와 **같은 프로세스, 같은 토큰**으로 읽기 전용 MCP HTTP 엔드포인트를
제공합니다. 동료는 로컬 설치 없이 사내 URL만 CLI에 등록하면 됩니다.

```
POST /mcp                          # MCP Streamable HTTP
     Authorization: Bearer <token>  # 동기화 API와 동일한 토큰
```

노출 도구 (**전부 읽기 전용**):

| 도구 | 반환 |
|---|---|
| `search_wiki(query, limit)` | 후보 페이지 목록 (id, title, summary) |
| `get_page(page_id)` | 페이지 전문 + front-matter |
| `get_neighbors(page_id)` | 링크로 연결된 페이지들 |
| `find_path(from, to)` | 두 개념을 잇는 최단 경로 |
| `get_index(category?)` | index.md 상당의 카탈로그 |

**쓰기 도구는 노출하지 않습니다.** ChangeSet 생성은 §7.1의 CLI 실행 경로를 그대로 씁니다 —
에이전트가 쓰기 도구를 직접 호출하면 "사람 승인 전에는 디스크에 안 쓴다"는 원칙이 무너집니다.

바인딩은 사내 IP 고정, 토큰 필수. 인터넷 노출 없음.
개인 금고용 MCP 서버는 이것과 별개로 **앱 프로세스 안에서 stdio 또는 `127.0.0.1`** 로 뜹니다.

**전제:** 사내 정책이 CLI의 MCP 서버 등록을 허용해야 합니다. M0 검증 항목 4·5.
셋 중 일부 CLI만 MCP가 되면 그 CLI만 파일 복사 방식으로 폴백합니다.

---

## 6. 보안

**현재 가정:** 사내망 내부는 신뢰 경계다. 허브는 사내 IP로만 접근 가능하고 인터넷에 노출되지
않는다.

| 항목 | v1 |
|---|---|
| 인증 | 관리자 발급 사용자 토큰. 해시만 저장. Windows 자격 증명 관리자에 보관 |
| 전송 | 기본 HTTP. 조직이 인증서를 주면 TLS |
| 권한 | 공간 단위 `admin` / `writer` / `reader`. **페이지 단위 권한 없음** |
| 감사 | 모든 쓰기가 `events`에 기록. 삭제 불가 |
| 저장 암호화 | 없음. 서버 디스크 접근 권한이 곧 전체 접근 |
| 레이트 리밋 | 토큰당 단순 상한 |

명시적으로 안 하는 것: SSO/LDAP 연동, 페이지 단위 ACL, 저장 암호화, 감사 로그 외부 반출.
필요해지면 v2에서 다룹니다. 지금 넣으면 M5가 2주에 안 끝납니다.

---

## 7. 운영

**백업** — 서버 정지 후 `hub.sqlite`(+WAL) 와 `blobs/` 복사. 또는
`VACUUM INTO`로 무정지 스냅샷 후 blob 복사.

**복구** — 파일을 되돌리고 재시작. 클라이언트는 커서가 서버 최신보다 앞서면
자동으로 전체 재동기화합니다.

**모니터링** — `GET /v1/health`가 DB 쓰기 가능 여부, blob 디스크 여유, 공간별 페이지 수를
반환합니다. 사내 모니터링이 없으면 앱 설정 화면에서 확인합니다.

**용량** — 위키 텍스트는 무시할 수준입니다. blob이 전부입니다.
디스크 여유가 임계 아래로 내려가면 업로드를 거부하고 관리자에게 표시합니다.

---

## 8. M0에서 확인할 것

1. 원본 500건 프로젝트의 `page_versions` 누적 크기 실측
2. 사내 PC 사양에서 동시 5인 쓰기 시 SQLite WAL 처리량
3. 대용량 blob(200MB PPT) 업로드·Range 다운로드 안정성
4. Windows 서비스 등록(nssm) 및 방화벽 인바운드 규칙 절차
5. MCP HTTP 엔드포인트를 CLI 3종이 실제로 붙는지 (§5.5 전제 확인)
