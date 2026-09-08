// Vault 상태 + 색인. main 프로세스에만 산다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex, type Db } from '../core/search.ts';
import { openVault, createVault, importSource, appendLog, setHub, EXTRACTED_DIR, PERSONAL_ID, SOURCES_DIR, TEMPLATES_DIR, type Vault } from '../core/vault.ts';
import { CORE_CONTEXT_PATH, EMPTY_CORE_CONTEXT, coreContextBlock, parseCoreContext, serializeCoreContext, type CoreContext } from '../core/context.ts';
import { extractFile, buildThreads } from '../core/extract/index.ts';
import { extractEmail, type MailMeta } from '../core/extract/email.ts';
import { safeJoin } from '../core/security.ts';
import { applyChangeSet, currentHash, repairAnchors, type ApplyResult, type ChangeSet } from '../core/changeset.ts';
import { buildReview, editOp, selectOps, type Review } from '../core/review.ts';
import { snapshot } from '../core/history.ts';
import { readWikiPages, writeIndex } from '../core/wiki.ts';
import { citations } from '../core/page.ts';
import { createCli } from '../core/agent/index.ts';
import { validateChangeSet } from '../core/agent/gemini.ts';
import { DEFAULT_ROUTING, MCP_VERIFIED, route, type TaskKind } from '../core/agent/router.ts';
import { forgetSource, hashContent, markProposed, planWork, readManifest, recordSource, writeManifest, type Manifest, type SourceState, type WorkPlan } from '../core/cache.ts';
import { DEFAULT_MONTHLY_USD, EMPTY_LOG, add as addSpend, status as spendStatus, type Limits, type SpendLog, type Status } from '../core/spend.ts';
import { read as readSpend, write as writeSpend } from '../core/spend-file.ts';
import type { ProviderId } from '../core/agent/types.ts';
import { CHANGESET_SCHEMA } from '../core/agent/schema.ts';
import { DEFAULT_CLASSIFICATION, SOURCE_KIND_BY_EXT, type Classification } from '../core/types.ts';
import type { InboxItem } from './ipc.ts';

/** 받은 편지함 폴더. vault.ts 의 VAULT_DIRS 와 같은 이름이어야 한다 */
const INBOX_DIR = '00_INBOX';

/** 전체 보류한 변경안. `.sb/` 아래라 동기화도 Obsidian 도 안 본다 */
const HELD_REVIEW_PATH = '.sb/held-review.json';

interface HeldReview {
  at: string;
  approved: string[];
  changeSet: ChangeSet;
}
import { conventionFile, promptFor, type WikiRef } from '../core/agent/ingest.ts';
import { ALLOWED_TOOLS, mcpConfig, type McpLaunch } from '../core/mcp/config.ts';
import { ANSWER_SCHEMA, parseAnswer, questionPrompt, toChangeSet, type Answer } from '../core/query.ts';
import { DEFAULT_LOCAL, Ollama, type LocalConfig, type LocalStatus } from '../core/local/ollama.ts';
import { TOP_K, allowedAnchors, chunkWiki, localPrompt, nearest, normalize, queryTerms, rrf, type WikiChunk } from '../core/local/index.ts';
import { chunkHash, readVectors, reusable, writeVectors, type VectorStore } from '../core/local/file.ts';
import { JUDGMENT_SCHEMA, judgmentPrompt, judgmentPromptPush, parseJudgment, summarizeJudgment, type ParsedJudgment } from '../core/lint/judgment.ts';
import { lint, type LintReport } from '../core/lint/index.ts';
import { readRejected, reject, toKeys, unreject, type RejectedPair } from '../core/lint/rejected.ts';
import { toMarp } from '../core/marp.ts';
import { estimateScan, type ScanEstimate } from '../core/tokens.ts';
import { disposeWorkdir, prepareWorkdir } from '../core/agent/workdir.ts';
import type { Extraction, Relation } from '../core/types.ts';
import { hubClient, pendingChanges, resolveConflict, scanLocal, sync, readState, HubError, HubOffline, type HubClient, type SyncConflict } from '../core/sync/index.ts';
import type { TokenStore } from './creds.ts';
import type { AnswerWith, AppSettings, AskResult, HubStatus, IngestResult, JudgmentResult, LocalInfo, ProposeResult, ProviderPick, ResolveResult, SourceSummary, SourceSweep, SyncResult, TaskProviders } from './ipc.ts';

/** 부르는 쪽(main)이 넘기는 것. 취소 손잡이는 Store 가 스스로 만든다 */
export interface RunHooks {
  onOutput?: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
}

/** `#runAgent` 가 AgentJob 에 얹어 주는 것 */
interface AgentHooks {
  onOutput?: ((chunk: string, stream: 'stdout' | 'stderr') => void) | undefined;
  signal: AbortSignal;
}

/**
 * 화면에 띄우는 공급자 목록. **설치 여부는 앱을 켤 때 한 번 본다** —
 * `detect()` 가 프로세스를 띄우므로 화면을 열 때마다 다시 세면 느려진다.
 */
const PROVIDERS: readonly { id: ProviderId; label: string; note: string }[] = [
  { id: 'claude-code', label: 'Claude Code', note: '스키마를 강제한다. 내장 MCP 서버에 붙는다' },
  { id: 'gemini', label: 'Gemini', note: '토큰 상한이 느슨하다. MCP 에는 못 붙는다' },
  { id: 'codex', label: 'Codex', note: '어댑터가 아직 없다 (ROADMAP 19번)' },
];

export class Store {
  #vault: Vault | null = null;
  #db: DatabaseSync | null = null;
  #index: SearchIndex | null = null;
  /** 검토 중인 변경안. 사람이 승인하기 전까지 여기 머문다 — 디스크에 없다 */
  #pending: ChangeSet | null = null;
  #manifest: Manifest = { version: 1, entries: {} };
  /** 지출은 Vault 가 아니라 앱 단위로 쌓는다. 계정 상한은 Vault 마다가 아니다 */
  readonly #spendFile: string | null;
  #spend: SpendLog = EMPTY_LOG;
  /** 상한은 사용자가 넣어야 한다. 아직 설정 화면이 없어 기본값만 있다 (PROVIDER-ROUTING.md §5.2) */
  #limits: Limits = { 'claude-code': DEFAULT_MONTHLY_USD };
  /** detect() 는 프로세스를 띄운다. 진행 중인 것을 붙들어 한 번만 돈다 */
  #available: Promise<ProviderId[]> | null = null;
  /** 사용자가 설정에서 고정한 공급자. `null` 이면 작업 종류별 라우팅에 맡긴다 */
  #provider: ProviderId | null = null;
  /** 공급자 선택은 Vault 가 아니라 이 PC 의 것이다. Vault 를 바꿔도 따라오지 않는다 */
  readonly #prefsFile: string | null;

  /**
   * [위키에 묻기] 를 무엇으로 답하나. **공급자 목록의 넷째 항목이 아니라 별개의 축이다** —
   * `PROVIDERS` 는 예산을 쓰는 외부 CLI 의 목록이고 라우터가 상한과 MCP 로 고르는데,
   * 로컬 모델은 둘 다 해당이 없다 (docs/LOCAL-LLM.md §5).
   */
  #answerWith: AnswerWith = 'cli';
  #local: LocalConfig = { ...DEFAULT_LOCAL };
  /** 테스트가 가짜 Ollama 를 물릴 자리. 실행 중에는 전역 fetch 다 */
  readonly #localFetch: typeof globalThis.fetch;

