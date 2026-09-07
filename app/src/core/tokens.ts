// 한국어 글자수 → 토큰수 → 비용. W10 · docs/ROADMAP.md 8번
//
// Lint 전수 검사를 돌리기 전에 "이 스캔에 약 얼마" 를 사람에게 보여주려면 환산이 필요하다.
// 전부 실측값이고 근거를 같이 적는다.
//
// 측정 방법: 프롬프트 접두사를 고정하고 뒤에 붙는 한국어 분량만 바꿔 다섯 번 호출했다
// (`spikes/korean/tokens.ts`). CLI 자기 시스템 프롬프트는 cache 읽기로 빠지므로
// cache 생성 증분이 우리 내용에 해당한다.
import { COST } from './agent/batch.ts';

/**
 * 2026-09-05 실측 (`claude-sonnet-5`, 이 저장소 문서의 한국어 산문).
 *
 * | 글자 | 증분 토큰 | 토큰/글자 |
 * |---|---|---|
 * | 500 | 444 | 0.888 |
 * | 1,500 | 1,337 | 0.891 |
 * | 4,000 | 3,618 | 0.905 |
 * | 8,000 | 6,775 | 0.847 |
 *
 * 표본 n=4. **실측 최대(0.905) 위로 0.92 를 쓴다.** 처음에 0.9 로 잡았다가 4,000자
 * 지점에서 과소 추정이 나는 것을 테스트가 잡았다. 예상보다 싸게 나오는 편이 비싸게
 * 나오는 것보다 낫다 — 사람이 이 숫자를 보고 실행을 결정한다.
 */
export const TOKENS_PER_CHAR = 0.92;

/**
 * cache 생성 1M 토큰당 달러. 같은 측정의 증분에서 나왔다 —
 * 0자 $0.02759 / 8,000자 $0.05342, 차이 $0.02583 에 6,775 토큰.
 * 작은 표본(500자)에서는 출력 변동에 묻혀 흔들린다. 큰 두 점이 3.62~3.81 이라 3.75 를 쓴다.
 */
export const USD_PER_MTOK = 3.75;

/**
 * 배치 안에서 항목 하나를 더 처리하는 고정분. `COST.resumedTypicalUsd` 를 그대로 쓴다.
 *
 * 처음에는 5건 배치 실측 평균 $0.0165 로 잡았다가 되돌렸다. 그 배치는 원본이 한 줄짜리라
 * 출력도 짧았다. 2026-09-05 A/B 측정(20건 × 2팔, 실제 위키 페이지 분량)에서 재개분이
 * **$0.042** 로 나왔고 M0 의 $0.049 에 가까웠다. 짧은 합성 입력이 값을 절반 이하로
 * 낮춰 보이게 했다.
 *
 * 셋 중 가장 큰 $0.049 를 쓴다 — 과소 추정보다 과대 추정이 낫다.
 */
export const PER_ITEM_USD = COST.resumedTypicalUsd;

export function estimateTokens(chars: number): number {
  return Math.round(Math.max(0, chars) * TOKENS_PER_CHAR);
}

export interface ScanEstimate {
  items: number;
  chars: number;
  tokens: number;
  usd: number;
}

/**
 * 전수 검사 비용. **한 세션에 배치로 돈다는 전제다** — 페이지마다 프로세스를 띄우면
 * 고정 오버헤드가 $0.11 씩 붙어 여섯 배가 넘는다 (M2-PLAN.md §2).
 */
export function estimateScan(charCounts: readonly number[]): ScanEstimate {
  const chars = charCounts.reduce((a, b) => a + Math.max(0, b), 0);
  const tokens = estimateTokens(chars);
  const items = charCounts.length;
  if (items === 0) return { items: 0, chars: 0, tokens: 0, usd: 0 };
  const usd = COST.coldTypicalUsd + (items - 1) * PER_ITEM_USD + (tokens * USD_PER_MTOK) / 1e6;
  return { items, chars, tokens, usd };
}

/** 실행 전에 보여줄 한 줄. 남은 예산과 나란히 띄운다. */
export function summarizeScan(e: ScanEstimate): string {
  return `${e.items}건 · ${e.chars.toLocaleString('ko')}자 · 약 ${e.tokens.toLocaleString('ko')}토큰 · 예상 $${e.usd.toFixed(2)}`;
}
