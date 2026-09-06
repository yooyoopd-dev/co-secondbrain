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
import type { SyncConflict, SyncReport } from '../core/sync/index.ts';
import type { LogEntry } from '../core/log.ts';
import type { Classification } from '../core/types.ts';
import type { ProviderId } from '../core/agent/types.ts';
import type { CoreContext } from '../core/context.ts';

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
  classification: Classification;
}

/** 받은 편지함(`00_INBOX/`)의 파일 한 건 */
export interface InboxItem {
  filename: string;
  bytes: number;
  /** 앱이 읽을 수 있는 확장자인가 */
  supported: boolean;
  /** 이미 넣은 것인가. 내용 해시로 판정하므로 이름을 바꿔도 같은 것으로 본다 */
  ingested: boolean;
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

/** 허브 연결 상태. 좌측 레일과 동기화 화면이 같이 쓴다 */
export interface HubStatus {
  /** 개인 금고인가. 그렇다면 동기화 자체가 없다 */
  personal: boolean;
  hub: string | null;
  hasToken: boolean;
  /** 이 시스템에서 토큰을 암호화해 보관할 수 있는가 */
  canStoreToken: boolean;
  /** 아직 허브로 못 올린 로컬 변경 수 */
  pending: number;
  cursor: number;
  conflicts: number;
}

export type SyncResult = { ok: true; report: SyncReport } | { ok: false; error: string };

/** 병합 결과를 올린 뒤. 남은 충돌 목록을 같이 준다 — 화면이 다시 묻지 않아도 된다 */
export type ResolveResult =
  | { ok: true; version: number; conflicts: SyncConflict[] }
  | { ok: false; error: string; conflicts?: SyncConflict[] };

/** 설정 화면 한 벌 */
export interface AppSettings {
  /** `app.getVersion()` — package.json 의 값이다 */
  version: string;
  /** 열려 있는 금고의 폴더. 안 열었으면 null */
  vaultRoot: string | null;
  vaultTitle: string | null;
  /** 개인 금고인가. 안 열었으면 null */
  personal: boolean | null;
  /** 사용자가 고정한 공급자. null 이면 작업 종류별 라우팅 */
  provider: ProviderId | null;
  providers: { id: ProviderId; label: string; note: string; installed: boolean }[];
}

/** 오류 기록 한 벌. 배지에 쓸 오류 건수를 같이 준다 */
export interface LogSnapshot {
  entries: LogEntry[];
  errors: number;
}

/** preload 가 window.sb 로 노출하는 표면. 이 목록 밖의 것은 렌더러가 못 부른다. */
export interface SbApi {
  pickVault(mode: 'open' | 'create'): Promise<VaultConfig | null>;
  currentVault(): Promise<VaultConfig | null>;
  /** Vault 를 닫고 첫 화면으로 돌아간다. 검토 대기와 충돌은 같이 버려진다 */
  closeVault(): Promise<void>;
  /** 앱을 끝낸다. 물어보는 것은 화면이 한다 */
  quit(): Promise<void>;
  /** 파일 선택 대화상자를 열어 넣는다. 등급은 넣는 사람이 고른다 */
  pickAndIngest(classification: Classification): Promise<IngestResult>;
  /** `00_INBOX/` 에 놓인 파일 목록. 앱은 이 폴더를 건드리지 않는다 */
  inbox(): Promise<InboxItem[]>;
  /** 받은 편지함에서 아직 안 넣은 것만 넣는다 */
  ingestInbox(classification: Classification): Promise<IngestResult>;
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

  /* 동기화 (HUB.md §5) */
  hubStatus(): Promise<HubStatus>;
  /** 토큰을 저장하기 전에 허브에 실제로 물어본다 */
  connectHub(url: string, token: string): Promise<{ ok: true; role: string } | { ok: false; error: string }>;
  disconnectHub(): Promise<void>;
  /** 한 번 돌린다. 충돌은 디스크를 안 건드리고 병합 화면으로 온다 */
  syncNow(): Promise<SyncResult>;
  conflicts(): Promise<SyncConflict[]>;
  /** 사람이 고른 병합 결과. 충돌 표시가 남아 있으면 거절당한다 */
  resolveConflict(pageId: string, merged: string): Promise<ResolveResult>;

  /* 설정 */
  settings(): Promise<AppSettings>;
  /** null 이면 작업 종류별 라우팅으로 되돌린다 */
  setProvider(id: ProviderId | null): Promise<void>;

  /* 나의 기준 맥락 — `09_TEMPLATES/me.md`. 동기화가 올리지 않는다 */
  coreContext(): Promise<CoreContext>;
  setCoreContext(ctx: CoreContext): Promise<void>;

  /* 오류 기록 (core/log.ts) — 파일명과 토큰은 적재 시점에 이미 지워져 있다 */
  logs(): Promise<LogSnapshot>;
  /** 클립보드에 넣는다. 넣은 줄 수를 돌려준다 */
  copyLogs(): Promise<number>;
  /** 파일로 저장한다. 저장한 경로를 돌려주고, 취소하면 null */
  saveLogs(): Promise<string | null>;
  clearLogs(): Promise<void>;
  /** 렌더러에서 난 오류를 main 의 버퍼로 넘긴다 */
  reportError(scope: string, message: string, detail?: string): Promise<void>;
}

export const IPC = {
  pickVault: 'sb:pickVault',
  currentVault: 'sb:currentVault',
  closeVault: 'sb:closeVault',
  quit: 'sb:quit',
  pickAndIngest: 'sb:pickAndIngest',
  inbox: 'sb:inbox',
  ingestInbox: 'sb:ingestInbox',
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
  hubStatus: 'sb:hubStatus',
  connectHub: 'sb:connectHub',
  disconnectHub: 'sb:disconnectHub',
  syncNow: 'sb:syncNow',
  conflicts: 'sb:conflicts',
  resolveConflict: 'sb:resolveConflict',
  settings: 'sb:settings',
  setProvider: 'sb:setProvider',
  coreContext: 'sb:coreContext',
  setCoreContext: 'sb:setCoreContext',
  logs: 'sb:logs',
  copyLogs: 'sb:copyLogs',
  saveLogs: 'sb:saveLogs',
  clearLogs: 'sb:clearLogs',
  reportError: 'sb:reportError',
} as const;
