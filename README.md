# co-secondbrain

프로젝트 단위 Second Brain 프레임워크 — Windows 데스크톱 앱.

이메일·회의 전사·Word·Excel·PowerPoint·PDF·Markdown을 넣으면 LLM이 점진적으로 **위키**를
짓고 유지합니다. 질의할 때마다 원본을 다시 훑는 대신, 축적된 위키가 답합니다.

**개인 로컬 세컨브레인이 기본**이고, 프로젝트 단위 **CO 영역**은 사내 로컬 서버(CO-Hub)를
통해 동료와 주고받습니다. 클라우드 컴포넌트 없음.

> 현재 상태: **계획 v0.4 · M0 스파이크 완료.** 검증 코드는 `spikes/`, 결과는 `docs/M0-RESULTS.md`.

```
[PC A]  personal/  +  projects/ACME/ ──┐
                                        ├── 사내망 HTTP ──▶ [CO-Hub]
[PC B]  personal/  +  projects/ACME/ ──┘                     SQLite + blob
                                                             LLM 없음. 동기화만.
```

## 문서

| 문서 | 내용 |
|---|---|
| [docs/M0-RESULTS.md](docs/M0-RESULTS.md) | **M0 실측 결과** — 측정이 계획을 3군데 뒤집음 |
| [docs/PLAN.md](docs/PLAN.md) | 전체 계획 — 개인/CO 이중 공간, 3계층 위키, 인제스트·질의·린트, CLI 어댑터, 마일스톤 |
| [docs/HUB.md](docs/HUB.md) | CO-Hub 서버 — 데이터 모델, API, 동기화 알고리즘, 보안, 운영 |
| [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) | 디자인 토큰·컴포넌트 규칙 |
| [docs/REFERENCE-llm-wiki.md](docs/REFERENCE-llm-wiki.md) | 기반이 된 Karpathy "LLM Wiki" 원문 정리 및 본 설계의 반영·변형 내역 |
| [docs/REVIEW-graphify.md](docs/REVIEW-graphify.md) | 선행 사례 graphify 검토 — v0.3의 변경 근거 |
| [design/design.md](design/design.md) | 원본 디자인 명세 (첨부 원본 보존) |

## 확정된 선택

- **Electron + TypeScript**, NSIS 설치본
- LLM은 **Claude Code CLI / Gemini CLI / Codex CLI** 3종 — 사내에서 예외적으로 허용된 통로.
  로컬 LLM 사용 안 함. 어댑터로 추상화하고 출력 계약은 ChangeSet JSON 한 덩어리로 고정
- 신뢰도는 주장 단위 **EXTRACTED / INFERRED / AMBIGUOUS** + 이산 점수 루브릭.
  "이 문장이 원본에 적혀 있었나, 추론인가"를 항상 구분
- 위키는 **Obsidian 호환** 마크다운 — wikilink, YAML front-matter, 고정 첨부 폴더.
  앱이 Obsidian 역할을 하되 병행 사용을 막지 않음
- 개인 금고는 **일반 폴더**. Git 의존성 없음. 앱 내부 스냅샷으로 되돌리기
- CO 영역은 **허브 DB가 버전 관리**. 낙관적 동시성(`If-Match` → 409 → 3-way 병합).
  파일 잠금 없음
- 텔레메트리·자동업데이트·크래시 리포터 없음

## 핵심 설계 결정 3가지

1. **LLM은 디스크에 직접 쓰지 않는다.** 변경안(ChangeSet)을 내고 사람이 diff로 승인하면
   앱이 적용한다. 업무용에 필요한 감사 추적과 되돌리기가 여기서 나온다.
2. **모든 주장에 앵커 인용.** `[^src-kickoff#slide-12]`를 클릭하면 실제 PPT 12쪽으로 점프한다.
   출처 없는 문장은 Lint가 잡는다.
3. **허브는 멍청하다.** LLM도 비즈니스 로직도 없다. 서버가 죽어도 로컬 미러로 계속 일한다.
4. **공짜로 뽑을 수 있는 구조는 LLM에게 묻지 않는다.** 이메일 스레드는 `In-Reply-To`
   헤더로, 엑셀 의존 관계는 수식의 셀 참조로, 고아 페이지는 링크 그래프로 계산한다.

## M0에서 측정이 뒤집은 것

1. **비용의 대부분은 우리 문서가 아니라 CLI 자체의 고정 오버헤드**(약 3만 토큰).
   문서 4줄에 $0.13. 세션을 재개하면 62% 절감 → **배치 처리가 최적화가 아니라 필수**.
2. **한글 자모 분해는 유사도를 오히려 악화시킨다.** 도움이 될 거라 예상했으나 모든 임계값에서
   오병합이 같거나 더 많았음. 미채택.
3. **의외의 연결은 허브 노드를 빼야 한다.** 안 빼면 순위가 오염됨. 정답 포착 1/3 → 3/3.

차용한 파라미터도 한국어에서 두 개가 틀렸습니다 — 엔트로피 게이트에 길이 하한이 필요하고,
Jaro-Winkler 임계는 0.92가 아니라 0.96이어야 합니다.

## 다음 단계

M1 착수 가능. 사내 Windows PC에서 `spikes/cli/windows-check.ps1`을 한 번 돌려 주시면
남은 변수(사내 정책상 MCP 등록 가능 여부)가 정리됩니다 — M1을 막지는 않습니다.
