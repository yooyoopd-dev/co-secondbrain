// Vault 상태 + 색인. main 프로세스에만 산다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex, type Db } from '../core/search.ts';
import { openVault, createVault, importSource, appendLog, type Vault } from '../core/vault.ts';
import { extractFile, buildThreads } from '../core/extract/index.ts';
import { extractEmail, type MailMeta } from '../core/extract/email.ts';
import { safeJoin } from '../core/security.ts';
import { applyChangeSet, currentHash, type ApplyResult, type ChangeSet } from '../core/changeset.ts';
import { buildReview, selectOps, type Review } from '../core/review.ts';
import { snapshot } from '../core/history.ts';
import { readWikiPages, writeIndex } from '../core/wiki.ts';
import { createCli } from '../core/agent/index.ts';
import { route, type TaskKind } from '../core/agent/router.ts';
import { hashContent, markProposed, planWork, readManifest, recordSource, writeManifest, type Manifest, type SourceState, type WorkPlan } from '../core/cache.ts';
import { DEFAULT_MONTHLY_USD, EMPTY_LOG, add as addSpend, status as spendStatus, type Limits, type SpendLog, type Status } from '../core/spend.ts';
import { read as readSpend, write as writeSpend } from '../core/spend-file.ts';
import type { ProviderId } from '../core/agent/types.ts';
import { CHANGESET_SCHEMA } from '../core/agent/schema.ts';
import { conventionFile, promptFor, type WikiRef } from '../core/agent/ingest.ts';
import { ALLOWED_TOOLS, mcpConfig, type McpLaunch } from '../core/mcp/config.ts';
import { ANSWER_SCHEMA, parseAnswer, questionPrompt, toChangeSet, type Answer } from '../core/query.ts';
import { JUDGMENT_SCHEMA, judgmentPrompt, parseJudgment, summarizeJudgment, type ParsedJudgment } from '../core/lint/judgment.ts';
import { toMarp } from '../core/marp.ts';
import { estimateScan, type ScanEstimate } from '../core/tokens.ts';
import { disposeWorkdir, prepareWorkdir } from '../core/agent/workdir.ts';
import type { Extraction, Relation } from '../core/types.ts';
import type { AskResult, IngestResult, JudgmentResult, ProposeResult, SourceSummary } from './ipc.ts';

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
  /** detect() 는 프로세스를 띄운다. 한 번만 한다 */
  #available: ProviderId[] | null = null;

  /** MCP 서버를 어떻게 띄울지. 개발과 패키징본이 달라 main 이 정한다 */
  readonly #mcpLaunch: ((vaultRoot: string) => McpLaunch) | null;

  constructor(opts: { spendFile?: string; mcpLaunch?: (vaultRoot: string) => McpLaunch } = {}) {
    this.#spendFile = opts.spendFile ?? null;
    this.#mcpLaunch = opts.mcpLaunch ?? null;
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
    if (this.#spendFile) this.#spend = await readSpend(this.#spendFile);
    return v;
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
    this.#index = null;
    this.#vault = null;
    this.#pending = null;
  }

  /** 파일 여러 개를 인제스트한다. 한 건이 실패해도 나머지는 계속한다. */
  async ingest(files: readonly string[]): Promise<IngestResult> {
    const v = this.#require();
    const res: IngestResult = { ok: [], failed: [], warnings: [], relations: 0 };
    const mails: MailMeta[] = [];

    for (const file of files) {
      const filename = path.basename(file);
      try {
        const dest = await importSource(v, file);
        const ext = await extractFile(dest);
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
    const dir = safeJoin(v.root, 'extracted');
    const out: SourceSummary[] = [];
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith('.json') || name.startsWith('__')) continue;
      const e = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as Extraction;
      out.push({ sourceId: e.sourceId, filename: e.filename, kind: e.kind, chunks: e.chunks.length });
    }
    return out.sort((a, b) => a.filename.localeCompare(b.filename, 'ko'));
  }

  search(query: string) {
    return this.#index?.search(query) ?? [];
  }

  async readSource(sourceId: string): Promise<Extraction | null> {
    const v = this.#require();
    try {
      return JSON.parse(await fs.readFile(safeJoin(v.root, 'extracted', `${sourceId}.json`), 'utf8')) as Extraction;
    } catch {
      return null;
    }
  }

  /* ---------- 관문 8 — 변경안 제안과 승인 ---------- */

  /**
   * 원본 하나로 ChangeSet 을 받아 검토 재료를 만든다. **디스크는 건드리지 않는다.**
   * 실패해도 던지지 않는다 — 사유를 화면에 그대로 띄우는 편이 낫다.
   */
  /** 무엇을 CLI 로 보내야 하는가. 이름만 바뀐 것과 이미 만든 것은 빠진다 (PLAN.md §9.1) */
  async plan(): Promise<WorkPlan> {
    const v = this.#require();
    const states: SourceState[] = [];
    for (const s of await this.listSources()) {
      try {
        states.push({
          sourceId: s.sourceId,
          filename: s.filename,
          contentHash: hashContent(await fs.readFile(safeJoin(v.root, 'sources', s.filename))),
        });
      } catch {
        // 원본이 지워졌으면 건너뛴다
      }
    }
    return planWork(this.#manifest, states);
  }

  /** 설치·인증된 공급자. detect() 는 프로세스를 띄우므로 한 번만 본다. */
  async available(): Promise<ProviderId[]> {
    if (this.#available) return this.#available;
    const found: ProviderId[] = [];
    for (const id of ['claude-code', 'gemini'] as const) {
      try {
        if ((await createCli(id).detect()).found) found.push(id);
      } catch {
        // 어댑터가 없는 공급자는 건너뛴다
      }
    }
    this.#available = found;
    return found;
  }

  /** 공급자별 이번 달 소비와 남은 문서 수. 화면에 띄운다. */
  spendStatus(now: string = new Date().toISOString()): Status[] {
    return (['claude-code', 'gemini'] as const).map((p) => spendStatus(this.#spend, this.#limits, p, now));
  }

  async propose(sourceId: string, provider?: ProviderId, kind: TaskKind = 'ingest.single'): Promise<ProposeResult> {
    const v = this.#require();
    const ext = await this.readSource(sourceId);
    if (!ext) return { ok: false, error: `원본이 없습니다: ${sourceId}` };

    const now = new Date().toISOString();
    const overLimit = this.spendStatus(now).filter((s) => s.level === 'over').map((s) => s.provider);
    const picked = provider
      ? { ok: true as const, provider, fallback: false, why: '호출자 지정' }
      : route(kind, { available: await this.available(), overLimit });
    if (!picked.ok) return { ok: false, error: picked.reason };

    const cli = createCli(picked.provider);
    // 규약 파일은 배치 내내 같은 바이트여야 캐시가 산다 (M2-PLAN.md §2.1).
    // 이름은 CLI 마다 다르다 (PLAN.md §7.3).
    const agentsMd = await fs.readFile(safeJoin(v.root, 'schema/AGENTS.md'), 'utf8');
    const wd = await prepareWorkdir({ [cli.conventionFile]: conventionFile(agentsMd) });
    try {
      const r = await cli.run(
        { workdir: wd.root, prompt: promptFor(ext, await this.#wikiRefs()) },
        CHANGESET_SCHEMA,
      );
      // 실패해도 돈은 나갔다. 성공만 세면 계량기가 실제보다 낮게 나온다.
      this.#spend = addSpend(this.#spend, picked.provider, r.usage, now);
      if (this.#spendFile) await writeSpend(this.#spendFile, this.#spend);
      if (!r.ok) return { ok: false, error: r.error ?? '변경안을 받지 못했습니다' };

      const hash = hashContent(await fs.readFile(safeJoin(v.root, 'sources', ext.filename)));
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
      await writeIndex(v, (await readWikiPages(v)).entries);
      await appendLog(v, 'ingest', `변경안 적용 ${res.applied.length}건 — ${cs.summary}`);
    }
    return res;
  }

  discardReview(): void {
    this.#pending = null;
  }

  /* ---------- 질의 (PLAN.md §4 Query) ---------- */

  /**
   * 위키에 묻는다. 후보 페이지를 밀어 넣지 않고 **에이전트가 MCP 로 당겨 간다**
   * (PLAN.md §7.2 안 B). 디스크는 안 건드린다 — 보관은 따로 승인받는다.
   */
  async ask(question: string, provider?: ProviderId): Promise<AskResult> {
    const v = this.#require();
    if (!this.#mcpLaunch) return { ok: false, error: '읽기 경로가 설정되지 않았습니다' };

    const now = new Date().toISOString();
    const overLimit = this.spendStatus(now).filter((s) => s.level === 'over').map((s) => s.provider);
    const picked = provider
      ? { ok: true as const, provider, fallback: false, why: '호출자 지정' }
      : route('query', { available: await this.available(), overLimit });
    if (!picked.ok) return { ok: false, error: picked.reason };

    const cli = createCli(picked.provider);
    const wd = await prepareWorkdir({ 'mcp.json': JSON.stringify(mcpConfig(this.#mcpLaunch(v.root)), null, 1) });
    try {
      const r = await cli.run(
        {
          workdir: wd.root,
          prompt: questionPrompt(question),
          mcp: { configPath: safeJoin(wd.root, 'mcp.json'), allowedTools: ALLOWED_TOOLS },
        },
        ANSWER_SCHEMA,
      );
      this.#spend = addSpend(this.#spend, picked.provider, r.usage, now);
      if (this.#spendFile) await writeSpend(this.#spendFile, this.#spend);
      if (!r.ok) return { ok: false, error: r.error ?? '답변을 받지 못했습니다' };

      const { answer, reason } = parseAnswer(r.data);
      if (!answer) return { ok: false, error: reason ?? '답변 형식이 맞지 않습니다' };
      await appendLog(v, 'query', question);
      return { ok: true, question, answer, costUsd: r.usage.costUsd };
    } finally {
      await disposeWorkdir(wd);
    }
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
    if (!this.#mcpLaunch) return { ok: false, error: '읽기 경로가 설정되지 않았습니다' };

    const now = new Date().toISOString();
    const overLimit = this.spendStatus(now).filter((s) => s.level === 'over').map((s) => s.provider);
    const picked = provider
      ? { ok: true as const, provider, fallback: false, why: '호출자 지정' }
      : route('lint.judgment', { available: await this.available(), overLimit });
    if (!picked.ok) return { ok: false, error: picked.reason };

    const { entries } = await readWikiPages(v);
    if (entries.length === 0) return { ok: false, error: '검사할 페이지가 없습니다' };

    const cli = createCli(picked.provider);
    const wd = await prepareWorkdir({ 'mcp.json': JSON.stringify(mcpConfig(this.#mcpLaunch(v.root)), null, 1) });
    try {
      const r = await cli.run(
        {
          workdir: wd.root,
          prompt: judgmentPrompt(entries),
          mcp: { configPath: safeJoin(wd.root, 'mcp.json'), allowedTools: ALLOWED_TOOLS },
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
      safeJoin(v.root, 'extracted', `${ext.sourceId}.json`),
      JSON.stringify(ext, null, 1),
      'utf8',
    );
  }

  async #writeRelations(name: string, relations: readonly Relation[]): Promise<void> {
    const v = this.#require();
    await fs.writeFile(
      safeJoin(v.root, 'extracted', `${name}.relations.json`),
      JSON.stringify(relations, null, 1),
      'utf8',
    );
  }

  async #loadMailMetas(): Promise<MailMeta[]> {
    const v = this.#require();
    const out: MailMeta[] = [];
    for (const s of await this.listSources()) {
      if (s.kind !== 'eml' && s.kind !== 'msg') continue;
      const file = safeJoin(v.root, 'sources', s.filename);
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
    for (const name of await fs.readdir(safeJoin(v.root, 'extracted'))) {
      if (!name.endsWith('.json') || name.startsWith('__') || name.endsWith('.relations.json')) continue;
      const e = JSON.parse(await fs.readFile(safeJoin(v.root, 'extracted', name), 'utf8')) as Extraction;
      this.#index!.indexSource(e.sourceId, e.chunks);
    }
  }
}
