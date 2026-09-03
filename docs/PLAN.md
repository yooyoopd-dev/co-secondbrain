# co-secondbrain — 프로젝트 단위 Second Brain 프레임워크

> Windows 데스크톱 앱. 이메일·회의 전사·Word·Excel·PowerPoint·PDF·Markdown을 받아
> LLM이 **점진적으로 위키를 짓고 유지**한다.
> 개인 로컬 세컨브레인이 기본이고, 프로젝트 단위 **CO 영역**은 사내 로컬 서버를 통해
> 동료와 주고받는다.

상태: **계획 v0.2**. 코드 없음.

기반 패턴: Karpathy "LLM Wiki" — 원문 전문 확인 후 반영. 정리본은
[`REFERENCE-llm-wiki.md`](REFERENCE-llm-wiki.md), 반영/변형 내역은 그 문서 §9.

---

## 1. 확정 사항

| 항목 | 결정 |
|---|---|
| 스택 | Electron + TypeScript, NSIS 설치본 |
| LLM | **Claude Code CLI / Gemini CLI / Codex CLI** 3종. 사내망에서 예외적으로 허용된 외부 서비스. **로컬 LLM 사용 안 함** |
| 오디오 | 전사 텍스트만 (`.txt` `.srt` `.vtt`). `.md` 입력 포함 |
| 개인 금고 | 로컬 일반 폴더. Git 의존성 없음. 앱 내부 스냅샷으로 되돌리기 |
| 협업 | **개인 금고 ↔ 사내 CO-Hub 서버(사내망 IP) ↔ 동료** |
| 디자인 | [`DESIGN-SYSTEM.md`](DESIGN-SYSTEM.md) |

LLM CLI 3종이 사내에서 허용된 통로이므로 **데이터 유출 관련 설계 제약은 해소**되었습니다.
v0.1에 있던 로컬 모델 공급자와 관련 경고 UI는 삭제합니다.

---

## 2. 두 개의 공간 — 개인과 CO

이 프로젝트의 중심 구조입니다.

```
%USERPROFILE%\SecondBrain\
│
├─ personal/                    ← 개인 세컨브레인 (기본)
│   ├─ sources/  extracted/  wiki/  schema/
│   ├─ index.md   log.md
│   └─ .sb/history/             ← 스냅샷, 되돌리기
│       외부로 나가지 않음. LLM CLI에만 필요한 만큼 전달됨
│
└─ projects/
    ├─ ACME/                    ← CO 영역: 허브 공간의 로컬 미러
    │   ├─ sources/  extracted/  wiki/  schema/
    │   ├─ index.md   log.md
    │   └─ .sb/sync/            ← 커서, 원격 버전, 보류 중 변경
    └─ BETA/
```

두 공간의 **내부 구조는 완전히 동일**합니다. 같은 엔진, 같은 인제스트, 같은 질의.
차이는 오직 **동기화 대상이 있느냐**입니다.

### 공간 사이의 두 가지 명시적 행위

동기화는 자동으로 일어나지 않습니다. 사람이 고릅니다.

| 행위 | 방향 | 내용 |
|---|---|---|
| **Contribute (기여)** | 개인 → CO | 개인 페이지를 골라 검토 화면에서 무엇이 공유되는지 확인 후 push. 실수로 사적 메모가 나가는 것을 막는 유일한 장치 |
| **Adopt (채택)** | CO → 개인 | CO 페이지를 개인 위키로 복제. front-matter에 `derived_from: co://ACME/entities/acme-corp@v12` 기록. 원본 CO 페이지가 나중에 갱신되면 "채택본이 낡음" 배지 |

CO 영역에 원본을 **직접 인제스트**하는 것도 가능합니다(업무 문서는 대개 이쪽).
개인을 거칠 필요 없습니다.

### 링크 방향 규칙

- 개인 페이지 → CO 페이지 링크: **허용** (`[[co:ACME/엔티티/에이콤]]`)
- CO 페이지 → 개인 페이지 링크: **금지.** 저장 전 검증기가 차단

금지 이유 두 가지: 동료 입장에서는 영원히 깨진 링크이고, "누군가의 사적 페이지가 존재한다"는
사실 자체가 새어 나갑니다.

---

