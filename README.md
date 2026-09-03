# co-secondbrain

프로젝트 단위 Second Brain 프레임워크 — Windows 데스크톱 앱.

이메일·회의 전사·Word·Excel·PowerPoint·PDF·Markdown을 프로젝트 폴더(Vault)에 넣으면,
LLM이 점진적으로 **위키**를 짓고 유지합니다. 질의할 때마다 원본을 다시 훑는 대신,
축적된 위키가 답합니다.

> 현재 상태: **계획 단계.** 구현 코드 없음.

## 문서

| 문서 | 내용 |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | 전체 계획 — 아키텍처, 팀 협업 설계, 마일스톤, 리스크 |
| [docs/DESIGN-SYSTEM.md](docs/DESIGN-SYSTEM.md) | 디자인 토큰·컴포넌트 규칙 |
| [docs/REFERENCE-llm-wiki.md](docs/REFERENCE-llm-wiki.md) | 참고한 LLM Wiki 패턴 요약과 본 프로젝트의 차이점 |
| [design/design.md](design/design.md) | 원본 디자인 명세 (첨부 원본 그대로) |

## 확정된 선택

- **Electron + TypeScript**, NSIS 설치본
- LLM은 **교체 가능한 어댑터** — 기본값은 설치된 Claude Code CLI 호출
- Vault는 **일반 폴더**. Git 의존성 없음. 앱 내부 스냅샷으로 되돌리기
- **개인 사용 + 사내 공유 폴더 기반 팀 협업** 둘 다 지원
- 클라우드 컴포넌트 없음. 텔레메트리·자동업데이트 없음

## 착수 전 확인이 필요한 사항

`docs/PLAN.md` §1과 §11 참조. 요약하면:

1. Claude Code CLI를 쓰면 문서 본문이 사내망 밖으로 나갑니다 —
   "클라우드 접속 없음" 요구사항과 충돌합니다.
2. 원본 디자인 명세가 배경색에 대해 서로 반대되는 지시를 담고 있습니다.
3. 미검증 가정 4건(U1–U4)은 M0 스파이크에서 실측합니다.
