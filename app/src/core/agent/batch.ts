// 배치 러너 — 한 프로세스로 여러 문서를 처리한다. M2-PLAN.md §2.1, PLAN.md §7.1.1
//
// **이건 최적화가 아니라 요건이다.** 콜드 실행 1회의 비용 바닥이 $0.113 이고 그 대부분이
// CLI 자기 시스템 프롬프트다. 문서마다 프로세스를 띄우면 월 $50 으로 약 385건,
// 세션을 이어 붙이면 약 1,020건이다.
//
// 첫 문서만 콜드로 돌고 나머지는 `--resume` 으로 붙는다. 그러면 cache **생성**이
// cache **읽기**로 바뀐다.
import type { AgentCli, AgentResult, Usage } from './types.ts';
import { addUsage, ZERO_USAGE } from './types.ts';

/** 실측 비용 (2026-09-05, `claude-sonnet-5`). 남은 예산을 문서 수로 환산할 때 쓴다. */
export const COST = {
  /** 콜드 실행 1회의 바닥. 프롬프트 2토큰으로 잰 값이라 이 아래로는 못 내려간다 (n=1) */
  coldFloorUsd: 0.113,
  /** 도구 차단 + 내용 인라인. 4줄 회의록 기준 (M0 §7.1.1) */
  coldTypicalUsd: 0.13,
  /** 세션 재개. 같은 문서 기준 (M0 §7.1.1) */
  resumedTypicalUsd: 0.049,
} as const;

export interface BatchItem {
  /** 로그·재시도에 쓰는 식별자. 보통 원본 id */
  id: string;
  prompt: string;
}

export interface BatchOutcome {
  id: string;
  result: AgentResult;
}

export interface BatchReport {
  outcomes: BatchOutcome[];
  /** 예산이 끊겨 손도 못 댄 항목. 그대로 다음 배치로 넘긴다 */
  remaining: string[];
  usage: Usage;
  /** 세션 재개로 아낀 몫이 실제로 났는지 사람이 볼 수 있게 */
  coldRuns: number;
  stoppedBy?: 'budget';
}

export interface BatchOptions {
  /** 격리 작업 디렉터리. 배치 전체가 같은 곳에서 돈다 */
  workdir: string;
  /**
   * 이번 배치에 쓸 수 있는 금액. 다음 호출의 예상 비용을 더해 넘칠 것 같으면
   * **호출하기 전에** 멈춘다. 이미 만든 결과는 그대로 돌려준다 (PLAN.md §9.4).
   */
  budgetUsd?: number;
}

/** 남은 예산으로 몇 건이나 더 되는지. 화면에 달러 대신 이걸 띄운다 (M2-PLAN.md §3.4). */
export function documentsAffordable(budgetUsd: number): number {
  if (budgetUsd < COST.coldTypicalUsd) return 0;
  const rest = (budgetUsd - COST.coldTypicalUsd) / COST.resumedTypicalUsd;
  // 0.179 - 0.13 은 0.04899999... 라서 그냥 floor 하면 딱 떨어지는 예산에서 한 건을 잃는다.
  // 달러는 소수점 6자리 아래로 의미가 없으므로 거기서 끊는다.
  return 1 + Math.floor(Number(rest.toFixed(6)));
}

/**
 * 항목을 순서대로 돌린다. 한 건이 실패해도 배치를 죽이지 않고 다음으로 넘어간다 —
 * 20건짜리 백로그가 3번째에서 통째로 날아가면 앞의 두 건 비용도 버리게 된다.
 */
export async function runBatch(
  cli: AgentCli,
  items: readonly BatchItem[],
  schema: object,
  opts: BatchOptions,
): Promise<BatchReport> {
  const outcomes: BatchOutcome[] = [];
  let usage = ZERO_USAGE;
  let session: string | null = null;
  let coldRuns = 0;

  for (const [i, item] of items.entries()) {
    const estimate = session ? COST.resumedTypicalUsd : COST.coldTypicalUsd;
    if (opts.budgetUsd !== undefined && usage.costUsd + estimate > opts.budgetUsd) {
      return { outcomes, remaining: items.slice(i).map((x) => x.id), usage, coldRuns, stoppedBy: 'budget' };
    }

    if (!session) coldRuns++;
    const result = await cli.run({ workdir: opts.workdir, prompt: item.prompt, resumeSessionId: session }, schema);
    usage = addUsage(usage, result.usage);
    outcomes.push({ id: item.id, result });

    // 세션 id 를 못 받으면 다음도 콜드로 돈다. 비싸지만 배치가 멈추는 것보다 낫다.
    if (result.sessionId) session = result.sessionId;
  }

  return { outcomes, remaining: [], usage, coldRuns };
}