## 3. Vault 내부 구조

```
<Space>/
├─ sources/                     # 원본. 앱이 절대 수정하지 않음 (원문 "source of truth")
│   └─ 2026-09-03--킥오프-발표.pptx
│
├─ extracted/                   # 결정론적 텍스트 추출. LLM 미개입. 언제든 재생성
│   ├─ 2026-09-03--킥오프-발표.pptx.md
│   └─ 2026-09-03--킥오프-발표.pptx.anchors.json
│
├─ wiki/                        # ★ LLM이 소유. Obsidian 호환 마크다운
│   ├─ overview.md
│   ├─ sources/<slug>.md
│   ├─ entities/<slug>.md
│   ├─ concepts/<slug>.md
│   └─ synthesis/<slug>.md
│
├─ assets/                      # 이미지 (Obsidian 첨부 폴더 규약)
│
├─ schema/
│   ├─ AGENTS.md                # ★ 정본 스키마. LLM을 "규율 있는 위키 관리자"로 만드는 파일
│   └─ taxonomy.md
│
├─ index.md                     # 카탈로그 (§5)
├─ log.md                       # 시간순 추가 전용 (§5)
│
└─ .sb/                         # 앱 내부. 위키가 아님
    ├─ config.json
    ├─ catalog.sqlite           # FTS5 캐시. 재생성 가능
    ├─ history/                 # 스냅샷
    └─ sync/                    # CO 영역만
```

### 설계 원칙 5가지

1. **디스크가 진실이다.** SQLite는 재생성 가능한 캐시. 앱을 지워도 지식은 마크다운으로 남는다.
2. **Obsidian 호환을 유지한다.** wikilink `[[ ]]`, YAML front-matter, 고정 첨부 폴더.
   원문 저자의 작업 방식(LLM 편집 + Obsidian 열람, 그래프 뷰, Dataview)을 막지 않는다.
   앱은 Obsidian을 **대체**하지만 **배제하지 않는다.**
3. **LLM은 디스크에 직접 쓰지 않는다.** 변경안(ChangeSet)을 내고, 사람이 diff로 승인하면
   앱이 적용한다. 원문도 팀 용례에서 "humans in the loop reviewing updates"를 전제한다.
4. **모든 주장에 앵커 인용.** `[^src-kickoff#slide-12]` → 클릭하면 PPT 12쪽. 업무 문서는
   "몇 쪽에 있었나"가 곧 신뢰다.
5. **스키마는 공동 진화한다.** 앱에 스키마 편집기가 있고, LLM이 스키마 개정을 제안할 수 있다.
   원문: "You and the LLM co-evolve this over time."

### front-matter 계약

```yaml
---
id: ent-acme-corp
type: entity              # source | entity | concept | synthesis | overview
title: 에이콤(주)
summary: 2026년 킥오프의 주 협력사. 계약 갱신일에 문서 간 불일치 있음.   # ← index.md가 이 줄을 씀
aliases: [Acme, ACME, 에이콤]
tags: [협력사, 계약]
sources:
  - src-2026-09-03-kickoff#slide-12
  - src-2026-08-20-mail-a41f#body
confidence: high          # high | medium | low
open_questions:
  - 계약 갱신일이 문서마다 다름 (2027-01 vs 2027-03)
derived_from: null        # 개인 금고에서 CO 페이지를 채택한 경우 co://ACME/...@v12
updated: 2026-09-03T10:22:00+09:00
updated_by: hong@corp
---
```

`summary`가 있는 이유: 원문의 index.md 형식이 "링크 + 한 줄 요약 + 메타데이터"이기 때문입니다.
**요약은 LLM이 씁니다.** 앱은 그것을 모아 index.md를 조립할 뿐입니다.

---

## 4. 세 가지 동작

원문의 흐름을 그대로 따르되, 승인 단계만 추가했습니다.

### Ingest

```
파일 드롭
  → 추출 + 앵커 부여 (로컬)
  → 관련 위키 페이지 선별 (FTS + 별칭)
  → LLM CLI 실행 → ChangeSet 생성
  → ★ 요점 논의 / diff 검토 화면
  → 적용: 파일 쓰기 → index.md 재조립 → log.md 추가 → 스냅샷
```

