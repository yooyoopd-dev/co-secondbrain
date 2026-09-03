# 참고: Karpathy "LLM Wiki" 원문 정리

출처: <https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f#file-llm-wiki-md>
2026-09-03 `git clone`으로 원문(11,985자) 전문 확인. 아래는 원문 구조를 따른 정리이며
원문 자체가 아닙니다. 인용 문구는 큰따옴표로 표시했습니다.

원문은 "구현이 아니라 패턴을 전달하는 아이디어 파일"이며, **에이전트에 통째로 붙여넣어
같이 구체화하라**는 전제로 쓰였습니다. 명시된 대상 에이전트가 "OpenAI Codex, Claude Code,
OpenCode / Pi" — 본 프로젝트가 CLI 3종을 지원하는 것과 정확히 맞물립니다.

---

## 1. 핵심 아이디어

RAG는 질의 때마다 원본에서 조각을 찾아 재조립한다. **축적이 없다.**
문서 5개를 합쳐야 답이 나오는 미묘한 질문이면 매번 처음부터 다시 찾는다.

대신 LLM이 **지속적으로 축적되는 위키를 점진적으로 짓고 유지**한다.
새 원본이 들어오면 색인만 하는 게 아니라 — 읽고, 핵심을 뽑고, **기존 위키에 통합**한다.
엔티티 페이지를 갱신하고, 주제 요약을 개정하고, 새 데이터가 기존 주장과 **어긋나는 지점을
표시**하고, 진화 중인 종합을 보강하거나 반박한다.

> "the wiki is a persistent, compounding artifact. The cross-references are already there.
> The contradictions have already been flagged."

지식은 **한 번 컴파일되고 그 뒤로 계속 최신 상태로 유지**된다. 질의마다 재유도되지 않는다.

**사람은 위키를 거의 쓰지 않는다.** LLM이 전부 쓰고 유지한다.
사람 몫은 소싱, 탐색, 좋은 질문. LLM 몫은 요약·상호참조·정리·부기 전부.

> "Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase."

원문 저자의 실제 작업 방식: 한쪽에 LLM 에이전트, 다른 쪽에 Obsidian을 띄워 두고,
LLM이 편집하는 동안 사람은 링크를 따라가고 그래프 뷰를 보며 실시간으로 결과를 훑는다.

### 적용 예시 (원문 열거)

개인(목표·건강·심리·자기개선) / 연구(수 주~수 개월 심층) / 독서(장별 정리 → 인물·주제·플롯
페이지, Tolkien Gateway 같은 팬 위키를 혼자 만드는 셈) / **업무·팀(Slack 스레드, 회의 전사,
프로젝트 문서, 고객 통화로 유지되는 사내 위키. 사람이 검토자로 개입 가능)** /
경쟁 분석, 실사, 여행 계획, 강의 노트, 취미 심층.

→ 본 프로젝트는 이 중 **업무·팀** 항목의 구현입니다.

---

## 2. 아키텍처 — 3계층

| 계층 | 소유 | 원문 설명 |
|---|---|---|
| **Raw sources** | 불변 | 큐레이션한 원본 모음. 기사·논문·이미지·데이터 파일. LLM은 읽되 **절대 수정하지 않음.** "This is your source of truth." |
| **The wiki** | LLM 전적 소유 | LLM이 생성한 마크다운 디렉터리. 요약, 엔티티 페이지, 개념 페이지, 비교, 개요, 종합. 페이지 생성·갱신·상호참조 유지·일관성 관리 전부 LLM. "You read it; the LLM writes it." |
| **The schema** | 사람 + LLM 공동 진화 | `CLAUDE.md`(Claude Code) / `AGENTS.md`(Codex) 같은 문서. 위키 구조·관례·워크플로를 규정. **"the key configuration file"** — 이것이 LLM을 범용 챗봇이 아니라 **규율 있는 위키 관리자**로 만든다. "You and the LLM co-evolve this over time." |

---

## 3. 세 가지 동작

### Ingest

원문이 제시한 흐름(순서 그대로):

