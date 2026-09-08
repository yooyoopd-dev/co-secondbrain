// 렌더러에 노출하는 IPC 계약. 렌더러는 파일시스템에 직접 접근하지 않는다.
import type { Extraction, SearchHit } from '../core/types.ts';
import type { VaultConfig } from '../core/vault.ts';
import type { Review } from '../core/review.ts';
import type { ApplyResult } from '../core/changeset.ts';
import type { WorkPlan } from '../core/cache.ts';
import type { Status } from '../core/spend.ts';
import type { Answer } from '../core/query.ts';
import type { ParsedJudgment } from '../core/lint/judgment.ts';
import type { LintReport } from '../core/lint/index.ts';
import type { RejectedPair } from '../core/lint/rejected.ts';
import type { ScanEstimate } from '../core/tokens.ts';
import type { SyncConflict, SyncReport } from '../core/sync/index.ts';
import type { LogEntry } from '../core/log.ts';
import type { Classification } from '../core/types.ts';
import type { ProviderId } from '../core/agent/types.ts';
import type { CoreContext } from '../core/context.ts';
import type { LocalConfig, LocalStatus } from '../core/local/ollama.ts';

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
  /**
   * `01_SOURCES/` 에 파일이 없다. 사람이 지웠다는 뜻이다.
   *
   * 위키가 인용 중인 원본은 추출물을 안 지운다 — 지우면 관문 5 의 근거가 사라져
   * 그 원본을 인용한 페이지가 전부 검사에서 막힌다. 표시만 바꾼다 (ROADMAP §21).
   */
  missing: boolean;
}

