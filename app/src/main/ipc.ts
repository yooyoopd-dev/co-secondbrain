// 렌더러에 노출하는 IPC 계약. 렌더러는 파일시스템에 직접 접근하지 않는다.
import type { Extraction, SearchHit } from '../core/types.ts';
import type { VaultConfig } from '../core/vault.ts';
import type { Review } from '../core/review.ts';
import type { ApplyResult } from '../core/changeset.ts';
import type { WorkPlan } from '../core/cache.ts';
import type { Status } from '../core/spend.ts';

export interface IngestResult {
  ok: string[];
  failed: { filename: string; reason: string }[];
  warnings: { filename: string; warning: string }[];
  relations: number;
}

export interface SourceSummary {
  sourceId: string;
  filename: string;
  kind: string;
  chunks: number;
}

/** 변경안 제안 결과. 실패해도 던지지 않는다 — 렌더러가 사유를 그대로 보여준다. */
export type ProposeResult =
  | { ok: true; review: Review; costUsd: number }
  | { ok: false; error: string };

/** preload 가 window.sb 로 노출하는 표면. 이 목록 밖의 것은 렌더러가 못 부른다. */
export interface SbApi {
  pickVault(mode: 'open' | 'create'): Promise<VaultConfig | null>;
  currentVault(): Promise<VaultConfig | null>;
  pickAndIngest(): Promise<IngestResult>;
  listSources(): Promise<SourceSummary[]>;
  search(query: string): Promise<SearchHit[]>;
  readSource(sourceId: string): Promise<Extraction | null>;
  /** 원본 하나로 ChangeSet 을 만들어 검토 화면 재료를 돌려준다. 디스크는 안 바뀐다 */
  propose(sourceId: string): Promise<ProposeResult>;
  /** 관문 8 — 사람이 승인한 경로만 적용한다 */
  applyReview(approved: string[]): Promise<ApplyResult>;
  discardReview(): Promise<void>;
  /** 공급자별 이번 달 소비와 남은 문서 수 */
  spendStatus(): Promise<Status[]>;
  /** 아직 변경안을 안 만든 원본. 이름만 바뀐 것은 빠진다 */
  plan(): Promise<WorkPlan>;
}

export const IPC = {
  pickVault: 'sb:pickVault',
  currentVault: 'sb:currentVault',
  pickAndIngest: 'sb:pickAndIngest',
  listSources: 'sb:listSources',
  search: 'sb:search',
  readSource: 'sb:readSource',
  propose: 'sb:propose',
  applyReview: 'sb:applyReview',
  discardReview: 'sb:discardReview',
  spendStatus: 'sb:spendStatus',
  plan: 'sb:plan',
} as const;
