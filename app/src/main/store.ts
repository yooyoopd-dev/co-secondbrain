// Vault 상태 + 색인. main 프로세스에만 산다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex, type Db } from '../core/search.ts';
import { openVault, createVault, importSource, appendLog, type Vault } from '../core/vault.ts';
import { extractFile, buildThreads } from '../core/extract/index.ts';
import { extractEmail, type MailMeta } from '../core/extract/email.ts';
import { safeJoin } from '../core/security.ts';
import type { Extraction, Relation } from '../core/types.ts';
import type { IngestResult, SourceSummary } from './ipc.ts';

export class Store {
  #vault: Vault | null = null;
  #db: DatabaseSync | null = null;
  #index: SearchIndex | null = null;

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

  /* ---------- 내부 ---------- */

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
