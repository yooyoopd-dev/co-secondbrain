# spikes — M0 검증 코드

계획서가 "확실하지 않음"으로 표시한 항목을 추측 대신 실측하는 코드입니다.
결과는 [`../docs/M0-RESULTS.md`](../docs/M0-RESULTS.md).

```bash
npm install
node fixtures/make.mjs     # 실제 라이브러리로 샘플 문서 9개 생성
node extract/run.mjs       # 항목 6·10  추출기 + 스캔본 감지
node similarity/run.mjs    # 항목 7     한국어 엔티티 유사도
node graph/run.mjs         # 항목 8     Louvain 커뮤니티 · god node · 고아 · 의외의 연결
node sizing/run.mjs        # 항목 9     허브 DB/blob 규모
node security/run.mjs      #            sanitizeTitle 경로 탈출 방어
```

CLI 규약·비용 측정은 [`cli/README.md`](cli/README.md).
사내 Windows PC 확인은 [`cli/windows-check.ps1`](cli/windows-check.ps1).

각 스크립트는 **정답을 아는 입력**으로 돌려 PASS/FAIL을 스스로 판정합니다.
합성 데이터라는 한계는 `M0-RESULTS.md` §8에 명시했습니다.

## 한국어 출력 품질 (`korean/`)

```bash
node korean/validate.mjs   # 탐지기 검증 — 심은 패턴 54건. 오탐 0이 통과 조건
node korean/run.mjs        # 보호 구역 마스킹 + A/B 실측
```

`detect.mjs`는 im-not-ai(MIT)의 quick-rules를 이식한 **결정론적 Lint**다. 윤문 도구가 아니다.
front-matter·앵커 인용·wikilink·표·코드블록을 마스킹한 뒤 본문 산문만 검사한다.
결과는 [`../docs/REVIEW-imnotai.md`](../docs/REVIEW-imnotai.md).