/** 사라진 원본을 훑은 결과. 새로 고침 버튼이 사람에게 알린다 */
export interface SourceSweep {
  /** 인용이 없어 통째로 뺀 것 */
  removed: string[];
  /** 위키가 인용 중이라 남겨 둔 것 */
  kept: string[];
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

/** 어느 CLI 가 이 작업을 맡는가. 누르기 전에 화면에 적어 둔다 */
export type ProviderPick =
  | { ok: true; provider: ProviderId; why: string }
  | { ok: false; reason: string };

/** 화면이 라벨에 쓰는 두 가지. 나머지 작업은 아직 라벨을 안 붙였다 */
export interface TaskProviders {
  /** [위키에 묻기] */
  query: ProviderPick;
  /** [위키 갱신] */
  ingest: ProviderPick;
  /**
   * 질의를 로컬 모델로 받나. 그러면 `query` 가 거절해도 버튼은 살아 있다.
   *
   * 설정 한 벌(`settings()`)에도 같은 값이 있지만 그쪽은 설정 화면을 열어야 읽힌다.
   * 버튼은 언제나 제 라벨을 알아야 하므로 여기에도 넣는다.
   */
  answerWith: AnswerWith;
}

/** 전체 보류해 둔 변경안 요약. 레일의 배지가 쓴다 */
export interface HeldReviewInfo {
  at: string;
  summary: string;
  ops: number;
}

/** 허브 연결 상태. 좌측 레일과 동기화 화면이 같이 쓴다 */
export interface HubStatus {
  /** 개인 Vault 인가. 그렇다면 동기화 자체가 없다 */
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
  /** 열려 있는 Vault 의 폴더. 안 열었으면 null */
  vaultRoot: string | null;
  vaultTitle: string | null;
  /**
   * 허브에 붙은 CO 영역인가. 안 열었으면 null.
   *
   * **좌측 레일과 같은 규칙(`config.hub`)을 쓴다.** 전에는 여기만 `id === 'personal'`
   * 로 봤는데, 화면에서 만든 Vault 는 id 가 폴더 이름이라 개인 Vault 도 전부 CO 영역으로
   * 나왔다. 판정이 두 벌이면 둘 중 하나는 반드시 틀린다.
   */
  co: boolean | null;
  /** 사용자가 고정한 공급자. null 이면 작업 종류별 라우팅 */
  provider: ProviderId | null;
  providers: { id: ProviderId; label: string; note: string; installed: boolean }[];
  /** [위키에 묻기] 를 무엇으로 답하나. 다른 작업은 이 값과 무관하다 */
  answerWith: AnswerWith;
  local: LocalConfig;
}

/**
 * 질의를 어디로 보내나. **공급자와 다른 축이다** — `provider` 는 예산을 쓰는 외부 CLI 를
 * 고르고, 이것은 외부로 보낼지 말지를 고른다 (docs/LOCAL-LLM.md §5).
 */
export type AnswerWith = 'cli' | 'local';

/** 로컬 모델이 지금 쓸 만한가. 네트워크를 타므로 설정 화면이 열릴 때만 부른다 */
export interface LocalInfo {
  status: LocalStatus;
  /** 위키를 자른 조각 수 */
  chunks: number;
  /** 그중 임베딩이 만들어져 있는 수. 0 이면 키워드로만 찾는다 */
  vectors: number;
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
  /** 사라진 원본을 정리한다. 위키가 인용 중인 것은 남긴다 */
  sweepSources(): Promise<SourceSweep>;
  /** 위키가 실제로 인용하고 있는 원본 id. 목록의 반영 표시가 이걸 본다 */
  citedSources(): Promise<string[]>;
  search(query: string): Promise<SearchHit[]>;
  readSource(sourceId: string): Promise<Extraction | null>;
  /** 원본 하나로 ChangeSet 을 만들어 검토 화면 재료를 돌려준다. 디스크는 안 바뀐다 */
  propose(sourceId: string): Promise<ProposeResult>;
  /** 관문 8 — 사람이 승인한 경로만 적용한다 */
  applyReview(approved: string[]): Promise<ApplyResult>;
  discardReview(): Promise<void>;
  /** 지금 상태 그대로 `.sb/` 에 두고 나간다. 다시 열 때까지 아무것도 적용되지 않는다 */
  holdReview(approved: string[]): Promise<void>;
  /** 보류해 둔 것이 있는가. 없으면 null */
  heldReview(): Promise<HeldReviewInfo | null>;
  /** 보류한 것을 다시 연다. 관문을 처음부터 다시 돌린 결과가 온다 */
  resumeReview(): Promise<{ review: Review; approved: string[] } | null>;
  /** 도는 CLI 를 끊는다. 도는 것이 없으면 false */
  cancelAgent(): Promise<boolean>;
  /**
   * CLI 가 뱉는 것을 받는다. **이 표면에서 유일하게 main 이 밀어 주는 채널이다.**
   * 돌려주는 것을 부르면 구독을 끊는다.
   */
  agentOutput(cb: (chunk: string) => void): () => void;
  /** 지금 설정에서 어느 CLI 가 어느 작업을 맡는지 */
  taskProviders(): Promise<TaskProviders>;
  /** 검토 화면에서 고친 내용을 반영하고 관문을 다시 돌린다 */
  editOp(path: string, content: string): Promise<Review>;
  /** 없는 앵커 인용을 지우고 관문을 다시 돌린다. 관문은 그대로다 */
  repairAnchors(): Promise<{ review: Review; removed: number }>;
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
  /** LLM 없이 도는 검사 일곱 가지. 돈이 안 들어 언제 불러도 된다 */
  lintComputed(): Promise<LintReport>;
  /** 중복 후보 하나를 "다른 대상" 으로 기록한다. 다음부터 안 뜬다 */
  rejectDuplicate(a: string, b: string): Promise<RejectedPair[]>;
  /** 잘못 누른 거부를 무른다 */
  unrejectDuplicate(a: string, b: string): Promise<RejectedPair[]>;
  /** 거부한 쌍 전부. 누적 개수가 곧 오병합 건수다 */
  rejectedDuplicates(): Promise<RejectedPair[]>;
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
  /** 질의를 외부 CLI 로 받을지 로컬 모델로 받을지 */
  setAnswerWith(mode: AnswerWith): Promise<void>;
  setLocalConfig(cfg: Partial<LocalConfig>): Promise<void>;
  /** Ollama 에 실제로 물어본 상태와 임베딩 진척 */
  localInfo(): Promise<LocalInfo>;
  /** 위키 임베딩을 만든다. 본문이 그대로인 조각은 다시 안 만든다 */
  buildVectors(): Promise<{ ok: true; made: number; total: number } | { ok: false; error: string }>;

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
  sweepSources: 'sb:sweepSources',
  citedSources: 'sb:citedSources',
  search: 'sb:search',
  readSource: 'sb:readSource',
  propose: 'sb:propose',
  applyReview: 'sb:applyReview',
  discardReview: 'sb:discardReview',
  holdReview: 'sb:holdReview',
  heldReview: 'sb:heldReview',
  resumeReview: 'sb:resumeReview',
  cancelAgent: 'sb:cancelAgent',
  agentOutput: 'sb:agentOutput',
  taskProviders: 'sb:taskProviders',
  editOp: 'sb:editOp',
  repairAnchors: 'sb:repairAnchors',
  spendStatus: 'sb:spendStatus',
  plan: 'sb:plan',
  ask: 'sb:ask',
  archiveAnswer: 'sb:archiveAnswer',
  estimateJudgment: 'sb:estimateJudgment',
  lintComputed: 'sb:lintComputed',
  rejectDuplicate: 'sb:rejectDuplicate',
  unrejectDuplicate: 'sb:unrejectDuplicate',
  rejectedDuplicates: 'sb:rejectedDuplicates',
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
  setAnswerWith: 'sb:setAnswerWith',
  setLocalConfig: 'sb:setLocalConfig',
  localInfo: 'sb:localInfo',
  buildVectors: 'sb:buildVectors',
  coreContext: 'sb:coreContext',
  setCoreContext: 'sb:setCoreContext',
  logs: 'sb:logs',
  copyLogs: 'sb:copyLogs',
  saveLogs: 'sb:saveLogs',
  clearLogs: 'sb:clearLogs',
  reportError: 'sb:reportError',
} as const;
