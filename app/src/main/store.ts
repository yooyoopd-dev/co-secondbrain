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
import { buildReview, selectOps } from '../core/review.ts';
import { snapshot } from '../core/history.ts';
import { readWikiPages, writeIndex } from '../core/wiki.ts';
import { createCli } from '../core/agent/index.ts';
import type { ProviderId } from '../core/agent/types.ts';
import { CHANGESET_SCHEMA } from '../core/agent/schema.ts';
import { conventionFile, promptFor, type WikiRef } from '../core/agent/ingest.ts';
import { disposeWorkdir, prepareWorkdir } from '../core/agent/workdir.ts';
import type { Extraction, Relation } from '../core/types.ts';
import type { IngestResult, ProposeResult, SourceSummary } from './ipc.ts';

export class Store {
  #vault: Vault | null = null;
  #db: DatabaseSync | null = null;
  #index: SearchIndex | null = null;
  /** 검토 중인 변경안. 사람이 승인하기 전까지 여기 머문다 — 디스크에 없다 */
  #pending: ChangeSet | null = null;

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
        res.ok.push(filename);
        res.relations += ext.relations.length;
        for (const w of ext.warnings) res.warnings.push({ filename, warning: w });
        await appendLog(v, 'ingest', filename);
      } catch (e) {
        res.failed.push({ filename, reason: e instanceof Error ? e.message : String(e) });
      }
    }

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
  async propose(sourceId: string, provider: ProviderId = 'claude-code'): Promise<ProposeResult> {
    const v = this.#require();
    const ext = await this.readSource(sourceId);
    if (!ext) return { ok: false, error: `원본이 없습니다: ${sourceId}` };

    const cli = createCli(provider);
    // 규약 파일은 배치 내내 같은 바이트여야 캐시가 산다 (M2-PLAN.md §2.1).
    // 이름은 CLI 마다 다르다 (PLAN.md §7.3).
    const agentsMd = await fs.readFile(safeJoin(v.root, 'schema/AGENTS.md'), 'utf8');
    const wd = await prepareWorkdir({ [cli.conventionFile]: conventionFile(agentsMd) });
    try {
      const r = await cli.run(
        { workdir: wd.root, prompt: promptFor(ext, await this.#wikiRefs()) },
        CHANGESET_SCHEMA,
      );
      if (!r.ok) return { ok: false, error: r.error ?? '변경안을 받지 못했습니다' };
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
