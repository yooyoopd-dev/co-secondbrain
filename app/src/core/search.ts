// 한국어 검색 색인. M0 §11 실측에서 나온 하이브리드 전략을 그대로 구현한다.
//
//   1자     거부   — 접두 매칭이 폭발해 오검색만 낸다 (실측 +2건)
//   2자     접두 FTS + LIKE 폴백 — FTS5 trigram 은 3자 미만을 매칭하지 못한다
//   3자 이상 접두 FTS + trigram FTS 합집합
//
// FTS5 는 테이블 단위로 토크나이저가 정해지므로 색인 테이블을 둘 만든다.
// 기본 unicode61 만 쓰면 조사가 붙은 어절을 놓쳐 재현율이 0.524 로 떨어진다.
import type { Chunk, SearchHit } from './types.ts';

/** node:sqlite 와 better-sqlite3 가 공통으로 만족하는 최소 인터페이스.
 *  Electron 이 어느 쪽을 쓸지 아직 확정하지 않아 둘 다 받도록 했다. */
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export const MIN_QUERY_LEN = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  rowid    INTEGER PRIMARY KEY,
  sourceId TEXT NOT NULL,
  locator  TEXT NOT NULL,
  label    TEXT NOT NULL,
  text     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_src ON chunks(sourceId);
-- 접두 매칭용 (조사가 붙은 어절의 앞부분을 잡는다)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_prefix USING fts5(text, content='chunks', content_rowid='rowid');
-- 어절 중간 부분 문자열용 (3자 이상)
CREATE VIRTUAL TABLE IF NOT EXISTS fts_tri USING fts5(text, content='chunks', content_rowid='rowid', tokenize='trigram');
`;

/** FTS5 질의 문자열의 큰따옴표를 이스케이프한다. */
const quote = (q: string) => `"${q.replace(/"/g, '""')}"`;

export class SearchIndex {
  // 파라미터 프로퍼티는 Node 의 타입 제거가 처리하지 못하므로 명시 필드로 둔다.
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(SCHEMA);
  }

  /** 한 원본의 청크를 색인한다. 같은 sourceId 는 먼저 지운다(재추출 대응). */
  indexSource(sourceId: string, chunks: readonly Chunk[]): void {
    this.removeSource(sourceId);
    const ins = this.#db.prepare(
      'INSERT INTO chunks(sourceId, locator, label, text) VALUES (?, ?, ?, ?)',
    );
    const insP = this.#db.prepare('INSERT INTO fts_prefix(rowid, text) VALUES (?, ?)');
    const insT = this.#db.prepare('INSERT INTO fts_tri(rowid, text) VALUES (?, ?)');
    const lastId = this.#db.prepare('SELECT last_insert_rowid() AS id');
    for (const c of chunks) {
      ins.run(sourceId, c.anchor.locator, c.anchor.label, c.text);
      const row = lastId.all()[0] as { id: number };
      insP.run(row.id, c.text);
      insT.run(row.id, c.text);
    }
  }

  removeSource(sourceId: string): void {
    // external content 테이블이라 FTS 행을 먼저 지워야 한다.
    const rows = this.#db.prepare('SELECT rowid FROM chunks WHERE sourceId = ?').all(sourceId) as {
      rowid: number;
    }[];
    const delP = this.#db.prepare("INSERT INTO fts_prefix(fts_prefix, rowid, text) VALUES('delete', ?, ?)");
    const delT = this.#db.prepare("INSERT INTO fts_tri(fts_tri, rowid, text) VALUES('delete', ?, ?)");
    const get = this.#db.prepare('SELECT text FROM chunks WHERE rowid = ?');
    for (const r of rows) {
      const t = (get.all(r.rowid)[0] as { text: string } | undefined)?.text ?? '';
      delP.run(r.rowid, t);
      delT.run(r.rowid, t);
    }
    this.#db.prepare('DELETE FROM chunks WHERE sourceId = ?').run(sourceId);
  }

  /** 질의 길이에 따라 전략을 가른다. 1자 질의는 빈 결과를 돌려준다. */
  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    const len = [...q].length;
    if (len < MIN_QUERY_LEN) return [];

    const rowids = new Set<number>();
    const take = (sql: string, ...params: unknown[]) => {
      for (const r of this.#db.prepare(sql).all(...params) as { rowid: number }[]) rowids.add(r.rowid);
    };

    take('SELECT rowid FROM fts_prefix WHERE fts_prefix MATCH ? ORDER BY rank LIMIT ?', `${quote(q)}*`, limit);

    if (len >= 3) {
      take('SELECT rowid FROM fts_tri WHERE fts_tri MATCH ? ORDER BY rank LIMIT ?', quote(q), limit);
    } else {
      // 2자: 어절 중간 매칭을 LIKE 로 보완한다. LIMIT 이 걸려 있고
      // 5만 청크에서 0.1ms 로 측정됐다 (M0 §11).
      take("SELECT rowid FROM chunks WHERE text LIKE '%' || ? || '%' LIMIT ?", q, limit);
    }

    if (rowids.size === 0) return [];
    const ids = [...rowids].slice(0, limit);
    const rows = this.#db
      .prepare(`SELECT sourceId, locator, label, text FROM chunks WHERE rowid IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { sourceId: string; locator: string; label: string; text: string }[];

    return rows.map((r) => ({
      sourceId: r.sourceId,
      locator: r.locator,
      label: r.label,
      snippet: snippet(r.text, q),
    }));
  }

  /** 질의어가 실제로 있는 원본 수. UI 의 "원본 N건" 표시용. */
  countSources(query: string): number {
    return new Set(this.search(query, 500).map((h) => h.sourceId)).size;
  }
}

/** 질의어 주변을 잘라 낸다. 없으면 앞부분을 준다. */
export function snippet(text: string, query: string, radius = 40): string {
  const i = text.indexOf(query);
  if (i < 0) return text.slice(0, radius * 2) + (text.length > radius * 2 ? '…' : '');
  const from = Math.max(0, i - radius);
  const to = Math.min(text.length, i + query.length + radius);
  return (from > 0 ? '…' : '') + text.slice(from, to) + (to < text.length ? '…' : '');
}