  /** MCP 서버를 어떻게 띄울지. 개발과 패키징본이 달라 main 이 정한다 */
  readonly #mcpLaunch: ((vaultRoot: string) => McpLaunch) | null;

  /** 허브 토큰 보관소. 없으면 허브에 붙지 못한다 */
  readonly #tokens: TokenStore | null;
  /** 테스트가 가짜 허브를 물릴 자리. 실행 중에는 전역 fetch 다 */
  readonly #hubFetch: typeof globalThis.fetch;
  /** 병합 대기 중인 충돌. 변경안과 같이 **디스크에 없다** — 사람이 고를 때까지 메모리에만 있다 */
  #conflicts: SyncConflict[] = [];
  /** CLI 가 도는 동안만 산다. 취소 버튼이 이걸 끊는다 */
  #running: AbortController | null = null;
  /** 방금 끝난 호출이 취소된 것인가. 실패와 취소는 화면에서 다르게 읽힌다 */
  #cancelled = false;

  constructor(
    opts: {
      spendFile?: string;
      prefsFile?: string;
      mcpLaunch?: (vaultRoot: string) => McpLaunch;
      tokens?: TokenStore;
      hubFetch?: typeof globalThis.fetch;
      localFetch?: typeof globalThis.fetch;
    } = {},
  ) {
    this.#spendFile = opts.spendFile ?? null;
    this.#prefsFile = opts.prefsFile ?? null;
    this.#mcpLaunch = opts.mcpLaunch ?? null;
    this.#tokens = opts.tokens ?? null;
    this.#hubFetch = opts.hubFetch ?? globalThis.fetch;
    this.#localFetch = opts.localFetch ?? globalThis.fetch;
  }

  get vault(): Vault | null {
    return this.#vault;
  }

