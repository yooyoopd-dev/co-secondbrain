// 렌더러에 노출하는 IPC 계약. 렌더러는 파일시스템에 직접 접근하지 않는다.
import type { Extraction, SearchHit } from '../core/types.ts';
import type { VaultConfig } from '../core/vault.ts';
import type { Review } from '../core/review.ts';
import type { ApplyResult } from '../core/changeset.ts';
import type { WorkPlan } from '../core/cache.ts';
import type { Status } from '../core/spend.ts';
import type { Answer } from '../core/query.ts';
import type { ParsedJudgment } from '../core/lint/judgment.ts';
import type { ScanEstimate } from '../core/tokens.ts';

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

export type AskResult =
  | { ok: true; question: string; answer: Answer; costUsd: number }
  | { ok: false; error: string };

export type JudgmentResult =
  | { ok: true; result: ParsedJudgment; costUsd: number }
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
  /** 검토 화면에서 고친 내용을 반영하고 관문을 다시 돌린다 */
  editOp(path: string, content: string): Promise<Review>;
  /** 공급자별 이번 달 소비와 남은 문서 수 */
  spendStatus(): Promise<Status[]>;
  /** 아직 변경안을 안 만든 원본. 이름만 바뀐 것은 빠진다 */
  plan(): Promise<WorkPlan>;
  /** 위키에 묻는다. 답변은 디스크에 안 쓴다 */
  ask(question: string): Promise<AskResult>;
  /** 답변을 보관 대기로 올린다. 승인해야 synthesis 페이지가 된다 */
  archiveAnswer(question: string, answer: Answer): Promise<Review>;
  /** 실행 전에 보여줄 예상 비용 */
  estimateJudgment(): Promise<ScanEstimate>;
  /** Lint 판단 검사 4종. 제안일 뿐 자동으로 고치지 않는다 */
  lintJudgment(): Promise<JudgmentResult>;
  /** Marp 덱을 파일로 저장한다. 저장한 경로를 돌려주고, 취소하면 null */
  exportDeck(): Promise<string | null>;
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
  editOp: 'sb:editOp',
  spendStatus: 'sb:spendStatus',
  plan: 'sb:plan',
  ask: 'sb:ask',
  archiveAnswer: 'sb:archiveAnswer',
  estimateJudgment: 'sb:estimateJudgment',
  lintJudgment: 'sb:lintJudgment',
  exportDeck: 'sb:exportDeck',
} as const;
