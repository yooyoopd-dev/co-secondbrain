// 페이지 저장과 낙관적 동시성. HUB.md §3 · §4
//
// **잠금이 없다.** 두 사람이 같은 페이지를 고치면 나중에 쓴 쪽이 409 를 받고,
// 응답에 3-way 병합 재료 세 조각(base · 서버 · 내 것 중 앞의 둘)이 같이 온다.
// 왕복을 줄이는 것이 이 설계의 요점이다.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EventRow, PageRow } from './db.ts';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface Conflict {
  serverVersion: number;
  serverContent: string;
  /** 클라이언트가 기준으로 삼았던 판본. 없으면 null (그 버전이 지워졌거나 처음부터 틀림) */
  baseContent: string | null;
}

export type WriteResult =
  | { ok: true; version: number; hash: string }
  | { ok: false; conflict: Conflict };

export interface PutInput {
  path: string;
  content: string;
  /** `If-Match` 로 온 값. 신규 생성이면 null (`If-None-Match: *`) */
  baseVersion: number | null;
}

function currentPage(db: DatabaseSync, spaceId: string, pageId: string): PageRow | undefined {
  return db.prepare('SELECT * FROM pages WHERE space_id = ? AND page_id = ?').get(spaceId, pageId) as unknown as PageRow | undefined;
}

function versionContent(db: DatabaseSync, spaceId: string, pageId: string, version: number): string | null {
  const row = db
    .prepare('SELECT content FROM page_versions WHERE space_id = ? AND page_id = ? AND version = ?')
    .get(spaceId, pageId, version) as { content: string } | undefined;
  return row?.content ?? null;
}

function conflictOf(db: DatabaseSync, cur: PageRow, baseVersion: number | null): Conflict {
  return {
    serverVersion: cur.version,
    serverContent: cur.content,
    baseContent: baseVersion === null ? null : versionContent(db, cur.space_id, cur.page_id, baseVersion),
  };
}

function addEvent(
  db: DatabaseSync,
  e: { spaceId: string; kind: string; pageId?: string; ref?: string; title?: string; actor: string; at: string },
): void {
  db.prepare('INSERT INTO events (space_id, kind, page_id, ref, title, actor, at) VALUES (?,?,?,?,?,?,?)').run(
    e.spaceId,
    e.kind,
    e.pageId ?? null,
    e.ref ?? null,
    e.title ?? null,
    e.actor,
    e.at,
  );
}

/**
 * 페이지를 쓴다. **한 트랜잭션 안에서 현재 판본을 읽고 비교하고 쓴다** —
 * 읽고 나서 쓰기 전에 남이 끼어들면 무손실이 깨진다. `BEGIN IMMEDIATE` 로 쓰기 잠금을
 * 먼저 잡는다 (WAL + busy_timeout 이 두 프로세스를 줄 세운다).
 */
export function putPage(
  db: DatabaseSync,
  spaceId: string,
  pageId: string,
  input: PutInput,
  actor: string,
  now: string,
): WriteResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = currentPage(db, spaceId, pageId);

    if (input.baseVersion === null) {
      // 신규 생성인데 이미 있다 — 남이 먼저 만들었다
      if (cur && !cur.deleted) {
        const c = conflictOf(db, cur, null);
        db.exec('ROLLBACK');
        return { ok: false, conflict: c };
      }
    } else if (!cur || cur.version !== input.baseVersion) {
      const c = cur
        ? conflictOf(db, cur, input.baseVersion)
        : { serverVersion: 0, serverContent: '', baseContent: null };
      db.exec('ROLLBACK');
      return { ok: false, conflict: c };
    }

    const version = (cur?.version ?? 0) + 1;
    const hash = sha256(input.content);
    db.prepare(
      `INSERT INTO pages (space_id, page_id, path, version, hash, content, deleted, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,0,?,?)
       ON CONFLICT(space_id, page_id) DO UPDATE SET
         path = excluded.path, version = excluded.version, hash = excluded.hash,
         content = excluded.content, deleted = 0,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(spaceId, pageId, input.path, version, hash, input.content, now, actor);
    db.prepare(
      'INSERT INTO page_versions (space_id, page_id, version, hash, content, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
    ).run(spaceId, pageId, version, hash, input.content, now, actor);
    addEvent(db, { spaceId, kind: 'page', pageId, ref: input.path, title: `v${version}`, actor, at: now });
    db.exec('COMMIT');
    return { ok: true, version, hash };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 지우기도 판본을 올린다. 동기화하는 쪽이 "지워졌다"를 이벤트로 받아야 한다. */
export function deletePage(
  db: DatabaseSync,
  spaceId: string,
  pageId: string,
  baseVersion: number,
  actor: string,
  now: string,
): WriteResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const cur = currentPage(db, spaceId, pageId);
    if (!cur || cur.version !== baseVersion || cur.deleted) {
      const c = cur ? conflictOf(db, cur, baseVersion) : { serverVersion: 0, serverContent: '', baseContent: null };
      db.exec('ROLLBACK');
      return { ok: false, conflict: c };
    }
    const version = cur.version + 1;
    db.prepare('UPDATE pages SET version = ?, deleted = 1, updated_at = ?, updated_by = ? WHERE space_id = ? AND page_id = ?')
      .run(version, now, actor, spaceId, pageId);
    db.prepare(
      'INSERT INTO page_versions (space_id, page_id, version, hash, content, created_at, created_by) VALUES (?,?,?,?,?,?,?)',
    ).run(spaceId, pageId, version, cur.hash, cur.content, now, actor);
    addEvent(db, { spaceId, kind: 'page', pageId, ref: cur.path, title: '삭제', actor, at: now });
    db.exec('COMMIT');
    return { ok: true, version, hash: cur.hash };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getPage(db: DatabaseSync, spaceId: string, pageId: string, version?: number): PageRow | null {
  const cur = currentPage(db, spaceId, pageId);
  if (!cur) return null;
  if (version === undefined) return cur;
  const old = db
    .prepare('SELECT * FROM page_versions WHERE space_id = ? AND page_id = ? AND version = ?')
    .get(spaceId, pageId, version) as { content: string; hash: string; created_at: string; created_by: string } | undefined;
  if (!old) return null;
  return { ...cur, version, hash: old.hash, content: old.content, updated_at: old.created_at, updated_by: old.created_by };
}

export interface Changes {
  events: EventRow[];
  nextSeq: number;
  hasMore: boolean;
}

/** 동기화 커서. `since` 보다 큰 이벤트를 순서대로 준다. */
export function changes(db: DatabaseSync, spaceId: string, since: number, limit: number): Changes {
  const rows = db
    .prepare('SELECT * FROM events WHERE space_id = ? AND seq > ? ORDER BY seq LIMIT ?')
    .all(spaceId, since, limit + 1) as unknown as EventRow[];
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  return { events, nextSeq: events.length ? events[events.length - 1]!.seq : since, hasMore };
}

export { addEvent };
