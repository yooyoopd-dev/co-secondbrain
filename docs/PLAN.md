# co-secondbrain — 프로젝트 단위 Second Brain 프레임워크

> Windows 데스크톱 앱. 프로젝트별로 이메일·회의 전사·Word·Excel·PowerPoint·PDF·Markdown을
> 받아들여, LLM이 **점진적으로 위키를 짓고 유지**하는 시스템.

상태: **계획 단계 (v0.1 초안)**. 코드 없음. 이 문서는 착수 전 합의용.

---

## 0. 근거와 확실하지 않은 부분

**근거 있는 부분**

- 위키 패턴(3계층 / Ingest·Query·Lint / index.md·log.md)은 Karpathy의 "LLM Wiki" gist에서 가져왔습니다.
  출처: <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f#file-llm-wiki-md>
  (본 저장소 `docs/REFERENCE-llm-wiki.md`에 요약 보관)
- 디자인 토큰(Inter / JetBrains Mono / #000·#FFF / 8px radius / 200–300ms ease-out)은
  첨부된 `design/design.md`에서 그대로 가져왔습니다.

**확실하지 않은 부분 — 착수 전 M0 스파이크로 검증해야 함**

| # | 미검증 항목 | 왜 위험한가 |
|---|---|---|
| U1 | Claude Code CLI의 비대화형(headless) 호출 규약 — 정확한 플래그, stdout 포맷, 종료 코드 | 이 앱의 LLM 경로 전체가 여기 의존. **이 문서에 특정 플래그를 적지 않은 이유** |
| U2 | Node/JS 문서 추출 라이브러리의 실제 정확도 (특히 .pptx, .msg, 한글 PDF) | 이름은 알지만 이 환경에서 실행 검증한 바 없음 |
| U3 | SMB 공유 폴더에서의 파일 잠금 동작 (사내 파일서버 종류에 따라 다름) | 팀 모드의 전제 |
| U4 | 사내망이 `api.anthropic.com` 아웃바운드를 허용하는지 | 허용 안 되면 CLI 경로 자체가 불가 |

위 4개는 **추측하지 않고 M0에서 실제로 돌려보고 결론냅니다.**

---

## 1. 결정된 사항 (사용자 확정)

| 항목 | 결정 | 비고 |
|---|---|---|
| 스택 | **Electron + TypeScript** | 설치본 NSIS |
| LLM | **설치된 Claude Code CLI 호출** | 단, 어댑터로 추상화 (§5) |
| 오디오 | **전사 텍스트만** (`.txt` `.srt` `.vtt`) + **`.md` 입력 추가** | 음성 파일 자체는 v1 범위 밖 |
| 저장소 | **로컬 일반 폴더** (Git 아님) | 앱 내부 스냅샷으로 되돌리기 제공 |
| 네트워크 | **앱은 클라우드 접속 안 함**, 사내망 사용 | ⚠️ 아래 모순 참조 |
| 협업 | **개인 + 동료 공동 작업 둘 다** | §7 전체가 이것 때문 |

### ⚠️ 해소해야 할 모순

"Claude Code CLI 호출"과 "클라우드 접속 없음"은 동시에 성립하지 않습니다.
CLI는 `api.anthropic.com`으로 HTTPS를 보내며, 인제스트한 **문서 본문이 사내망 밖으로 나갑니다.**

본 계획의 전제(확정 필요):

> 앱 자체는 어떤 서버에도 접속하지 않는다(텔레메트리·자동업데이트·동기화 전부 없음).
> LLM 호출만 예외이며, 그 경로는 **교체 가능한 어댑터**로 분리한다.

만약 "문서가 절대 외부로 나가면 안 된다"가 진짜 요구사항이면,
기본 공급자를 `LocalModelProvider`(사내 온프렘 엔드포인트)로 바꾸면 됩니다.
**엔진 코드는 한 줄도 바뀌지 않습니다.** 이것이 §5 어댑터 설계의 존재 이유입니다.

---

## 2. 핵심 개념 — Vault(프로젝트 금고)

프로젝트 1개 = 폴더 1개 = Vault 1개. 앱은 Vault를 여러 개 등록해 전환합니다.

```
<Vault>/
├─ sources/                     # 원본. 앱은 절대 수정하지 않음 (읽기 전용 취급)
│   └─ 2026-09-03--킥오프-발표.pptx
│
├─ extracted/                   # 결정론적 텍스트 추출. LLM 미개입. 언제든 재생성 가능
│   ├─ 2026-09-03--킥오프-발표.pptx.md
│   └─ 2026-09-03--킥오프-발표.pptx.anchors.json   # 슬라이드/페이지/셀 위치 좌표
│
├─ wiki/                        # ★ LLM이 소유하는 계층. 전부 Markdown + YAML front-matter
│   ├─ index.md                 # 자동 생성 (수기 편집 금지)
│   ├─ overview.md              # LLM이 쓰는 서술형 진입점
│   ├─ sources/<slug>.md        # 원본 1개당 요약 페이지
│   ├─ entities/<slug>.md       # 사람·조직·시스템·제품
│   ├─ concepts/<slug>.md       # 결정·리스크·주제
│   └─ synthesis/<slug>.md      # 질의 결과를 되돌려 보관한 페이지
│
├─ schema/                      # LLM에게 매 실행마다 주는 계약서
│   ├─ AGENTS.md                # 위키 규칙·문체·인용 형식·금지사항
│   └─ taxonomy.md              # 이 프로젝트가 쓰는 엔티티/개념 분류
│
├─ journal/                     # 추가 전용(append-only). 사용자·날짜별로 파일 분리
│   └─ 2026-09-03--hong.jsonl
│
└─ .secondbrain/
    ├─ config.json              # Vault 설정 (팀 모드 여부 등)
    ├─ history/                 # 콘텐츠 주소 기반 스냅샷 → 되돌리기
    ├─ locks/                   # 팀 모드 파일 잠금
    └─ proposals/               # 동료 검토 대기 중인 변경안 (§7)
```

### 설계 원칙 4가지

1. **디스크가 진실이다.** SQLite는 재생성 가능한 캐시일 뿐. Vault를 탐색기·메모장으로 열어도
   전부 읽힌다. 앱을 지워도 지식은 남는다.
2. **LLM은 디스크에 직접 쓰지 않는다.** LLM은 *변경안(change set)* 을 내놓고,
   사용자가 diff로 검토·승인한 뒤 **앱이** 파일에 적용한다. 직장에서 쓰려면 감사 추적이 필수.
3. **모든 주장에는 앵커 인용이 붙는다.** `[^src-kickoff#slide-12]` → 클릭하면 실제 PPT 12쪽으로 점프.
   출처 없는 문장은 Lint가 잡는다.
4. **충돌 다발 지점은 구조로 제거한다.** `index.md`는 front-matter에서 **자동 생성**하고,
   `log.md` 단일 파일 대신 사용자별 `journal/*.jsonl`을 쓴다. (§7)

### front-matter 계약

```yaml
---
id: ent-acme-corp
type: entity            # source | entity | concept | synthesis
title: 에이콤(주)
aliases: [Acme, ACME, 에이콤]
tags: [협력사, 계약]
sources:                # 앵커 인용
  - src-2026-09-03-kickoff#slide-12
  - src-2026-08-20-mail-a41f#body
confidence: high        # high | medium | low
open_questions:
  - 계약 갱신일이 문서마다 다름 (2027-01 vs 2027-03)
updated: 2026-09-03T10:22:00+09:00
updated_by: hong@corp
---
```

`index.md`는 이 front-matter들을 훑어 앱이 만듭니다. 즉 **LLM이 인덱스 유지보수를 하지 않습니다.**
Karpathy 원안과 의도적으로 다른 지점이며, 이유는 (a) 결정론적이라 팀 충돌이 사라지고
(b) 토큰과 시간을 아끼고 (c) 인덱스가 본문과 어긋날 일이 없기 때문입니다.

---

## 3. 세 가지 동작

### Ingest (인제스트)

```
파일 드롭
  → 추출 (로컬, 무료, 네트워크 없음)
  → 앵커 부여 (페이지/슬라이드/셀/타임코드)
  → 관련 위키 페이지 선별 (FTS + 별칭 매칭)
  → LLM: 요약 + 변경안 생성
  → ★ 사용자 diff 검토 화면 (페이지별 승인/거부/수정)
  → 적용: 파일 쓰기 + 스냅샷 + journal 기록 + index 재생성
```

원본 1건이 위키 페이지 10~15개를 건드릴 수 있습니다(gist의 관찰). 그래서 검토 화면이 핵심 UI입니다.

### Query (질의)

```
질문 → FTS5 + front-matter 필터로 후보 페이지 선별
     → LLM이 인용 붙여 답변
     → [이 답변을 위키에 보관] → synthesis/ 페이지 생성 (탐색이 자산으로 축적)
```

### Lint (점검)

주기적/수동 실행. 검출 항목:

- 페이지 간 **모순** (같은 사실에 다른 값)
- **오래된 주장** (근거 원본이 갱신됐는데 페이지는 그대로)
- **고아 페이지** (아무도 링크하지 않음)
- **누락된 상호 참조**
- **출처 없는 문장** ← 직장 사용 시 가장 중요
- **깨진 앵커** (원본이 교체돼 슬라이드 번호가 안 맞음)

각 항목은 "수정안"으로 제시되고, 인제스트와 동일한 diff 검토를 거칩니다.

---

## 4. 문서 추출 (M1, 전부 로컬)

| 형식 | 후보 라이브러리 | 앵커 단위 |
|---|---|---|
| `.docx` | `mammoth` | 제목 경로 (H1>H2>H3) |
| `.xlsx` `.csv` | `exceljs` 또는 `xlsx` | `시트명!A1:D20` |
| `.pptx` | unzip + `fast-xml-parser`로 `ppt/slides/slideN.xml` | 슬라이드 번호 + 발표자 노트 |
| `.pdf` | `pdfjs-dist` 텍스트 레이어 | 페이지 번호 |
| `.msg` | `@kenjiuno/msgreader` | message-id / 스레드 |
| `.eml` | `mailparser` | message-id / 스레드 |
| `.srt` `.vtt` `.txt` | 자체 파서 | 타임코드 + 화자 턴 |
| `.md` | 직접 | 제목 경로 |

**알려진 한계 (v1에 그대로 남김):**

- **스캔 PDF는 텍스트가 없습니다.** 추출 0자를 감지해 "OCR 필요" 경고만 띄웁니다. OCR은 v1 범위 밖.
- 표가 많은 PDF는 텍스트 레이어에서 열 구조가 뭉갭니다. 원문 뷰어 점프로 보완합니다.
- 위 라이브러리들은 **M0에서 실제 샘플로 검증합니다** (U2). 실패 시 대체안: 해당 형식만
  사내에 이미 있는 변환 도구(LibreOffice headless 등)로 우회.

---

## 5. LLM 어댑터 — 이 앱에서 가장 중요한 추상화

```ts
interface LlmProvider {
  id: 'claude-cli' | 'anthropic-api' | 'local-openai-compat';
  run(req: { system: string; prompt: string; files?: string[] }): AsyncIterable<Chunk>;
  health(): Promise<{ ok: boolean; detail: string }>;   // 설정 화면 "연결 확인" 버튼
}
```

| 공급자 | 내용 | 데이터 유출 |
|---|---|---|
| `ClaudeCodeCliProvider` **(기본)** | `claude` 실행 파일을 **격리 작업 디렉터리**에서 서브프로세스로 실행. 그 디렉터리에는 이번 작업에 필요한 추출 텍스트와 위키 페이지만 복사해 넣음 → CLI가 Vault 전체를 보지 못함 | 있음 (Anthropic) |
| `AnthropicApiProvider` | `@anthropic-ai/sdk`, 모델 `claude-opus-5`, adaptive thinking, 스트리밍, 스키마+인덱스 접두부에 프롬프트 캐싱 | 있음 (Anthropic) |
| `LocalOpenAiCompatProvider` | 사내 온프렘 / Ollama 엔드포인트 | **없음** |

설정 화면에 현재 공급자와 **"이 설정에서 문서 본문이 외부로 나갑니다 / 나가지 않습니다"** 를 명시합니다.
직장 사용이므로 이 경고는 숨기지 않습니다.

CLI 격리 작업 디렉터리 방식을 택한 이유: CLI에 Vault 루트를 그대로 주면 무관한 프로젝트 문서까지
컨텍스트에 올라갈 수 있고, 앱이 어떤 파일이 전송됐는지 통제·기록할 수 없습니다.

---

## 6. 앱 구조 (Electron)

```
main (Node)                      renderer (React + TS)
├─ vault/      Vault 열기·감시    ├─ shell/     3-pane 레이아웃
├─ extract/    포맷별 추출기      ├─ ingest/    드롭 → 진행 → ★diff 검토
├─ index/      SQLite FTS5 캐시   ├─ wiki/      페이지 뷰/편집, 그래프
├─ llm/        공급자 어댑터      ├─ query/     질의 + 인용 답변
├─ changeset/  변경안 적용·충돌   ├─ lint/      점검 결과함
├─ history/    스냅샷·되돌리기    └─ settings/  공급자·팀 모드·신원
└─ lock/       팀 모드 잠금
```

- IPC는 타입 지정된 채널만 노출. `contextIsolation: true`, `nodeIntegration: false`.
- 렌더러는 파일시스템에 직접 접근하지 않습니다.
- **자동 업데이트 없음, 텔레메트리 없음, 크래시 리포터 없음** (사내망 요구사항).

---

## 7. 팀 공동 작업 설계 (추가 검토 요청분)

Vault를 사내 파일서버 공유 경로(`\\fileserver\projects\ACME\vault`)에 두는 **팀 모드**.
클라우드·서버 컴포넌트 없음. SMB 파일 공유만 사용.

### 7.1 신원

로그인 서버가 없으므로 `%USERNAME%@%USERDOMAIN%`을 사용합니다.
설정에서 표시 이름만 바꿀 수 있고, 위장 방지는 하지 않습니다 — **이건 인증이 아니라 귀속(attribution)입니다.**
사내 신뢰 환경 전제이며, 이 한계를 문서에 명시합니다.

### 7.2 구조적 충돌 제거 (가장 중요)

| 충돌원 | 해결 |
|---|---|
| `index.md`를 여럿이 수정 | front-matter에서 **자동 생성**. 사람도 LLM도 안 건드림 |
| `log.md` 단일 파일에 동시 append | `journal/<날짜>--<사용자>.jsonl`로 분할. 표시할 때만 병합 |
| SQLite를 SMB 위에서 다중 쓰기 | **DB를 공유 폴더에 두지 않음.** 각자 로컬 `%APPDATA%`에 두고 Vault를 스캔해 재생성 |

SQLite를 공유 드라이브에 올리지 않는 것은 타협 대상이 아닙니다 — SMB 상의 다중 라이터는
알려진 손상 시나리오입니다.

### 7.3 잠금

- LLM 생성(수십 초~수 분)은 **잠금 없이** 진행합니다.
- 디스크 적용(수 초)만 `.secondbrain/locks/wiki.lock`을 잡습니다.
  락 파일 내용: `{user, host, pid, acquiredAt, heartbeatAt}`. 10초마다 heartbeat,
  60초 무응답이면 stale로 간주하고 경고와 함께 회수 가능.
- 이 방식이면 실제 경합 구간이 초 단위라 충돌 확률이 낮습니다.

### 7.4 낙관적 동시성 (진짜 안전망)

모든 변경안은 건드릴 페이지의 **적용 전 해시(pre-image hash)** 를 함께 기록합니다.
적용 시점에 현재 해시가 다르면 → 그 페이지만 **충돌 표시 → 3-way 병합 화면 → 사용자 해결**.
**조용한 덮어쓰기는 없습니다.**

### 7.5 검토 큐 (Git 없이 PR 흉내)

변경안을 자기가 바로 적용하는 대신 `.secondbrain/proposals/<id>.json`으로 저장할 수 있습니다.
동료가 앱에서 열어 diff를 보고 승인/반려. 서버 없이 파일만으로 리뷰 워크플로가 생깁니다.
M5 범위.

### 7.6 남는 한계 (숨기지 않음)

- 오프라인 동시 편집 병합은 못 합니다. 공유 드라이브에 연결된 상태를 전제합니다.
- 접근 제어는 **파일서버 NTFS 권한에 위임**합니다. 앱은 자체 권한 모델을 갖지 않습니다.
- 대형 Vault + 느린 SMB에서는 최초 스캔이 느립니다 → 증분 스캔 + 로컬 캐시로 완화.

---

## 8. 디자인 시스템

`design/design.md`(첨부 원본)에서 도출. 상세는 `docs/DESIGN-SYSTEM.md`.

**원본 문서 내 모순 발견:**
Do's는 `Do Background #000000`이라 하는데, Don'ts는 `No pure black (#000000) — use off-black`이라 합니다.
서로 반대입니다.

해소안(가정, 이의 없으면 이대로 진행):

- 앱 바탕(가장 뒤 캔버스): `#000000` — Do's 존중
- 떠 있는 표면(카드·패널·사이드바): `#0B0B0B` / `#141414` — Don'ts의 의도(깊이 표현) 존중
- 경계선: `#262626`

또한 `design.md`의 레이아웃 규칙 중 **랜딩 페이지용 항목(split-screen hero, zig-zag 섹션)은
채택하지 않습니다.** 이 앱은 3-pane 대시보드입니다. 채택하는 것은 토큰·컴포넌트·모션 계층입니다:
Inter / JetBrains Mono, 8px 그리드, 8px radius, 200–300ms ease-out, 이모지 금지(Lucide 아이콘),
스피너 대신 스켈레톤.

---

## 9. 마일스톤

| # | 내용 | 기간(추정) | 완료 기준 |
|---|---|---|---|
| **M0** | **스파이크.** U1~U4 검증: Claude Code CLI headless 호출, 추출기 실측, SMB 잠금, 아웃바운드 허용 여부 | 1주 | go/no-go 결론 문서 |
| **M1** | Vault 생성·열기, 드롭 인제스트, 추출+앵커, 원문 뷰어 점프, FTS 검색. **LLM 없음** | 2주 | LLM 없이도 단독으로 쓸모 있음 |
| **M2** | `schema/AGENTS.md`, 변경안 생성, **diff 검토 UI**, 적용+journal+스냅샷 | 2주 | 원본 1건 인제스트가 끝까지 돎 |
| **M3** | 질의 + 인용 답변 + synthesis 보관 | 1.5주 | 답변의 모든 문장에 클릭 가능한 출처 |
| **M4** | Lint 6종 + 수정안 | 1주 | 모순·무출처 검출 |
| **M5** | **팀 모드**: 공유 경로, 잠금, 3-way 병합, 검토 큐, 신원 | 2주 | 2인 동시 인제스트 시 무손실 |
| **M6** | NSIS 설치본 + 포터블 zip, 서명, 오프라인 문서 | 1주 | 사내 배포 가능 |

합계 약 10.5주 (1인 기준 **추정**입니다. M0 결과에 따라 변동).

M1이 끝나면 LLM 없이도 "프로젝트 문서 통합 검색 + 원문 점프" 도구로 쓸 수 있습니다.
이렇게 자른 이유는 U1(CLI 규약)이 M1을 막지 않도록 하기 위해서입니다.

---

## 10. 리스크

| 리스크 | 영향 | 대응 |
|---|---|---|
| Claude Code CLI headless 규약이 예상과 다름 | LLM 경로 전면 재작업 | M0에서 먼저 검증. 실패 시 `AnthropicApiProvider`로 전환 (어댑터 덕에 국소 변경) |
| 사내망이 아웃바운드 차단 | CLI·API 둘 다 불가 | `LocalOpenAiCompatProvider`. M0에서 확인 |
| **문서 본문 외부 유출** | 규정 위반 가능 | 설정 화면 상시 경고 + 격리 작업 디렉터리 + 전송 파일 목록 로깅. 근본 해결은 로컬 모델 |
| 스캔 PDF | 지식 누락 | 0자 감지 경고. OCR은 v2 |
| SMB 위 성능 | 팀 모드 체감 저하 | 로컬 SQLite 캐시 + 증분 스캔 |
| 위키 품질 저하(LLM 환각) | 신뢰 붕괴 | 무출처 문장 Lint + 전 변경 diff 승인 + 스냅샷 되돌리기 |

---

## 11. 다음 단계

1. §1의 **모순** 확정 — "LLM 호출만 예외" 전제가 맞는가?
2. §8 **색상 해소안** 확인
3. M0 스파이크 착수 승인

승인되면 M0 스파이크 결과를 이 문서에 반영하고 M1 구현을 시작합니다.
