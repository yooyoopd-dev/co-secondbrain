# CLI 규약 측정 재현 (M0 항목 1·3)

실제 API 호출이 발생합니다. 아래 측정은 2026-09-03 Linux / Claude Code 2.1.259 기준.

## 1. 스키마 강제 확인

```bash
node cli/probe.mjs --claude
```

`structured_output`이 파싱된 객체로 오는지, `path`가 스키마 제약을 지키는지 확인합니다.

## 2. 비용 3종 비교

```bash
node cli/cost.mjs          # 기본 / 도구차단 / 세션재개 3회를 돌려 표로 출력
```

측정된 값 (sonnet-5, 4줄짜리 한국어 회의록):

| 조건 | 턴 | cache생성 | cache읽기 | 출력 | 비용 | 시간 |
|---|---|---|---|---|---|---|
| 기본 (파일 탐색 허용) | 8 | 34,506 | 66,087 | 2,476 | $0.176 | 24s |
| 도구 차단 + 내용 인라인 | 2 | 29,747 | 0 | 1,054 | $0.130 | 10s |
| + 세션 재개 | 2 | 1,713 | 29,747 | 3,605 | $0.049 | 40s |

고정 오버헤드가 약 3만 토큰. 세션 재개 시 cache 생성 → 읽기로 바뀌어 62% 절감.

## 3. Windows 사내 PC에서 확인 (W1~W3)

```powershell
powershell -ExecutionPolicy Bypass -File cli\windows-check.ps1
```