1. LLM이 원본을 읽는다
2. **핵심 요점을 사용자와 논의한다**
3. 위키에 요약 페이지를 쓴다
4. **인덱스를 갱신한다**
5. 위키 전반의 관련 엔티티·개념 페이지를 갱신한다
6. **로그에 항목을 추가한다**

"A single source might touch 10-15 wiki pages."

원문은 **두 가지 방식을 모두 인정**한다:
- 한 번에 하나씩, 사람이 개입해 요약을 읽고 강조점을 지시 (저자 선호)
- 다수를 일괄 인제스트하고 감독을 줄임

> "It's up to you to develop the workflow that fits your style and document it in the schema."

### Query

위키에 질문 → 관련 페이지 검색·독해 → **인용을 붙여** 종합.

**답변 형식이 질문에 따라 달라진다** (원문 열거): 마크다운 페이지, 비교 표,
**슬라이드 덱(Marp)**, **차트(matplotlib)**, 캔버스.

> "good answers can be filed back into the wiki as new pages."

요청한 비교, 분석, 발견한 연결 — 이것들이 채팅 히스토리에 묻혀 사라지면 안 된다.
이렇게 해야 **탐색도 인제스트처럼 지식으로 누적**된다.

### Lint

주기적 건강 점검. 원문이 열거한 검사 항목 **6종**:

1. 페이지 간 **모순**
2. 새 원본이 대체한 **낡은 주장**
3. 인바운드 링크가 없는 **고아 페이지**
4. **언급은 되는데 자기 페이지가 없는 중요 개념**
5. **누락된 상호 참조**
6. **웹 검색으로 채울 수 있는 데이터 공백**

"LLM은 조사할 새 질문과 찾아볼 새 원본을 제안하는 데 능하다."

---

## 4. 인덱싱과 로깅

두 특수 파일이 있고 **목적이 서로 다르다.**

### index.md — 콘텐츠 지향

위키 전체 카탈로그. 각 페이지에 **링크 + 한 줄 요약 + (선택) 날짜·원본 수 같은 메타데이터.**
카테고리별(엔티티·개념·원본 등) 구성. **인제스트마다 LLM이 갱신.**
질의 시 LLM은 **인덱스를 먼저 읽고** 관련 페이지를 찾은 뒤 파고든다.

> "This works surprisingly well at moderate scale (~100 sources, ~hundreds of pages)
> and avoids the need for embedding-based RAG infrastructure."

### log.md — 시간순

무슨 일이 언제 있었는지의 **추가 전용(append-only)** 기록. 인제스트·질의·린트.

**팁(원문 명시):** 각 항목을 일관된 접두사로 시작하면 유닉스 도구로 파싱된다.
예: `## [2026-04-02] ingest | Article Title` →
`grep "^## \[" log.md | tail -5` 로 최근 5건.

---

## 5. 선택: CLI 도구