원문 흐름의 6단계(읽기 → **요점 논의** → 요약 작성 → 인덱스 갱신 → 관련 페이지 갱신 →
**로그 추가**)를 전부 유지합니다. 원본 1건이 페이지 10~15개를 건드릴 수 있습니다.

**두 가지 모드를 모두 제공합니다** (원문이 둘 다 인정):

- **감독 모드** (기본) — 한 건씩. 요약을 읽고 강조점을 지시하고 페이지별로 승인
- **일괄 모드** — 여러 건을 한 번에. 검토는 마지막에 묶어서. 대량 백로그 정리용

어느 쪽을 쓸지는 `schema/AGENTS.md`에 기록합니다. 원문: "document it in the schema."

### Query

```
질문 → index.md 먼저 읽음 → 후보 페이지 선별 (FTS5 병행)
     → LLM이 인용 붙여 답변
     → [위키에 보관] → synthesis/ 페이지 생성
```

**답변 출력 형식** (원문 열거를 따름):

| 형식 | v1 | 비고 |
|---|---|---|
| 마크다운 페이지 | ✓ | |
| 비교 표 | ✓ | |
| 슬라이드 덱 (Marp) | ✓ | 마크다운이라 추가 의존성 없음. 위키 내용에서 바로 발표자료 |
| 차트 (matplotlib) | ✗ v2 | 사내 PC에 Python 보장 불가 |
| 캔버스 | ✗ v2 | |

"좋은 답변은 위키에 새 페이지로 되돌려 넣을 수 있다" — 이래야 탐색도 인제스트처럼 누적됩니다.

### Lint

원문의 6종을 그대로 구현하고, 이 앱 고유의 2종을 추가합니다.

| # | 검사 | 출처 |
|---|---|---|
| 1 | 페이지 간 모순 | 원문 |
| 2 | 새 원본이 대체한 낡은 주장 | 원문 |
| 3 | 인바운드 링크 없는 고아 페이지 | 원문 |
| 4 | 언급되지만 자기 페이지가 없는 중요 개념 | 원문 |
| 5 | 누락된 상호 참조 | 원문 |
| 6 | 데이터 공백 → **찾아볼 원본 제안** | 원문(웹 검색)을 사내망에 맞게 조정 |
| 7 | 출처 없는 문장 | 추가 |
| 8 | 깨진 앵커 (원본 교체로 슬라이드 번호 불일치) | 추가 |

검사 3·5·7·8은 LLM 없이 앱이 계산합니다. 1·2·4·6만 LLM이 판단합니다.
결과는 인제스트와 동일한 diff 검토를 거칩니다.

---

## 5. index.md 와 log.md

원문이 목적이 다르다고 강조한 두 파일. 형식을 원문대로 따릅니다.

**index.md** — 콘텐츠 지향 카탈로그. 카테고리별, 페이지마다 링크 + 한 줄 요약 + 메타.
질의 시 **가장 먼저 읽는 파일**입니다. 원문대로 임베딩 RAG 없이 수백 페이지 규모까지 버팁니다.
차이점: LLM이 매번 다시 쓰는 대신 **앱이 front-matter의 `summary`에서 조립**합니다.
내용의 저자는 여전히 LLM이고, 조립만 결정론적이라 본문과 어긋날 수 없습니다.

```markdown
## 엔티티
- [[entities/acme-corp|에이콤(주)]] — 2026년 킥오프의 주 협력사. 계약 갱신일 불일치. `원본 4 · 2026-09-03`
```

**log.md** — 시간순 추가 전용. **원문이 제시한 접두사 형식을 그대로 씁니다:**

```markdown
## [2026-09-03] ingest | 킥오프 발표.pptx
## [2026-09-03] query  | 계약 갱신일이 언제인가
## [2026-09-04] lint   | 모순 2건, 고아 3건
```

`grep "^## \[" log.md | tail -5`로 최근 이력이 나옵니다. 원문의 팁 그대로입니다.
CO 영역에서는 허브 DB의 events 테이블이 정본이고, log.md는 동기화 시 재생성됩니다.

---

## 6. 문서 추출 (M1, 전부 로컬)