  async open(root: string, create?: { id: string; title: string }): Promise<Vault> {
    this.close();
    const v = create ? await createVault(root, { ...create, hub: null }) : await openVault(root);
    this.#vault = v;
    // 색인은 재생성 가능한 캐시다. 손상되면 지우고 다시 만들면 된다.
    this.#db = new DatabaseSync(safeJoin(v.root, '.sb/catalog.sqlite'));
    this.#index = new SearchIndex(this.#db as unknown as Db);
    await this.#reindexFromDisk();
    this.#manifest = await readManifest(v);
    this.#conflicts = [];
    if (this.#spendFile) this.#spend = await readSpend(this.#spendFile);
    return v;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#index = null;
    this.#vault = null;
    this.#pending = null;
    this.#conflicts = [];
  }

  /**
   * 파일 여러 개를 인제스트한다. 한 건이 실패해도 나머지는 계속한다.
   *
   * `classification` 은 넣는 사람이 고른다. 고르지 않으면 `internal` 이다 —
   * 공개를 기본으로 두면 빠뜨린 것이 곧 유출이다.
   */
  async ingest(files: readonly string[], classification: Classification = DEFAULT_CLASSIFICATION): Promise<IngestResult> {
    const v = this.#require();
    const res: IngestResult = { ok: [], failed: [], warnings: [], relations: 0 };
    const mails: MailMeta[] = [];

    for (const file of files) {
      const filename = path.basename(file);
      try {
        const dest = await importSource(v, file);
        const ext = { ...(await extractFile(dest)), classification };
        await this.#persist(ext);
        if (ext.kind === 'eml' || ext.kind === 'msg') {
          mails.push((await extractEmail(dest, ext.sourceId)).meta);
        }
        this.#index!.indexSource(ext.sourceId, ext.chunks);
        // 내용 해시로 기억한다. 이름이 바뀌어도 같은 문서로 본다 (PLAN.md §9.1)
        this.#manifest = recordSource(this.#manifest, {
          sourceId: ext.sourceId,
          filename,
          contentHash: hashContent(await fs.readFile(dest)),
        });
        res.ok.push(filename);
        res.relations += ext.relations.length;
        for (const w of ext.warnings) res.warnings.push({ filename, warning: w });
        await appendLog(v, 'ingest', filename);
      } catch (e) {
        res.failed.push({ filename, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    // manifest 는 성공했을 때만 쓴다 (PLAN.md §9.1)
    await writeManifest(v, this.#manifest);

    // 스레드 관계는 여러 통을 모아야 나온다. 기존에 넣어 둔 메일까지 함께 본다.
    if (mails.length) {
      const all = [...(await this.#loadMailMetas()), ...mails];
      const seen = new Map(all.map((m) => [m.messageId, m]));
      const rels = buildThreads([...seen.values()]);
      await this.#writeRelations('__threads__', rels);
      res.relations += rels.length;
    }
    return res;
  }

  async listSources(): Promise<SourceSummary[]> {
    const v = this.#require();
    const dir = safeJoin(v.root, EXTRACTED_DIR);
    // 폴더를 한 번 읽고 이름으로 맞춘다. 원본마다 stat 을 걸면 파일 수만큼 호출이 늘어난다
    let present: Set<string>;
    try {
      present = new Set(await fs.readdir(safeJoin(v.root, SOURCES_DIR)));
    } catch {
      present = new Set();
    }
    const out: SourceSummary[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.json') || name.startsWith('__')) continue;
      const e = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Extraction;
      out.push({
        sourceId: e.sourceId,
        filename: e.filename,
        kind: e.kind,
        chunks: e.chunks.length,
        classification: e.classification ?? DEFAULT_CLASSIFICATION,
        missing: !present.has(e.filename),
      });
    }
    return out.sort((a, b) => a.filename.localeCompare(b.filename, 'ko'));
  }

  /**
   * `01_SOURCES/` 에서 사라진 원본을 정리한다. 새로 고침 버튼이 부른다.
   *
   * **위키가 인용 중인 원본은 안 지운다.** 추출물이 관문 5(앵커 실재 검사)의 근거라
   * 그것을 지우면 그 원본을 인용한 페이지가 전부 검사에서 막힌다. 원문 파일이 없어진 것과
   * "그런 주장은 없었다" 는 다른 사건이다 — 앞의 것은 표시로 알리고, 근거는 남긴다.
   *
   * **원본 파일을 앱이 지우지 않는다.** 사람이 지운 것을 따라갈 뿐이다.
   */
  async sweepSources(): Promise<SourceSweep> {
    const v = this.#require();
    const cited = new Set(await this.citedSources());
    const res: SourceSweep = { removed: [], kept: [] };
    for (const s of await this.listSources()) {
      if (!s.missing) continue;
      if (cited.has(s.sourceId)) {
        res.kept.push(s.filename);
        continue;
      }
      await fs.rm(safeJoin(v.root, EXTRACTED_DIR, `${s.sourceId}.json`), { force: true });
      this.#index!.removeSource(s.sourceId);
      this.#manifest = forgetSource(this.#manifest, s.sourceId);
      res.removed.push(s.filename);
      await appendLog(v, 'sweep', s.filename);
    }
    if (res.removed.length) await writeManifest(v, this.#manifest);
    return res;
  }

  /**
   * 받은 편지함. `00_INBOX/` 에 놓인 파일을 훑는다.
   *
   * **파일을 옮기지도 지우지도 않는다.** 사람이 넣은 것을 앱이 치우면 어디로 갔는지
   * 찾을 수 없다. 이미 넣은 것인지는 내용 해시로 판정하므로 이름을 바꿔도 같은 것으로 본다.
   */
  async inbox(): Promise<InboxItem[]> {
    const v = this.#require();
    const dir = safeJoin(v.root, INBOX_DIR);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return [];
    }
    const out: InboxItem[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b, 'ko'))) {
      if (name.startsWith('.')) continue;
      const full = path.join(dir, name);
      let bytes: Buffer;
      try {
        const st = await fs.stat(full);
        if (!st.isFile()) continue;
        bytes = await fs.readFile(full);
      } catch {
        continue;
      }
      const ext = path.extname(name).toLowerCase();
      out.push({
        filename: name,
        bytes: bytes.length,
        supported: ext in SOURCE_KIND_BY_EXT,
        ingested: this.#manifest.entries[hashContent(bytes)] !== undefined,
      });
    }
    return out;
  }

  /** 받은 편지함에서 아직 안 넣은 것만 인제스트한다. 원본은 그 자리에 그대로 둔다. */
  async ingestInbox(classification: Classification = DEFAULT_CLASSIFICATION): Promise<IngestResult> {
    const v = this.#require();
    const fresh = (await this.inbox()).filter((i) => i.supported && !i.ingested);
    return this.ingest(
      fresh.map((i) => path.join(safeJoin(v.root, INBOX_DIR), i.filename)),
      classification,
    );
  }

  search(query: string) {
    return this.#index?.search(query) ?? [];
  }

  async readSource(sourceId: string): Promise<Extraction | null> {
    const v = this.#require();
    try {
      return JSON.parse(await fs.readFile(safeJoin(v.root, EXTRACTED_DIR, `${sourceId}.json`), 'utf8')) as Extraction;
    } catch {
      return null;
    }
  }

  /* ---------- 관문 8 — 변경안 제안과 승인 ---------- */

  /**
   * 원본 하나로 ChangeSet 을 받아 검토 재료를 만든다. **디스크는 건드리지 않는다.**
   * 실패해도 던지지 않는다 — 사유를 화면에 그대로 띄우는 편이 낫다.
   */
  /**
   * 위키가 실제로 인용하고 있는 원본 id. 좌측 목록의 반영 표시가 이걸 본다.
   *
   * **manifest 의 `proposedAt` 을 안 쓴다.** 그것은 "변경안을 만들었다" 이지
   * "사람이 승인해서 위키에 들어갔다" 가 아니다. 승인 안 한 원본을 반영됨으로
   * 그리면 표시가 거짓말이 된다. 페이지를 지우면 이 값도 저절로 빠진다.
   *
   * 위키 전체를 읽는다. `listSources` 안에 넣지 않고 따로 둔 이유가 그것이다 —
   * 원본 목록만 필요한 자리(plan · 앵커 수집)까지 이 비용을 물면 안 된다.
   */
  async citedSources(): Promise<string[]> {
    const v = this.#require();
    const out = new Set<string>();
    for (const e of (await readWikiPages(v)).entries) {
      for (const c of citations(e.page.body)) out.add(c.sourceId);
      // 앵커가 front-matter 의 claims 에만 있는 페이지도 있다 (wiki.ts 의 line 과 같은 규칙)
      for (const c of e.page.front.claims) if (c.source?.includes('#')) out.add(c.source.split('#')[0]!);
    }
    return [...out];
  }

  /** 무엇을 CLI 로 보내야 하는가. 이름만 바뀐 것과 이미 만든 것은 빠진다 (PLAN.md §9.1) */
  async plan(): Promise<WorkPlan> {
    const v = this.#require();
    const states: SourceState[] = [];
    for (const s of await this.listSources()) {
      try {
        states.push({
          sourceId: s.sourceId,
          filename: s.filename,
          contentHash: hashContent(await fs.readFile(safeJoin(v.root, SOURCES_DIR, s.filename))),
        });
      } catch {
        // 원본이 지워졌으면 건너뛴다
      }
    }
    return planWork(this.#manifest, states);
  }

  /**
   * 설치·인증된 공급자. detect() 는 프로세스를 띄우므로 한 번만 본다.
   *
   * **결과가 아니라 진행 중인 약속을 붙든다.** 결과만 캐시하면 앱이 켜질 때 돌린 것이
   * 끝나기 전에 설정 화면이 물어봤을 때 탐지가 처음부터 다시 돈다 — 실측 약 5초 동안
   * 화면이 멈춘 것처럼 보였다.
   */
  available(): Promise<ProviderId[]> {
    this.#available ??= (async () => {
      const found: ProviderId[] = [];
      for (const id of ['claude-code', 'gemini'] as const) {
        try {
          if ((await createCli(id).detect()).found) found.push(id);
        } catch {
          // 어댑터가 없는 공급자는 건너뛴다
        }
      }
      return found;
    })();
    return this.#available;
  }

  /* ---------- 설정 (ipc.ts AppSettings) ---------- */

  /**
   * 설정 화면 한 벌. **Vault 경로는 여기서만 나간다** — 오류 기록에는 안 넣는다
   * (main.ts `environment`). 사람이 직접 보는 화면과 통째로 복사되는 기록은 다르다.
   */
  async settings(version: string): Promise<AppSettings> {
    const installed = await this.available();
    return {
      version,
      vaultRoot: this.#vault?.root ?? null,
      vaultTitle: this.#vault?.config.title ?? null,
      co: this.#vault ? this.#vault.config.hub !== null : null,
      provider: this.#provider,
      providers: PROVIDERS.map((p) => ({ ...p, installed: installed.includes(p.id) })),
      answerWith: this.#answerWith,
      local: { ...this.#local },
    };
  }

  /**
   * 쓸 CLI 를 고정한다. `null` 이면 작업 종류별 라우팅으로 돌아간다.
   *
   * 고정한 공급자가 그 작업의 조건을 못 맞추면 **조용히 다른 데로 넘기지 않고 거절한다**
   * (router.ts). 왜 품질이 달라졌는지 모르는 것보다 안 도는 편이 낫다.
   */
  async setProvider(id: ProviderId | null): Promise<void> {
    this.#provider = id;
    await this.#writePrefs();
  }

  /** 질의를 외부 CLI 로 받을지 로컬 모델로 받을지. 다른 작업은 안 바뀐다 */
  async setAnswerWith(mode: AnswerWith): Promise<void> {
    this.#answerWith = mode === 'local' ? 'local' : 'cli';
    await this.#writePrefs();
  }

  /** Ollama 주소와 모델 이름. 빈 값은 기본값으로 되돌린다 */
  async setLocalConfig(cfg: Partial<LocalConfig>): Promise<void> {
    const pick = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
    this.#local = {
      host: pick(cfg.host, DEFAULT_LOCAL.host),
      chatModel: pick(cfg.chatModel, DEFAULT_LOCAL.chatModel),
      embedModel: pick(cfg.embedModel, DEFAULT_LOCAL.embedModel),
    };
    await this.#writePrefs();
  }

  async #writePrefs(): Promise<void> {
    if (!this.#prefsFile) return;
    const body = { provider: this.#provider, answerWith: this.#answerWith, local: this.#local };
    await fs.writeFile(this.#prefsFile, JSON.stringify(body, null, 2), 'utf8');
  }

  /** 저장해 둔 선택을 읽는다. 파일이 없거나 깨졌으면 기본값으로 둔다. */
  async loadPrefs(): Promise<void> {
    if (!this.#prefsFile) return;
    try {
      const raw = JSON.parse(await fs.readFile(this.#prefsFile, 'utf8')) as {
        provider?: unknown;
        answerWith?: unknown;
        local?: Partial<LocalConfig>;
      };
      this.#provider = PROVIDERS.some((p) => p.id === raw.provider) ? (raw.provider as ProviderId) : null;
      this.#answerWith = raw.answerWith === 'local' ? 'local' : 'cli';
      const l = raw.local ?? {};
      const pick = (v: unknown, d: string) => (typeof v === 'string' && v.trim() ? v.trim() : d);
      this.#local = {
        host: pick(l.host, DEFAULT_LOCAL.host),
        chatModel: pick(l.chatModel, DEFAULT_LOCAL.chatModel),
        embedModel: pick(l.embedModel, DEFAULT_LOCAL.embedModel),
      };
    } catch {
      this.#provider = null;
      this.#answerWith = 'cli';
      this.#local = { ...DEFAULT_LOCAL };
    }
  }

  /** 고정 공급자를 라우터가 읽는 형태로. 안 골랐으면 빈 것이라 정책이 그대로 돈다 */
  #overrides(): Partial<Record<TaskKind, ProviderId>> {
    const o: Partial<Record<TaskKind, ProviderId>> = {};
    if (!this.#provider) return o;
    for (const k of Object.keys(DEFAULT_ROUTING) as TaskKind[]) o[k] = this.#provider;
    return o;
  }

  /* ---------- 나의 기준 맥락 (core/context.ts) ---------- */

  /** 파일이 없으면 빈 것을 준다. 없는 것은 오류가 아니다 */
  async coreContext(): Promise<CoreContext> {
    const v = this.#require();
    try {
      return parseCoreContext(await fs.readFile(safeJoin(v.root, CORE_CONTEXT_PATH), 'utf8'));
    } catch {
      return { ...EMPTY_CORE_CONTEXT };
    }
  }

  async setCoreContext(ctx: CoreContext): Promise<void> {
    const v = this.#require();
    await fs.writeFile(safeJoin(v.root, CORE_CONTEXT_PATH), serializeCoreContext(ctx), 'utf8');
  }

  /**
   * CLI 한 번을 감싼다. 도는 동안만 취소 손잡이가 산다.
   *
   * **동시에 하나만 돈다.** 두 개를 띄우면 취소 버튼이 어느 것을 끊는지 알 수 없고,
   * 지출도 사람이 예상한 것의 두 배가 된다.
   */
  async #runAgent<T>(hooks: RunHooks | undefined, fn: (h: AgentHooks) => Promise<T>): Promise<T> {
    if (this.#running) throw new Error('이미 도는 호출이 있습니다');
    const ac = new AbortController();
    this.#running = ac;
    this.#cancelled = false;
    try {
      return await fn({ onOutput: hooks?.onOutput, signal: ac.signal });
    } finally {
      if (this.#running === ac) this.#running = null;
    }
  }

  /** 도는 것을 끊는다. 없으면 false — 화면이 눌러도 되는지 미리 안 물어도 된다 */
  cancelAgent(): boolean {
    if (!this.#running) return false;
    this.#cancelled = true;
    this.#running.abort();
    return true;
  }

  /**
   * 화면에 미리 보여줄 공급자. **부르기 전에 알려 준다** — 눌러 본 뒤에야
   * "내장 MCP 서버에 붙을 수 있는 공급자여야 합니다" 를 보는 것은 늦다.
   */
  async taskProviders(): Promise<TaskProviders> {
    const now = new Date().toISOString();
    const ctx = {
      available: await this.available(),
      overLimit: this.spendStatus(now).filter((s) => s.level === 'over').map((s) => s.provider),
      overrides: this.#overrides(),
    };
    const pick = (k: TaskKind): ProviderPick => {
      const r = route(k, ctx);
      return r.ok ? { ok: true, provider: r.provider, why: r.why } : { ok: false, reason: r.reason };
    };
    return { query: pick('query'), ingest: pick('ingest.single'), answerWith: this.#answerWith };
  }

  /** 공급자별 이번 달 소비와 남은 문서 수. 화면에 띄운다. */
  spendStatus(now: string = new Date().toISOString()): Status[] {
    return (['claude-code', 'gemini'] as const).map((p) => spendStatus(this.#spend, this.#limits, p, now));
  }

  async propose(
    sourceId: string,
    hooks?: RunHooks,
    provider?: ProviderId,
    kind: TaskKind = 'ingest.single',
  ): Promise<ProposeResult> {
    const v = this.#require();
    const ext = await this.readSource(sourceId);
    if (!ext) return { ok: false, error: `원본이 없습니다: ${sourceId}` };

    const now = new Date().toISOString();
    const overLimit = this.spendStatus(now).filter((s) => s.level === 'over').map((s) => s.provider);
    const picked = provider
      ? { ok: true as const, provider, fallback: false, why: '호출자 지정' }
      : route(kind, { available: await this.available(), overLimit, overrides: this.#overrides() });
    if (!picked.ok) return { ok: false, error: picked.reason };

    const cli = createCli(picked.provider);
    // 규약 파일은 배치 내내 같은 바이트여야 캐시가 산다 (M2-PLAN.md §2.1).
    // 이름은 CLI 마다 다르다 (PLAN.md §7.3).
    const agentsMd = await fs.readFile(safeJoin(v.root, `${TEMPLATES_DIR}/AGENTS.md`), 'utf8');
    const wd = await prepareWorkdir({ [cli.conventionFile]: conventionFile(agentsMd, coreContextBlock(await this.coreContext())) });
    try {
      const r = await this.#runAgent(hooks, async (h) =>
        cli.run(
          { workdir: wd.root, prompt: promptFor(ext, await this.#wikiRefs()), validate: validateChangeSet, ...h },
          CHANGESET_SCHEMA,
        ),
      );
      // 실패해도 돈은 나갔다. 성공만 세면 계량기가 실제보다 낮게 나온다.
      this.#spend = addSpend(this.#spend, picked.provider, r.usage, now);
      if (this.#spendFile) await writeSpend(this.#spendFile, this.#spend);
      if (!r.ok) return { ok: false, error: this.#cancelled ? '취소했습니다' : (r.error ?? '변경안을 받지 못했습니다') };

      const hash = hashContent(await fs.readFile(safeJoin(v.root, SOURCES_DIR, ext.filename)));
      this.#manifest = markProposed(this.#manifest, hash, picked.provider, now);
      await writeManifest(v, this.#manifest);

      this.#pending = r.data as ChangeSet;
      return { ok: true, review: await buildReview(v, this.#pending, await this.#anchors()), costUsd: r.usage.costUsd };
    } finally {
      await disposeWorkdir(wd);
    }
  }

  /** 사람이 승인한 경로만 적용한다. 스냅샷을 먼저 남기고 index.md 를 다시 조립한다. */
  async applyReview(approved: readonly string[]): Promise<ApplyResult> {
    const v = this.#require();
    if (!this.#pending) throw new Error('검토 중인 변경안이 없습니다');
    const cs = selectOps(this.#pending, approved);
    const res = await applyChangeSet(v, cs, await this.#anchors(), async (paths) => {
      await snapshot(v, paths, cs.summary);
    });
    if (res.applied.length > 0) {
      this.#pending = null;
      // 보류해 둔 사본이 남아 있으면 다음에 또 뜬다. 적용했으면 그것도 끝난 것이다.
      await fs.rm(safeJoin(v.root, HELD_REVIEW_PATH), { force: true });
      await writeIndex(v, (await readWikiPages(v)).entries);
      await appendLog(v, 'ingest', `변경안 적용 ${res.applied.length}건 — ${cs.summary}`);
    }
    return res;
  }

  /** 버린다. **보류해 둔 것도 같이 지운다** — 버렸는데 다음에 또 뜨면 버린 것이 아니다 */
  async discardReview(): Promise<void> {
    this.#pending = null;
    if (this.#vault) await fs.rm(safeJoin(this.#vault.root, HELD_REVIEW_PATH), { force: true });
  }

  /**
   * 전체 보류 — 지금 상태를 그대로 두고 화면을 벗어난다.
   *
   * **변경안이 디스크에 닿는 유일한 자리다.** 그래도 위키는 아니고 `.sb/` 아래이며,
   * 여기 있다는 것만으로는 아무것도 적용되지 않는다 — 다시 열어 승인해야 관문을
   * 거쳐 반영된다. 메모리에만 두면 실수로 창을 닫은 사람이 CLI 호출 값을 통째로
   * 잃는다. 그 손실이 파일 하나보다 크다.
   */
  async holdReview(approved: readonly string[]): Promise<void> {
    const v = this.#require();
    if (!this.#pending) throw new Error('검토 중인 변경안이 없습니다');
    const held: HeldReview = { at: new Date().toISOString(), approved: [...approved], changeSet: this.#pending };
    await fs.writeFile(safeJoin(v.root, HELD_REVIEW_PATH), JSON.stringify(held, null, 2), 'utf8');
    this.#pending = null;
  }

  /** 보류해 둔 것이 있는가. 레일의 배지가 쓴다 — 여기서 관문을 다시 돌리지 않는다 */
  async heldReviewInfo(): Promise<{ at: string; summary: string; ops: number } | null> {
    const held = await this.#readHeld();
    return held ? { at: held.at, summary: held.changeSet.summary, ops: held.changeSet.ops.length } : null;
  }

  /**
   * 보류한 것을 다시 연다. **관문을 처음부터 다시 돌린다** — 보류하는 동안 사람이
   * Obsidian 으로 페이지를 고쳤을 수 있고, 그러면 충돌과 위반이 달라진다.
   */
  async resumeReview(): Promise<{ review: Review; approved: string[] } | null> {
    const v = this.#require();
    const held = await this.#readHeld();
    if (!held) return null;
    this.#pending = held.changeSet;
    return { review: await buildReview(v, held.changeSet, await this.#anchors()), approved: held.approved };
  }

  /** 깨진 파일은 없는 것으로 본다. 여기서 던지면 Vault 를 못 연다 */
  async #readHeld(): Promise<HeldReview | null> {
    if (!this.#vault) return null;
    try {
      const raw: unknown = JSON.parse(await fs.readFile(safeJoin(this.#vault.root, HELD_REVIEW_PATH), 'utf8'));
      const h = raw as HeldReview;
      if (!h?.changeSet?.ops || !Array.isArray(h.changeSet.ops)) return null;
      return { at: h.at ?? '', approved: Array.isArray(h.approved) ? h.approved : [], changeSet: h.changeSet };
    } catch {
      return null;
    }
  }

  /**
   * 검토 화면에서 사람이 고친 내용을 반영한다. **관문을 다시 돌린다** —
   * 앞머리를 깨거나 없는 앵커를 넣으면 승인이 막힌다.
   */
  /**
   * 없는 앵커 인용을 지우고 관문을 다시 돌린다. 사람이 손으로 하던 편집을 대신한다.
   *
   * 관문을 느슨하게 하지 않는다 — 지운 결과가 다시 일곱 개를 전부 통과해야 한다.
   */
  async repairAnchors(): Promise<{ review: Review; removed: number }> {
    const v = this.#require();
    if (!this.#pending) throw new Error('검토 중인 변경안이 없습니다');
    const anchors = await this.#anchors();
    const r = repairAnchors(this.#pending, anchors);
    this.#pending = r.changeSet;
    return { review: await buildReview(v, this.#pending, anchors), removed: r.removed };
  }

  async editOp(path: string, content: string): Promise<Review> {
    const v = this.#require();
    if (!this.#pending) throw new Error('검토 중인 변경안이 없습니다');
    this.#pending = editOp(this.#pending, path, content);
    return buildReview(v, this.#pending, await this.#anchors());
  }

  /* ---------- 질의 (PLAN.md §4 Query) ---------- */

  /**
   * 위키에 묻는다. 후보 페이지를 밀어 넣지 않고 **에이전트가 MCP 로 당겨 간다**
   * (PLAN.md §7.2 안 B). 디스크는 안 건드린다 — 보관은 따로 승인받는다.
   */
  async ask(question: string, hooks?: RunHooks, provider?: ProviderId): Promise<AskResult> {
    const v = this.#require();
    // 로컬은 갈래가 통째로 다르다. MCP 를 안 띄우고 앱이 찾아서 넣는다
    if (this.#answerWith === 'local' && !provider) return this.askLocal(question, hooks);
    if (!this.#mcpLaunch) return { ok: false, error: '읽기 경로가 설정되지 않았습니다' };

    const now = new Date().toISOString();
    const overLimit = this.spendStatus(now).filter((s) => s.level === 'over').map((s) => s.provider);
    const picked = provider
      ? { ok: true as const, provider, fallback: false, why: '호출자 지정' }
      : route('query', { available: await this.available(), overLimit, overrides: this.#overrides() });
    if (!picked.ok) return { ok: false, error: picked.reason };

    const cli = createCli(picked.provider);
    // 설정을 놓는 자리가 CLI 마다 다르다. Gemini 는 cwd 의 `.gemini/settings.json` 만 읽는다.
    const cfg = JSON.stringify(mcpConfig(this.#mcpLaunch(v.root), picked.provider === 'gemini'), null, 1);
    const wd = await prepareWorkdir({ [cli.mcpConfigFile]: cfg });
    try {
      const r = await this.#runAgent(hooks, async (h) =>
        cli.run(
          {
            workdir: wd.root,
            prompt: questionPrompt(question, coreContextBlock(await this.coreContext())),
            mcp: { configPath: safeJoin(wd.root, cli.mcpConfigFile), allowedTools: ALLOWED_TOOLS },
            validate: (d) => parseAnswer(d).reason,
            ...h,
          },
          ANSWER_SCHEMA,
        ),
      );
      this.#spend = addSpend(this.#spend, picked.provider, r.usage, now);
      if (this.#spendFile) await writeSpend(this.#spendFile, this.#spend);
      if (!r.ok) return { ok: false, error: this.#cancelled ? '취소했습니다' : (r.error ?? '답변을 받지 못했습니다') };

      const { answer, reason } = parseAnswer(r.data);
      if (!answer) return { ok: false, error: reason ?? '답변 형식이 맞지 않습니다' };
      await appendLog(v, 'query', question);
      return { ok: true, question, answer, costUsd: r.usage.costUsd };
    } finally {
      await disposeWorkdir(wd);
    }
  }

  /* ---------- 로컬 모델 질의 (docs/LOCAL-LLM.md) ---------- */

  /**
   * 로컬 모델이 지금 쓸 만한가. **네트워크를 탄다** — 설정을 열 때와 로컬로 답하기 직전에만 부른다.
   * 임베딩이 몇 개 만들어져 있는지도 같이 준다. 없어도 답은 나온다(BM25 만 쓴다).
   */
  async localInfo(): Promise<LocalInfo> {
    const status = await new Ollama(this.#local, this.#localFetch).status();
    // 설정 화면은 Vault 를 안 열고도 열린다. 그때도 Ollama 상태는 보여 준다
    if (!this.#vault) return { status, chunks: 0, vectors: 0 };
    const v = this.#vault;
    const chunks = chunkWiki((await readWikiPages(v)).entries).length;
    const store = await readVectors(v);
    const vectors = store && store.model === this.#local.embedModel ? store.entries.size : 0;
    return { status, chunks, vectors };
  }

  /**
   * 위키 청크의 임베딩을 만든다. **본문이 그대로인 것은 다시 안 만든다** —
   * 사내 실측에서 청크당 시간이 커서 (ROADMAP §20) 전부 다시 만들면 못 쓴다.
   *
   * 중간에 끊어도 지금까지 만든 것은 저장한다. 다음에 이어서 만든다.
   */
  async buildVectors(hooks?: RunHooks): Promise<{ ok: true; made: number; total: number } | { ok: false; error: string }> {
    const v = this.#require();
    const oll = new Ollama(this.#local, this.#localFetch);
    const st = await oll.status();
    if (!st.ok || !st.embed) return { ok: false, error: st.error ?? '임베딩 모델이 없습니다' };

    const chunks = chunkWiki((await readWikiPages(v)).entries);
    if (chunks.length === 0) return { ok: false, error: '위키에 페이지가 없습니다' };

    const prev = reusable(await readVectors(v), this.#local.embedModel);
    const next: VectorStore = { model: this.#local.embedModel, dim: prev.dim, entries: new Map() };
    const todo: WikiChunk[] = [];
    for (const c of chunks) {
      const hash = chunkHash(c.text);
      const old = prev.entries.get(c.key);
      if (old && old.hash === hash) next.entries.set(c.key, old);
      else todo.push(c);
    }

    return this.#runAgent(hooks, async (h) => {
      const say = (line: string) => h.onOutput?.(`${line}\n`, 'stdout');
      say(`청크 ${chunks.length}개 중 ${todo.length}개를 새로 만듭니다`);
      let made = 0;
      // 한 번에 여덟 개씩. 배치가 크면 끊었을 때 버리는 것이 많아진다
      for (let i = 0; i < todo.length; i += 8) {
        if (h.signal.aborted) break;
        const batch = todo.slice(i, i + 8);
        const r = await oll.embed(st.embed!, batch.map((c) => c.text), h.signal);
        if (!r.ok) {
          if (next.entries.size) await this.#saveVectors(v, next);
          return { ok: false as const, error: r.error };
        }
        for (const [j, c] of batch.entries()) {
          const vec = normalize(r.vectors[j]!);
          next.dim ||= vec.length;
          if (vec.length !== next.dim) continue;
          next.entries.set(c.key, { hash: chunkHash(c.text), vec });
          made += 1;
        }
        say(`${Math.min(i + 8, todo.length)} / ${todo.length}`);
      }
      await this.#saveVectors(v, next);
      return { ok: true as const, made, total: next.entries.size };
    });
  }

  async #saveVectors(v: Vault, store: VectorStore): Promise<void> {
    if (store.dim === 0) return;
    // 차원이 다른 것이 섞이면 파일 길이가 안 맞아 다음에 통째로 못 읽는다
    for (const [k, e] of store.entries) if (e.vec.length !== store.dim) store.entries.delete(k);
    await writeVectors(v, store);
  }

  /**
   * 앱이 찾아서 넣고 로컬 모델을 한 번 부른다 (docs/LOCAL-LLM.md §2.2).
   *
   * MCP 경로와 달리 **무엇을 줬는지 앱이 안다.** 그래서 관문 5 를 Vault 전체가 아니라
   * 준 조각만 놓고 판정한다 — 준 것에 없는 앵커는 지어낸 것이 확실하다.
   */
  async askLocal(question: string, hooks?: RunHooks): Promise<AskResult> {
    const v = this.#require();
    const oll = new Ollama(this.#local, this.#localFetch);
    const st = await oll.status();
    if (!st.ok || !st.chat) return { ok: false, error: st.error ?? '로컬 모델을 못 씁니다' };

    const chunks = chunkWiki((await readWikiPages(v)).entries);
    if (chunks.length === 0) return { ok: false, error: '위키에 페이지가 없습니다' };

    return this.#runAgent(hooks, async (h) => {
      const say = (line: string) => h.onOutput?.(`${line}\n`, 'stdout');
      const picked = await this.#retrieve(question, chunks, oll, st.embed, h.signal, say);
      if (picked.length === 0) return { ok: false as const, error: '질문에 걸리는 위키 조각이 없습니다' };

      const prompt = localPrompt(question, picked, coreContextBlock(await this.coreContext()));
      say(`조각 ${picked.length}개를 넣고 ${st.chat} 를 부릅니다`);
      const r = await oll.chat(st.chat!, prompt, ANSWER_SCHEMA, h.signal);
      if (!r.ok) return { ok: false as const, error: this.#cancelled ? '취소했습니다' : r.error };

      const { answer, reason } = parseAnswer(r.data);
      if (!answer) return { ok: false as const, error: reason ?? '답변 형식이 맞지 않습니다' };

      const allowed = allowedAnchors(picked);
      const invented = answer.claims.filter((c) => !allowed.has(c.source)).map((c) => c.source);
      if (invented.length) {
        return { ok: false as const, error: `준 조각에 없는 앵커를 인용했습니다: ${[...new Set(invented)].join(' · ')}` };
      }
      await appendLog(v, 'query', question);
      // 돈이 안 든다. 지출 기록에는 안 쌓는다 — 공급자별 상한과 섞이면 둘 다 못 읽는다
      return { ok: true as const, question, answer, costUsd: 0 };
    });
  }

  /**
   * BM25 와 임베딩을 각각 뽑아 RRF 로 합친다.
   *
   * BM25 는 낱말마다 목록이 하나씩 나오므로 **먼저 그것끼리 합치고** 그다음 임베딩과
   * 합친다. 한 번에 합치면 낱말 수만큼 BM25 쪽이 무거워진다.
   *
   * 임베딩이 없으면 BM25 만으로 간다. 색인이 없다고 답을 못 내는 것보다 낫다.
   */
  async #retrieve(
    question: string,
    chunks: readonly WikiChunk[],
    oll: Ollama,
    embedModel: string | null,
    signal: AbortSignal,
    say: (line: string) => void,
  ): Promise<WikiChunk[]> {
    const v = this.#require();
    const byKey = new Map(chunks.map((c) => [c.key, c]));

    // 위키 색인은 질의마다 메모리에 새로 만든다. 승인 한 번에 위키가 바뀌므로
    // 파일로 남기면 언제 무효인지를 따로 관리해야 한다 — 만드는 값이 그보다 싸다
    const mem = new DatabaseSync(':memory:');
    let bm: string[];
    try {
      const idx = new SearchIndex(mem as unknown as Db);
      idx.indexSource(
        'wiki',
        chunks.map((c) => ({ anchor: { sourceId: 'wiki', locator: c.key, label: c.title }, text: c.text })),
      );
      const lists = queryTerms(question).map((t) => idx.search(t, 30).map((x) => x.locator));
      bm = rrf(lists).map((x) => x.key);
    } finally {
      mem.close();
    }

    let dense: string[] = [];
    const store = await readVectors(v);
    if (embedModel && store && store.model === embedModel && store.entries.size > 0) {
      const q = await oll.embed(embedModel, [question], signal);
      if (q.ok && q.vectors[0]) {
        const vecs = new Map([...store.entries].map(([k, e]) => [k, e.vec] as const));
        dense = nearest(normalize(q.vectors[0]), vecs, 30).filter((k) => byKey.has(k));
      }
    }
    say(dense.length ? `키워드 ${bm.length}개 · 임베딩 ${dense.length}개를 합칩니다` : `키워드로만 찾습니다 (임베딩 없음)`);

    const fused = dense.length ? rrf([bm, dense]) : rrf([bm]);
    const out: WikiChunk[] = [];
    for (const f of fused) {
      const c = byKey.get(f.key);
      if (c) out.push(c);
      if (out.length >= TOP_K) break;
    }
    return out;
  }

  /* ---------- Lint 계산 검사 7종 (PLAN.md §4) ---------- */

  /**
   * LLM 없이 도는 검사 일곱 가지. 언제 불러도 되고 돈이 안 든다.
   *
   * #9(엔티티 중복 후보)는 **사람이 이미 거부한 쌍을 뺀다.** 한 번 "다른 대상" 이라고
   * 한 것을 매번 다시 물으면 사람이 Lint 를 통째로 무시하게 된다 (ROADMAP.md §14).
   */
  async lintComputed(): Promise<LintReport> {
    const v = this.#require();
    const { entries } = await readWikiPages(v);
    return lint(entries.map((e) => e.page), await this.#anchors(), toKeys(await readRejected(v)));
  }

  /** 중복 후보 하나를 "다른 대상" 으로 기록한다. 거부 하나가 오병합 표본 하나다 */
  async rejectDuplicate(a: string, b: string): Promise<RejectedPair[]> {
    return reject(this.#require(), a, b);
  }

  /** 잘못 누른 것을 무른다. 파일을 손으로 고치게 하면 안 된다 */
  async unrejectDuplicate(a: string, b: string): Promise<RejectedPair[]> {
    return unreject(this.#require(), a, b);
  }

  /** 지금까지 거부한 쌍. 누적 개수가 곧 오병합 건수다 (W5) */
  async rejectedDuplicates(): Promise<RejectedPair[]> {
    return readRejected(this.#require());
  }

  /* ---------- Lint 판단 검사 4종 (PLAN.md §4) ---------- */

  /** 실행 직전에 사람에게 보여줄 예상 비용. 전부 읽는다고 보고 넉넉하게 잡는다. */
  async estimateJudgment(): Promise<ScanEstimate> {
    const v = this.#require();
    const { entries } = await readWikiPages(v);
    return estimateScan(entries.map((e) => e.page.body.length + e.page.front.summary.length));
  }

  /**
   * 계산 검사 7종과 달리 LLM 이 판단한다. **결과는 제안일 뿐 자동으로 고치지 않는다** —
   * ChangeSet 을 만들지 않고 목록만 돌려준다.
   */
  async lintJudgment(provider?: ProviderId): Promise<JudgmentResult> {
    const v = this.#require();
    const now = new Date().toISOString();
    const overLimit = this.spendStatus(now).filter((s) => s.level === 'over').map((s) => s.provider);
    const picked = provider
      ? { ok: true as const, provider, fallback: false, why: '호출자 지정' }
      : route('lint.judgment', { available: await this.available(), overLimit, overrides: this.#overrides() });
    if (!picked.ok) return { ok: false, error: picked.reason };

    const { entries } = await readWikiPages(v);
    if (entries.length === 0) return { ok: false, error: '검사할 페이지가 없습니다' };

    // MCP 에 붙는 공급자는 당겨 가고, 못 붙으면 밀어 넣는다 (PLAN.md §7.2 안 B / 안 A).
    // 전수 스캔은 어차피 다 읽으므로 두 방식의 결과가 같다 — 값만 다르다.
    const pull = MCP_VERIFIED.includes(picked.provider);
    if (pull && !this.#mcpLaunch) return { ok: false, error: '읽기 경로가 설정되지 않았습니다' };

    let prompt: string;
    if (pull) {
      prompt = judgmentPrompt(entries);
    } else {
      const built = judgmentPromptPush(entries);
      if ('error' in built) return { ok: false, error: built.error };
      prompt = built.prompt;
    }

    const cli = createCli(picked.provider);
    const wd = await prepareWorkdir(
      pull ? { [cli.mcpConfigFile]: JSON.stringify(mcpConfig(this.#mcpLaunch!(v.root)), null, 1) } : {},
    );
    try {
      const r = await cli.run(
        {
          workdir: wd.root,
          prompt,
          ...(pull ? { mcp: { configPath: safeJoin(wd.root, cli.mcpConfigFile), allowedTools: ALLOWED_TOOLS } } : {}),
          validate: (d) => parseJudgment(d, new Set(entries.map((e) => e.path))).reason,
        },
        JUDGMENT_SCHEMA,
      );
      this.#spend = addSpend(this.#spend, picked.provider, r.usage, now);
      if (this.#spendFile) await writeSpend(this.#spendFile, this.#spend);
      if (!r.ok) return { ok: false, error: r.error ?? '검사 결과를 받지 못했습니다' };

      const parsed = parseJudgment(r.data, new Set(entries.map((e) => e.path)));
      if (parsed.reason) return { ok: false, error: parsed.reason };
      await appendLog(v, 'lint', summarizeJudgment(parsed));
      return { ok: true, result: parsed, costUsd: r.usage.costUsd };
    } finally {
      await disposeWorkdir(wd);
    }
  }

  /** Marp 덱. 파일로 저장하는 것은 main 이 한다 — core 는 문자열만 만든다. */
  async exportDeck(title: string): Promise<string> {
    const v = this.#require();
    const { entries } = await readWikiPages(v);
    return toMarp(entries, { title, subtitle: new Date().toISOString().slice(0, 10) });
  }

  /** 보관 버튼. 답변을 ChangeSet 으로 바꿔 검토 대기에 올린다. 아직 안 쓴다. */
  async archiveAnswer(question: string, answer: Answer): Promise<Review> {
    const v = this.#require();
    this.#pending = toChangeSet(question, answer, new Date().toISOString());
    return buildReview(v, this.#pending, await this.#anchors());
  }

  /* ---------- 동기화 (HUB.md §5) ---------- */

  /** 허브 연결 상태와 아직 안 올라간 로컬 변경 수. 좌측 레일에 띄운다. */
  async hubStatus(): Promise<HubStatus> {
    const v = this.#require();
    const personal = v.config.id === PERSONAL_ID;
    const base: HubStatus = {
      personal,
      hub: v.config.hub,
      hasToken: false,
      canStoreToken: this.#tokens?.available() ?? false,
      pending: 0,
      cursor: 0,
      conflicts: this.#conflicts.length,
    };
    if (personal || !v.config.hub) return base;

    base.hasToken = this.#tokens ? (await this.#tokens.get(v.config.id)) !== null : false;
    const state = await readState(v);
    base.cursor = state.cursor;
    base.pending = pendingChanges(state, (await scanLocal(v)).pages).length;
    return base;
  }

  /**
   * 허브에 붙는다. 토큰을 저장하기 **전에** 실제로 물어본다 — 오타 난 토큰을 보관해 두면
   * 처음 실패하는 지점이 한참 뒤의 동기화가 되고 사람은 이유를 모른다.
   */
  async connectHub(url: string, token: string): Promise<{ ok: true; role: string } | { ok: false; error: string }> {
    const v = this.#require();
    if (v.config.id === PERSONAL_ID) return { ok: false, error: '개인 Vault 는 허브에 붙이지 않습니다' };
    if (!this.#tokens) return { ok: false, error: '토큰 보관소가 없습니다' };
    if (!this.#tokens.available()) return { ok: false, error: '이 시스템에서는 토큰을 안전하게 보관할 수 없습니다' };

    const client = hubClient({ url, token }, this.#hubFetch);
    let role: string;
    try {
      const space = (await client.spaces()).find((s) => s.id === v.config.id);
      if (!space) return { ok: false, error: `허브에 ${v.config.id} 공간이 없거나 접근 권한이 없습니다` };
      if (space.role === 'reader') return { ok: false, error: '읽기 권한만 있어 동기화할 수 없습니다' };
      role = space.role;
    } catch (e) {
      if (e instanceof HubOffline) return { ok: false, error: '허브에 닿지 못했습니다' };
      if (e instanceof HubError) return { ok: false, error: `허브가 거절했습니다 (${e.status}): ${e.message}` };
      throw e;
    }

    await this.#tokens.set(v.config.id, token);
    this.#vault = await setHub(v, url);
    await appendLog(this.#vault, 'ingest', `허브 연결 ${url}`);
    return { ok: true, role };
  }

  /** 토큰만 지운다. 이미 받아 둔 페이지는 그대로 둔다 — 지식은 로컬에 남는 것이 원칙이다. */
  async disconnectHub(): Promise<void> {
    const v = this.#require();
    await this.#tokens?.remove(v.config.id);
    this.#vault = await setHub(v, null);
    this.#conflicts = [];
  }

  /** 한 번 돌린다. 충돌은 아무것도 쓰지 않고 병합 화면으로 넘어간다. */
  async syncNow(): Promise<SyncResult> {
    const v = this.#require();
    const client = await this.#hub();
    if (!client.ok) return { ok: false, error: client.error };
    try {
      const report = await sync(v, client.client);
      this.#conflicts = report.conflicts;
      if (report.pulled.length || report.pushed.length) {
        await writeIndex(v, (await readWikiPages(v)).entries);
        await appendLog(v, 'ingest', `동기화 받기 ${report.pulled.length}건 · 보내기 ${report.pushed.length}건`);
      }
      return { ok: true, report };
    } catch (e) {
      if (e instanceof HubError) return { ok: false, error: `허브가 거절했습니다 (${e.status}): ${e.message}` };
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 병합 화면이 들고 있어야 할 재료. 앱을 다시 띄우면 사라지고 다음 동기화에서 다시 난다. */
  conflicts(): SyncConflict[] {
    return this.#conflicts;
  }

  /** 사람이 고른 병합 결과를 올린다. 충돌 표시가 남아 있으면 core 가 거절한다. */
  async resolveConflict(pageId: string, merged: string): Promise<ResolveResult> {
    const v = this.#require();
    const conflict = this.#conflicts.find((c) => c.pageId === pageId);
    if (!conflict) return { ok: false, error: '그 충돌이 목록에 없습니다' };
    const client = await this.#hub();
    if (!client.ok) return { ok: false, error: client.error };

    let r;
    try {
      r = await resolveConflict(v, client.client, conflict, merged);
    } catch (e) {
      if (e instanceof HubOffline) return { ok: false, error: '허브에 닿지 못했습니다' };
      if (e instanceof HubError) return { ok: false, error: `허브가 거절했습니다 (${e.status}): ${e.message}` };
      throw e;
    }
    if (!r.ok) {
      // 병합하는 사이에 또 바뀌었으면 새 재료로 갈아 끼운다. 사람이 다시 고른다
      if (r.conflict) this.#conflicts = this.#conflicts.map((c) => (c.pageId === pageId ? r.conflict! : c));
      return { ok: false, error: r.reason, conflicts: this.#conflicts };
    }
    this.#conflicts = this.#conflicts.filter((c) => c.pageId !== pageId);
    await writeIndex(v, (await readWikiPages(v)).entries);
    await appendLog(v, 'ingest', `충돌 병합 ${conflict.path}`);
    return { ok: true, version: r.version, conflicts: this.#conflicts };
  }

  /** 허브 클라이언트를 만든다. 주소나 토큰이 없으면 이유를 문장으로 돌려준다. */
  async #hub(): Promise<{ ok: true; client: HubClient } | { ok: false; error: string }> {
    const v = this.#require();
    if (v.config.id === PERSONAL_ID || !v.config.hub) return { ok: false, error: '개인 Vault 는 동기화하지 않습니다' };
    const token = await this.#tokens?.get(v.config.id);
    if (!token) return { ok: false, error: '허브 토큰이 없습니다. 다시 연결하십시오' };
    return { ok: true, client: hubClient({ url: v.config.hub, token }, this.#hubFetch) };
  }

  /* ---------- 내부 ---------- */

  /** 앵커 실재 검사(관문 5)의 근거. extracted/ 가 진실이다. */
  async #anchors(): Promise<Map<string, Set<string>>> {
    const m = new Map<string, Set<string>>();
    for (const s of await this.listSources()) {
      const e = await this.readSource(s.sourceId);
      if (e) m.set(e.sourceId, new Set(e.chunks.map((c) => c.anchor.locator)));
    }
    return m;
  }

  /** 모델이 update 를 내려면 지금 페이지의 baseHash 를 알아야 한다. */
  async #wikiRefs(): Promise<WikiRef[]> {
    const v = this.#require();
    const out: WikiRef[] = [];
    for (const e of (await readWikiPages(v)).entries) {
      const hash = await currentHash(v, e.path);
      if (hash) out.push({ path: e.path, title: e.page.front.title, hash });
    }
    return out;
  }

  #require(): Vault {
    if (!this.#vault || !this.#index) throw new Error('Vault 가 열려 있지 않습니다');
    return this.#vault;
  }

  async #persist(ext: Extraction): Promise<void> {
    const v = this.#require();
    await fs.writeFile(
      safeJoin(v.root, EXTRACTED_DIR, `${ext.sourceId}.json`),
      JSON.stringify(ext, null, 1),
      'utf8',
    );
  }

  async #writeRelations(name: string, relations: readonly Relation[]): Promise<void> {
    const v = this.#require();
    await fs.writeFile(
      safeJoin(v.root, EXTRACTED_DIR, `${name}.relations.json`),
      JSON.stringify(relations, null, 1),
      'utf8',
    );
  }

  async #loadMailMetas(): Promise<MailMeta[]> {
    const v = this.#require();
    const out: MailMeta[] = [];
    for (const s of await this.listSources()) {
      if (s.kind !== 'eml' && s.kind !== 'msg') continue;
      const file = safeJoin(v.root, SOURCES_DIR, s.filename);
      try {
        out.push((await extractEmail(file, s.sourceId)).meta);
      } catch {
        // 원본이 지워졌으면 건너뛴다
      }
    }
    return out;
  }

  /** 색인은 캐시다. 열 때 extracted/ 에서 다시 만든다. */
  async #reindexFromDisk(): Promise<void> {
    const v = this.#require();
    for (const name of await fs.readdir(safeJoin(v.root, EXTRACTED_DIR))) {
      if (!name.endsWith('.json') || name.startsWith('__') || name.endsWith('.relations.json')) continue;
      const e = JSON.parse(await fs.readFile(safeJoin(v.root, EXTRACTED_DIR, name), 'utf8')) as Extraction;
      this.#index!.indexSource(e.sourceId, e.chunks);
    }
  }
}