위키가 커지면 인덱스 파일만으로 부족해져 제대로 된 검색이 필요해진다.
원문 추천: [qmd](https://github.com/tobi/qmd) — 마크다운용 로컬 검색 엔진,
**BM25/벡터 하이브리드 + LLM 재순위**, 전부 온디바이스. CLI(에이전트가 shell out)와
MCP 서버(네이티브 도구) 둘 다 제공.

---

## 6. 팁 (원문)

- **Obsidian Web Clipper** — 웹 기사를 마크다운으로 변환
- **이미지 로컬 다운로드** — Obsidian 첨부 폴더를 `raw/assets/` 등으로 고정.
  **중요:** "LLM은 인라인 이미지가 포함된 마크다운을 한 번에 읽지 못한다" —
  텍스트를 먼저 읽고, 참조된 이미지를 **따로** 열어 보는 우회가 필요하다
- **Obsidian 그래프 뷰** — 위키의 형태를 보는 최선의 방법. 무엇이 허브이고 무엇이 고아인지
- **Marp** — 마크다운 슬라이드 포맷. 위키 내용에서 바로 발표자료 생성
- **Dataview** — front-matter(tags, dates, source counts)에 질의를 돌려 동적 표·목록 생성
- **"The wiki is just a git repo of markdown files. You get version history, branching,
  and collaboration for free."**

---

## 7. 왜 작동하는가

지식 베이스 유지의 고된 부분은 읽기나 사고가 아니라 **부기**다.
상호참조 갱신, 요약 최신화, 새 데이터가 옛 주장과 충돌할 때 기록, 수십 페이지 간 일관성.
사람이 위키를 포기하는 이유는 **유지 부담이 가치보다 빠르게 커지기 때문**이다.
LLM은 지루해하지 않고, 상호참조 갱신을 잊지 않고, 한 번에 15개 파일을 건드린다.
**유지 비용이 0에 가까워서 위키가 유지된다.**

Vannevar Bush의 Memex(1945)와 정신적으로 연결된다 — 문서 사이의 연결이 문서만큼 가치 있는,
사적이고 능동적으로 큐레이션된 지식 저장소. **Bush가 못 푼 것은 "누가 유지하는가"였고,
LLM이 그걸 처리한다.**

---

## 8. 원문의 마지막 주의

> "This document is intentionally abstract. It describes the idea, not a specific implementation."

디렉터리 구조·스키마 관례·페이지 형식·툴링 전부 도메인과 취향과 LLM 선택에 달렸다.
**언급된 모든 것은 선택적이고 모듈식이다** — 쓸모 있는 것만 고르고 나머지는 무시하라.

---

## 9. co-secondbrain이 원안을 어떻게 반영/변형했는가

원문이 "선택적·모듈식"이라 명시했으므로 아래 변형은 원안 위반이 아니라 도메인 적응입니다.
다만 **어디를 왜 바꿨는지는 명시**합니다.

| 원문 | 본 프로젝트 | 근거 |
|---|---|---|
| Obsidian을 읽기 UI로 사용 | 앱이 그 역할을 하되, **Obsidian 호환을 유지** (wikilink `[[ ]]`, YAML front-matter, 첨부 폴더 고정) | 원문의 작업 방식을 막지 않기 위해. 사용자가 Obsidian을 병행해도 그래프 뷰·Dataview가 그대로 동작해야 함 |
| `index.md`를 LLM이 갱신 | **형식은 원문 그대로**(링크 + 한 줄 요약 + 메타, 카테고리별). 단 한 줄 요약은 각 페이지 front-matter의 `summary:`에서 앱이 **조립** | LLM이 요약을 쓰는 건 동일. 조립만 결정론적이라 인덱스가 본문과 어긋날 수 없음 |
| `log.md` 추가 전용 | **원문 형식 그대로 채택**: `## [2026-04-02] ingest \| 제목`, grep 파싱 가능 | 개인 금고는 단일 사용자라 동시 append 문제 없음. CO 영역은 허브 DB의 events 테이블이 담당 |
| 위키 = git repo (버전·브랜치·협업 무료) | **개인 금고는 앱 내부 스냅샷**(Git 의존성 없음), **CO 영역은 허브 DB가 버전 관리** | 사용자가 Git 비의존을 요구. 대신 되돌리기·이력·충돌 감지는 다른 수단으로 반드시 제공 |
| 답변 형식: md / 표 / Marp / 차트 / 캔버스 | md·표·**Marp** 채택. 차트(matplotlib)는 Python 의존이라 **v2** | 사내 PC에 Python 보장 불가 |
| Lint 6종 | **6종 그대로** + 앵커 무결성 2종 추가 | 원문 6번(웹 검색으로 데이터 공백 채우기)은 사내망 차단 환경이라 "**찾아볼 원본 제안**"으로 조정 |
| 인용 형식 자유 | **앵커 인용 강제** (`[^src-kickoff#slide-12]` → PPT 12쪽으로 점프) | 업무 문서는 "몇 쪽에 있었나"가 곧 신뢰. 원문의 personal 용례보다 요구가 높음 |
| LLM이 파일을 직접 씀 | LLM은 **변경안**만 내고 사용자 승인 후 앱이 적용 | 원문도 "humans in the loop reviewing updates"를 팀 용례에서 언급함. 감사 추적 필요 |
| 검색: 인덱스로 충분, 커지면 qmd | **SQLite FTS5를 앱에 내장** | qmd는 별도 설치·벡터 모델 필요. 사내 배포 단순화. 규모가 커지면 qmd 연동을 옵션으로 |