| 형식 | 후보 라이브러리 | 앵커 |
|---|---|---|
| `.docx` | `mammoth` | 제목 경로 |
| `.xlsx` `.csv` | `exceljs` / `xlsx` | `시트!A1:D20` |
| `.pptx` | unzip + `fast-xml-parser` (`ppt/slides/slideN.xml`) | 슬라이드 번호 + 발표자 노트 |
| `.pdf` | `pdfjs-dist` 텍스트 레이어 | 페이지 번호 |
| `.msg` | `@kenjiuno/msgreader` | message-id / 스레드 |
| `.eml` | `mailparser` | message-id / 스레드 |
| `.srt` `.vtt` `.txt` | 자체 파서 | 타임코드 + 화자 턴 |
| `.md` | 직접 | 제목 경로 |

**이미지 처리** — 원문의 지적을 반영합니다: LLM은 인라인 이미지가 든 마크다운을 한 번에 읽지
못합니다. 그래서 추출기는 이미지를 `assets/`에 떼어내고 본문에는 `![도표 3](assets/...)` 참조만
남깁니다. LLM은 먼저 텍스트를 읽고, 필요한 이미지만 **별도 턴에서** 봅니다.
PPT·PDF의 도표가 많은 문서에서 특히 중요합니다.

**알려진 한계 (v1에 남김)**

- 스캔 PDF는 텍스트 레이어가 없습니다. 추출 0자를 감지해 "OCR 필요" 경고. OCR은 v2
- 표가 많은 PDF는 열 구조가 뭉갭니다. 원문 뷰어 점프로 보완
- 위 라이브러리는 **M0에서 실제 샘플로 검증**합니다 (U2)

---

## 7. LLM CLI 어댑터 (3종)

```ts
interface AgentCli {
  id: 'claude-code' | 'gemini' | 'codex';
  detect(): Promise<{ found: boolean; path?: string; version?: string }>;
  run(job: { workdir: string; promptFile: string }): AsyncIterable<Chunk>;
}
```

### 공통 실행 방식

1. 임시 **격리 작업 디렉터리**를 만든다
2. 이번 작업에 필요한 것만 복사한다 — `schema/AGENTS.md`, `index.md`,
   대상 `extracted/*.md`, 선별된 위키 페이지 수십 개
