// 작업 종류별 공급자 선택. PROVIDER-ROUTING.md §3 · §5
//
// **갈리는 축은 "단순함"이 아니라 판단 비중이다.** 위키는 누적 자산이라 잘못된 주장이
// 한 번 들어가면 그 위에 다른 페이지가 쌓인다. 되돌리기 비용이 비대칭이다.
//
// 토큰을 많이 먹지만 결과를 어차피 사람이 검토하는 작업은 상한이 느슨한 쪽으로 보낸다.
import type { ProviderId } from './types.ts';

export type TaskKind =
  | 'ingest.batch'
  | 'ingest.single'
  | 'lint.judgment'
  | 'dedup.ambiguous'
  | 'query'
  | 'synthesis'
  | 'schema.propose';

export interface RoutingRule {
  preferred: ProviderId;
  /** 상한에 걸렸을 때 다른 공급자로 자동 전환해도 되는가 */
  allowFallback: boolean;
  /** CLI 가 스키마를 강제해야 하는가. true 면 B등급으로 못 내려간다 */
  requiresSchema: boolean;
  /** 화면에 한 줄로 보여줄 근거 */
  why: string;
}

export const DEFAULT_ROUTING: Record<TaskKind, RoutingRule> = {
  'ingest.batch': { preferred: 'gemini', allowFallback: false, requiresSchema: false, why: '토큰 최대, 반복적. 애초에 여기로 보낸다' },
  'lint.judgment': { preferred: 'gemini', allowFallback: false, requiresSchema: false, why: '전수 스캔. 결과는 어차피 사람이 검토한다' },
  'dedup.ambiguous': { preferred: 'gemini', allowFallback: false, requiresSchema: false, why: '후보 제시일 뿐, 병합은 사람이 승인한다' },
  'ingest.single': { preferred: 'claude-code', allowFallback: true, requiresSchema: false, why: '감독 모드. 사람이 옆에서 본다' },
  query: { preferred: 'claude-code', allowFallback: true, requiresSchema: false, why: '답변 품질이 곧 신뢰다' },
  synthesis: { preferred: 'claude-code', allowFallback: true, requiresSchema: false, why: '위키에 남는 산문이다' },
  // 스키마는 다른 모든 작업의 계약이라 여기서 품질이 떨어지면 손상이 전파된다.
  'schema.propose': { preferred: 'claude-code', allowFallback: false, requiresSchema: true, why: '스키마가 틀리면 이후 전부가 틀어진다' },
};

/** 스키마를 CLI 가 강제하는 공급자 (PLAN.md §7.1 A등급). */
export const SCHEMA_ENFORCING: readonly ProviderId[] = ['claude-code', 'codex'];

export interface RouteContext {
  /** `detect()` 로 확인한 설치·인증된 공급자 */
  available: readonly ProviderId[];
  /** 월 상한 100% 에 닿은 공급자 */
  overLimit?: readonly ProviderId[];
  /** 사용자가 설정에서 바꾼 값. 정책보다 우선한다 */
  overrides?: Partial<Record<TaskKind, ProviderId>>;
}

export type Route =
  | { ok: true; provider: ProviderId; fallback: boolean; why: string }
  | { ok: false; reason: string };

/**
 * 폴백은 **상한에 걸렸을 때만** 한다. 미설치는 폴백 사유가 아니라 설정 문제라
 * 사람에게 알려야 한다 — 조용히 다른 공급자로 넘기면 왜 품질이 달라졌는지 모른다.
 */
export function route(kind: TaskKind, ctx: RouteContext, rules: Record<TaskKind, RoutingRule> = DEFAULT_ROUTING): Route {
  const rule = rules[kind];
  const over = new Set(ctx.overLimit ?? []);
  const available = new Set(ctx.available);

  const override = ctx.overrides?.[kind];
  if (override) {
    if (!available.has(override)) return { ok: false, reason: `설정한 공급자를 쓸 수 없습니다: ${override}` };
    if (rule.requiresSchema && !SCHEMA_ENFORCING.includes(override)) {
      return { ok: false, reason: `${kind} 는 스키마를 강제하는 공급자여야 합니다` };
    }
    return { ok: true, provider: override, fallback: false, why: '사용자 설정' };
  }

  if (available.has(rule.preferred) && !over.has(rule.preferred)) {
    return { ok: true, provider: rule.preferred, fallback: false, why: rule.why };
  }
  if (!available.has(rule.preferred)) {
    return { ok: false, reason: `기본 공급자가 설치돼 있지 않습니다: ${rule.preferred}` };
  }

  // 여기부터는 상한에 걸린 경우다
  if (!rule.allowFallback) {
    return { ok: false, reason: `${rule.preferred} 가 상한에 닿았고 ${kind} 는 자동 전환을 금지합니다` };
  }
  const alt = [...available].find(
    (p) => p !== rule.preferred && !over.has(p) && (!rule.requiresSchema || SCHEMA_ENFORCING.includes(p)),
  );
  if (!alt) return { ok: false, reason: '전환할 공급자가 없습니다' };
  return { ok: true, provider: alt, fallback: true, why: `${rule.preferred} 상한 도달로 전환` };
}
