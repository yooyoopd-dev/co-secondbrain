// 지출 계량기. PLAN.md §9.4, PROVIDER-ROUTING.md §5
//
// **아는 것과 모르는 것을 나눈다.**
// - 안다: Claude Code 응답의 `total_cost_usd`. 누적하면 소비량은 정확하다 (M0 실측)
// - 모른다: 남은 쿼터. 응답에 없고 사내 계약 상한도 앱이 알 수 없다
//
// 그래서 상한은 **사용자가 직접 입력한다.** 추측한 값으로 자동 전환하면 멀쩡한 쿼터를
// 두고 품질을 낮추게 된다.
//
// Gemini 는 비용을 아예 보고하지 않는다 (M2-PLAN.md §8.2). 호출 횟수만 센다.
//
// **이 파일은 Node 모듈을 쓰지 않는다.** 렌더러가 `summarize` 를 부른다.
// 디스크 읽기·쓰기는 `spend-file.ts` 에 있다.
import { COST, documentsAffordable } from './agent/batch.ts';
import type { ProviderId, Usage } from './agent/types.ts';

export interface DayTotal {
  costUsd: number;
  calls: number;
}

export interface SpendLog {
  version: 1;
  /** `2026-09-05` → 공급자 → 합계 */
  days: Record<string, Partial<Record<ProviderId, DayTotal>>>;
}

export const EMPTY_LOG: SpendLog = { version: 1, days: {} };

/** 공급자별 월 상한(USD). `null` 은 **모른다**는 뜻이지 무제한이 아니다. */
export type Limits = Partial<Record<ProviderId, number | null>>;

/** 사내 기업계정 실제 예산 (ROADMAP.md §0). 사용자가 설정에서 바꾼다. */
export const DEFAULT_MONTHLY_USD = 50;

export const WARN_AT = 0.8;

const day = (iso: string): string => iso.slice(0, 10);

export function add(log: SpendLog, provider: ProviderId, usage: Usage, now: string): SpendLog {
  const d = day(now);
  const prev = log.days[d]?.[provider] ?? { costUsd: 0, calls: 0 };
  return {
    ...log,
    days: {
      ...log.days,
      [d]: { ...log.days[d], [provider]: { costUsd: prev.costUsd + usage.costUsd, calls: prev.calls + 1 } },
    },
  };
}

/** 같은 달의 합계. 달 경계는 문자열 접두사로 자른다 — 시간대 계산을 끌어들이지 않는다. */
export function monthTotal(log: SpendLog, provider: ProviderId, now: string): DayTotal {
  const prefix = now.slice(0, 7);
  let costUsd = 0;
  let calls = 0;
  for (const [d, byProvider] of Object.entries(log.days)) {
    if (!d.startsWith(prefix)) continue;
    const t = byProvider[provider];
    if (t) {
      costUsd += t.costUsd;
      calls += t.calls;
    }
  }
  return { costUsd, calls };
}

export type Level = 'ok' | 'warn' | 'over' | 'unknown';

export interface Status {
  provider: ProviderId;
  spentUsd: number;
  calls: number;
  /** 사용자가 넣은 값. 모르면 null */
  limitUsd: number | null;
  /** 상한을 모르면 null */
  pct: number | null;
  level: Level;
  /** 남은 예산으로 몇 건. 화면에는 달러 대신 이걸 띄운다 (M2-PLAN.md §3.4) */
  documentsLeft: number | null;
}

export function status(log: SpendLog, limits: Limits, provider: ProviderId, now: string): Status {
  const { costUsd, calls } = monthTotal(log, provider, now);
  const limit = limits[provider] ?? null;
  if (limit === null) {
    // 상한을 모르면 경고도 폴백도 하지 않는다. 모르는 값으로 품질을 낮추지 않는다.
    return { provider, spentUsd: costUsd, calls, limitUsd: null, pct: null, level: 'unknown', documentsLeft: null };
  }
  const pct = limit > 0 ? costUsd / limit : 1;
  const left = Math.max(0, limit - costUsd);
  return {
    provider,
    spentUsd: costUsd,
    calls,
    limitUsd: limit,
    pct,
    level: pct >= 1 ? 'over' : pct >= WARN_AT ? 'warn' : 'ok',
    documentsLeft: documentsAffordable(left),
  };
}

/** 사람에게 보여줄 한 줄. 달러가 아니라 문서 수가 앞에 온다. */
export function summarize(s: Status): string {
  if (s.level === 'unknown') return `${s.provider} · 이번 달 $${s.spentUsd.toFixed(2)} · 상한 미입력`;
  const left = s.documentsLeft ?? 0;
  const head = s.level === 'over' ? '상한 도달' : `남은 문서 약 ${left}건`;
  return `${s.provider} · ${head} · $${s.spentUsd.toFixed(2)} / $${s.limitUsd?.toFixed(0)}`;
}

/** 배치를 시작하기 전에 쓸 예산. 상한을 모르면 제한하지 않는다. */
export function remainingUsd(log: SpendLog, limits: Limits, provider: ProviderId, now: string): number | undefined {
  const limit = limits[provider] ?? null;
  if (limit === null) return undefined;
  return Math.max(0, limit - monthTotal(log, provider, now).costUsd);
}

export { COST };