3. CLI를 그 디렉터리에서 서브프로세스로 실행한다
4. stdout에서 **단일 펜스드 ```json 블록**으로 된 ChangeSet을 회수한다
5. 디렉터리를 폐기한다

격리하는 이유: Vault 루트를 통째로 주면 무관한 프로젝트 문서까지 컨텍스트에 올라가고,
앱이 어떤 파일이 전달됐는지 기록·통제할 수 없습니다.

**출력 계약을 ChangeSet JSON 한 덩어리로 고정**하는 것이 CLI 3종을 하나로 묶는 핵심입니다.
각 CLI의 스트리밍 포맷·verbose 출력이 달라도 최종 산출물의 모양은 같습니다.

### 스키마 파일 이름

CLI마다 읽는 파일명이 다릅니다. **정본은 `schema/AGENTS.md` 하나**이고,
격리 작업 디렉터리에 각 CLI가 찾는 이름으로 포인터 파일을 생성합니다.

| CLI | 규약 파일명 | 검증 |
|---|---|---|
| Claude Code | `CLAUDE.md` | 원문에 명시 |
| Codex | `AGENTS.md` | 원문에 명시 |
| Gemini CLI | `GEMINI.md` (추정) | **M0에서 확인 필요** |

### ChangeSet 형식

```json
{
  "summary": "킥오프 발표에서 협력사 3곳과 일정 마일스톤 5개를 확인",
  "discussion": "계약 갱신일이 8월 메일과 어긋납니다. 어느 쪽이 최신입니까?",
  "ops": [
    { "op": "create", "path": "wiki/entities/acme-corp.md",
      "baseHash": null, "content": "---\nid: ent-acme-corp\n..." },
    { "op": "update", "path": "wiki/concepts/contract-renewal.md",
      "baseHash": "sha256:9f2a...", "content": "..." }
  ]
}
```

`baseHash`가 낙관적 동시성의 기반입니다 (§8.4).

### 미검증 사항 → M0

각 CLI의 비대화형 실행 플래그·출력 포맷·종료 코드를 **추측하지 않고** M0에서 `--help`로
확인합니다. 이 문서에 특정 플래그를 적지 않은 이유입니다.

---

## 8. CO-Hub — 사내 로컬 서버

서버 상세 설계는 [`HUB.md`](HUB.md). 여기서는 요지만 적습니다.

```
[PC A]  personal/  +  projects/ACME/ ──┐
                                        ├── HTTP ──▶ [CO-Hub  http://10.20.30.40:7777]
[PC B]  personal/  +  projects/ACME/ ──┘              SQLite DB + blob store
                                                      LLM 없음. 동기화만.
```

### 8.1 허브는 멍청하다 (의도적)

허브에 **LLM이 없습니다.** 인제스트·질의·린트는 전부 각자 PC에서 CLI로 돌아갑니다.
허브가 하는 일은 페이지 버전 관리, blob 보관, 이벤트 로그, 접근 토큰 확인뿐입니다.

이렇게 하면: 서버에 API 키가 없고, 서버가 죽어도 로컬 미러로 계속 일할 수 있고,
서버 사양이 낮아도 됩니다(구형 사내 PC 한 대면 충분).

### 8.2 무엇을 동기화하는가

| 대상 | 방식 |
|---|---|
| 위키 페이지 | 전량 동기화. 작고 텍스트라 빠름 |
| index.md / log.md | 동기화 안 함. 각 클라이언트가 재생성 |
| 원본 파일(blob) | **지연 다운로드.** 인용을 클릭하거나 "오프라인 고정"할 때만 받음 |
| extracted/ | 지연. 없으면 blob 받아 로컬에서 재추출 |
| 이벤트 로그 | 커서 기반 pull |

수백 MB짜리 PPT 더미가 있어도 첫 동기화가 수 초에 끝나는 이유입니다.

### 8.3 신원과 인증

허브 관리자가 사용자별 토큰을 발급하고, 앱은 Windows 자격 증명 관리자에 보관합니다.
`updated_by`가 토큰에서 나오므로 **귀속이 위조되지 않습니다** (SMB 공유 방식 대비 개선점).

사내망 HTTP를 기본으로 하고, 조직이 인증서를 제공하면 TLS를 켭니다.
이 신뢰 가정은 `HUB.md`에 명시합니다.

### 8.4 충돌 처리

낙관적 동시성. 잠금 없음.

```
PUT /v1/spaces/ACME/pages/ent-acme-corp     If-Match: 12
  → 200  적용, 버전 13
  → 409  누가 먼저 고쳤음 → 3-way 병합 화면 (base=v12, 내 것, 서버 것) → 해결 후 재전송
```

**서버가 버전을 강제하므로 v0.1에 있던 파일 잠금·heartbeat·stale 회수 설계가 통째로
사라집니다.** 공유 폴더 방식 대비 가장 큰 단순화입니다.

### 8.5 오프라인

로컬 미러만으로 읽기·인제스트·질의·린트가 전부 됩니다. 변경은 `.sb/sync/pending`에 쌓이고
연결되면 push합니다. 충돌은 위와 동일하게 처리합니다.

### 8.6 검토 큐

기여를 바로 반영하지 않고 `proposals`로 올려 동료가 승인하게 할 수 있습니다.
Git 없이 PR 비슷한 흐름이 생깁니다. 공간별로 켜고 끕니다. M6 범위.

### 8.7 남는 한계

- 접근 제어 단위는 **공간(프로젝트)** 입니다. 페이지 단위 권한 없음
- 허브는 단일 장애점입니다. 백업은 DB 파일 + blob 디렉터리 복사면 끝
- 개인 금고는 동기화·백업 대상이 아닙니다. 사용자가 알아서 백업해야 합니다 (앱이 경고)

---

## 9. 앱 구조

```
main (Node)                       renderer (React + TS)
├─ space/      공간 열기·감시      ├─ shell/      3-pane
├─ extract/    포맷별 추출         ├─ ingest/     드롭 → 진행 → ★diff 검토
├─ index/      SQLite FTS5         ├─ wiki/       페이지 뷰·편집·그래프
├─ agent/      CLI 어댑터 3종      ├─ query/      질의 · 인용 · Marp 내보내기
├─ changeset/  적용·충돌           ├─ lint/       점검 결과함
├─ history/    스냅샷              ├─ sync/       기여 · 채택 · 병합
├─ sync/       허브 클라이언트     └─ settings/   CLI 선택 · 허브 · 스키마 편집
└─ schema/     AGENTS.md 관리
```

`contextIsolation: true`, `nodeIntegration: false`, 타입 지정 IPC 채널만 노출.
렌더러는 파일시스템에 직접 접근하지 않습니다.
**자동 업데이트·텔레메트리·크래시 리포터 없음.**

---

## 10. 마일스톤

| # | 내용 | 추정 | 완료 기준 |
|---|---|---|---|
| **M0** | 스파이크: CLI 3종 headless 규약, `GEMINI.md` 확인, 추출기 실측, 허브 DB/blob 규모 산정 | 1.5주 | go/no-go 문서 |
| **M1** | 개인 공간: 생성·열기, 드롭 인제스트, 추출+앵커, 원문 뷰어 점프, FTS 검색. **LLM 없음** | 2주 | LLM 없이도 단독으로 쓸모 있음 |
| **M2** | 인제스트 에이전트: `AGENTS.md`, ChangeSet, **diff 검토 UI**, 적용 + index/log + 스냅샷. 감독·일괄 두 모드 | 2.5주 | 원본 1건이 끝까지 돎 |
| **M3** | 질의: 인용 답변, synthesis 보관, Marp 내보내기 | 1.5주 | 답변 전 문장에 클릭 가능한 출처 |
| **M4** | Lint 8종 + 수정안 | 1주 | 모순·고아·무출처 검출 |
| **M5** | **CO-Hub 서버**: DB, blob, 버전, 토큰, 이벤트 | 2주 | 2인 동시 쓰기 무손실 |
| **M6** | **동기화 클라이언트**: 기여·채택·3-way 병합·오프라인 큐·검토 큐 | 2.5주 | 오프라인 후 재접속 시 충돌 해결됨 |
| **M7** | 패키징: NSIS + 포터블, 허브 설치 가이드, 오프라인 문서 | 1주 | 사내 배포 가능 |

합계 약 14주 (1인 **추정**. M0 결과에 따라 변동).

M1 종료 시점에 LLM 없이도 "프로젝트 문서 통합 검색 + 원문 점프" 도구로 쓸 수 있습니다.
M0(CLI 규약)이 실패해도 M1이 막히지 않도록 자른 구성입니다.

---

## 11. 리스크

| 리스크 | 영향 | 대응 |
|---|---|---|
| CLI 3종의 headless 규약이 제각각이거나 불안정 | LLM 경로 재작업 | M0 선검증. 출력 계약을 ChangeSet JSON 한 덩어리로 고정해 차이를 흡수 |
| CLI 버전 업데이트로 출력 포맷 변경 | 어느 날 갑자기 깨짐 | 어댑터별 계약 테스트를 CI에 두고, 실패 시 사용자에게 "CLI 버전 확인" 안내 |
| 스캔 PDF | 지식 누락 | 0자 감지 경고. OCR은 v2 |
| 위키 품질 저하(환각) | 신뢰 붕괴 | 무출처 문장 Lint + 전 변경 diff 승인 + 스냅샷 되돌리기 |
| 개인 금고 → CO 실수 유출 | 사고 | Contribute 검토 화면 필수 경유. 자동 push 없음. CO→개인 링크 금지 검증 |
| 허브 단일 장애점 | 팀 작업 중단 | 로컬 미러로 계속 작업 가능. 백업은 파일 복사 |
| 개인 금고 백업 부재 | 데이터 손실 | 앱이 백업 미설정 경고 + 폴더 내보내기 제공 |

---

## 12. 다음 단계

M0 스파이크 착수 승인만 남았습니다. 검증 항목:

1. Claude Code / Gemini / Codex CLI 각각의 비대화형 실행 — 플래그, 출력, 종료 코드
2. Gemini CLI의 스키마 파일명
3. 세 CLI가 동일 프롬프트로 유효한 ChangeSet JSON을 내는지
4. 추출기 8종을 실제 사내 문서 샘플로 실측
5. 허브 DB·blob 규모 산정 (프로젝트 1개, 원본 500건 가정)
