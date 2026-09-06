// 동기화 알고리즘. HUB.md §5
//
// **조용한 덮어쓰기는 어느 방향으로도 일어나지 않는다.** 로컬에 보류 변경이 없는
// 페이지만 원격으로 덮고, 양쪽이 다 바뀐 페이지는 병합안을 만들어 사람에게 넘긴다.
//
// 오프라인 큐를 따로 두지 않는다. 보류 변경은 **디스크와 기준본의 차이로 계산한다** —
// 큐 파일을 두면 앱이 죽었을 때 큐와 디스크가 어긋나고, 그때 무엇이 진실인지 정할
// 방법이 없다. "디스크가 진실이다"(PLAN.md §3)를 여기서도 지킨다.
import fs from 'node:fs/promises';
import { PAGE_PATH_RE } from '../changeset.ts';
import { pageHash, parsePage } from '../page.ts';
import { safeJoin } from '../security.ts';
import { readWikiPages } from '../wiki.ts';
import type { Vault } from '../vault.ts';
import { hasMarkers, merge3, type Merge3 } from './merge.ts';
import { HubOffline, type HubClient } from './client.ts';
import { readBase, readState, removeBase, writeBase, writeState, type MirrorEntry, type SyncState } from './state.ts';

export interface LocalPage {
  pageId: string;
  path: string;
  content: string;
  hash: string;
}

export type PendingKind = 'create' | 'update' | 'delete';

export interface Pending {
  pageId: string;
  kind: PendingKind;
  /** delete 면 마지막으로 알던 경로 */
  path: string;
  content: string | null;
  entry: MirrorEntry | null;
}

export interface SyncConflict {
  pageId: string;
  path: string;
  /** 기준본. 처음 만드는 페이지라 기준이 없으면 빈 문자열 */
  base: string;
  mine: string;
  theirs: string;
  serverVersion: number;
  merged: Merge3;
}

export interface SyncReport {
  cursor: number;
  pulled: { pageId: string; path: string; kind: 'update' | 'delete' }[];
  pushed: { pageId: string; path: string; version: number; kind: PendingKind }[];
  conflicts: SyncConflict[];
  /** 동기화에서 뺀 파일과 이유 */
  skipped: { path: string; reason: string }[];
  /** 허브에 닿지 못했다. 로컬 변경은 그대로 남아 다음에 올라간다 */
  offline: boolean;
}

/** 로컬 위키를 훑는다. front-matter 가 깨진 파일은 동기화에서 뺀다. */
export async function scanLocal(vault: Vault): Promise<{ pages: Map<string, LocalPage>; skipped: SyncReport['skipped'] }> {
  const { entries, broken } = await readWikiPages(vault);
  const pages = new Map<string, LocalPage>();
  const skipped = broken.map((b) => ({ path: b.path, reason: b.reason }));

  for (const e of entries) {
    const id = e.page.front.id;
    if (!id) {
      skipped.push({ path: e.path, reason: 'front-matter 에 id 가 없습니다' });
      continue;
    }
    const prev = pages.get(id);
    if (prev) {
      skipped.push({ path: e.path, reason: `id 가 ${prev.path} 와 겹칩니다: ${id}` });
      continue;
    }
    const content = await fs.readFile(safeJoin(vault.root, e.path), 'utf8');
    pages.set(id, { pageId: id, path: e.path, content, hash: pageHash(content) });
  }
  return { pages, skipped };
}

/** 보류 변경 = 디스크와 기준본의 차이. 큐 파일이 없어도 재시작 뒤에 그대로 살아난다. */
export function pendingChanges(state: SyncState, local: ReadonlyMap<string, LocalPage>): Pending[] {
  const out: Pending[] = [];
  for (const [pageId, page] of local) {
    const entry = state.pages[pageId];
    if (!entry) out.push({ pageId, kind: 'create', path: page.path, content: page.content, entry: null });
    else if (entry.hash !== page.hash || entry.path !== page.path) {
      out.push({ pageId, kind: 'update', path: page.path, content: page.content, entry });
    }
  }
  for (const [pageId, entry] of Object.entries(state.pages)) {
    if (!local.has(pageId)) out.push({ pageId, kind: 'delete', path: entry.path, content: null, entry });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 한 번 돌린다. 받기 → 보내기 순서다.
 *
 * 충돌은 **아무것도 쓰지 않고** 보고만 한다. 병합안을 사람이 보고 고른 뒤
 * `resolveConflict` 로 마무리한다 (HUB.md §5 의 "3-way 병합 화면").
 */
export async function sync(vault: Vault, client: HubClient): Promise<SyncReport> {
  const spaceId = vault.config.id;
  if (!vault.config.hub) throw new Error('개인 Vault 는 동기화하지 않습니다');

  const state = await readState(vault);
  const scan = await scanLocal(vault);
  const report: SyncReport = { cursor: state.cursor, pulled: [], pushed: [], conflicts: [], skipped: scan.skipped, offline: false };
  const pending = pendingChanges(state, scan.pages);
  const held = new Set(pending.map((p) => p.pageId));

  try {
    await pull(vault, client, spaceId, state, held, report);
    await push(vault, client, spaceId, state, pending, report);
  } catch (e) {
    if (!(e instanceof HubOffline)) throw e;
    report.offline = true;
  }

  await writeState(vault, state);
  report.cursor = state.cursor;
  return report;
}

async function pull(
  vault: Vault,
  client: HubClient,
  spaceId: string,
  state: SyncState,
  held: ReadonlySet<string>,
  report: SyncReport,
): Promise<void> {
  const seen = new Set<string>();
  for (;;) {
    const page = await client.changes(spaceId, state.cursor);
    for (const ev of page.events) {
      if (ev.kind === 'page' && ev.page_id) seen.add(ev.page_id);
    }
    state.cursor = page.nextSeq;
    if (!page.hasMore) break;
  }

  for (const pageId of seen) {
    // 보류 변경이 있는 페이지는 건드리지 않는다. 보내기 단계에서 409 로 만나 병합한다
    if (held.has(pageId)) continue;

    const remote = await client.getPage(spaceId, pageId);
    const entry = state.pages[pageId];

    if (remote === null || remote.deleted) {
      if (!entry) continue;
      await fs.rm(safeJoin(vault.root, entry.path), { force: true });
      await removeBase(vault, pageId);
      delete state.pages[pageId];
      report.pulled.push({ pageId, path: entry.path, kind: 'delete' });
      continue;
    }

    // 허브가 준 경로를 그대로 믿지 않는다 — 위키 밖으로 쓰는 길을 막는다
    if (!PAGE_PATH_RE.test(remote.path)) {
      report.skipped.push({ path: remote.path, reason: `허브가 준 경로가 형식에 맞지 않습니다 (${pageId})` });
      continue;
    }
    const full = safeJoin(vault.root, remote.path);
    if (entry && entry.path !== remote.path) await fs.rm(safeJoin(vault.root, entry.path), { force: true });

    await fs.mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(full, remote.content, 'utf8');
    await writeBase(vault, pageId, remote.content);
    const changed = !entry || entry.hash !== pageHash(remote.content) || entry.path !== remote.path;
    state.pages[pageId] = { pageId, path: remote.path, version: remote.version, hash: pageHash(remote.content) };
    if (changed) report.pulled.push({ pageId, path: remote.path, kind: 'update' });
  }
}

async function push(
  vault: Vault,
  client: HubClient,
  spaceId: string,
  state: SyncState,
  pending: readonly Pending[],
  report: SyncReport,
): Promise<void> {
  for (const p of pending) {
    if (p.kind === 'delete') {
      const r = await client.deletePage(spaceId, p.pageId, p.entry!.version);
      if (r.ok) {
        await removeBase(vault, p.pageId);
        delete state.pages[p.pageId];
        report.pushed.push({ pageId: p.pageId, path: p.path, version: r.version, kind: 'delete' });
      } else {
        // 내가 지우는 동안 남이 고쳤다. 지우기는 되돌릴 수 없으니 사람에게 묻는다
        report.conflicts.push(await conflictOf(vault, p, r.conflict.serverVersion, r.conflict.serverContent, ''));
      }
      continue;
    }

    const baseVersion = p.kind === 'create' ? null : p.entry!.version;
    const r = await client.putPage(spaceId, p.pageId, { path: p.path, content: p.content!, baseVersion });
    if (r.ok) {
      await writeBase(vault, p.pageId, p.content!);
      state.pages[p.pageId] = { pageId: p.pageId, path: p.path, version: r.version, hash: pageHash(p.content!) };
      report.pushed.push({ pageId: p.pageId, path: p.path, version: r.version, kind: p.kind });
    } else {
      report.conflicts.push(
        await conflictOf(vault, p, r.conflict.serverVersion, r.conflict.serverContent, p.content!, r.conflict.baseContent),
      );
    }
  }
}

/**
 * 기준본은 로컬 것을 먼저 쓴다. 허브의 `baseContent` 는 그 판본이 지워졌으면 null 이고,
 * 로컬 기준본은 내가 마지막으로 맞춰 놓은 바로 그 내용이라 더 정확하다.
 */
async function conflictOf(
  vault: Vault,
  p: Pending,
  serverVersion: number,
  serverContent: string,
  mine: string,
  remoteBase?: string | null,
): Promise<SyncConflict> {
  const base = (await readBase(vault, p.pageId)) ?? remoteBase ?? '';
  return {
    pageId: p.pageId,
    path: p.path,
    base,
    mine,
    theirs: serverContent,
    serverVersion,
    merged: merge3(base, mine, serverContent),
  };
}

/**
 * 사람이 고른 병합 결과를 올린다. 충돌 표시가 남아 있으면 거절한다 —
 * `<<<<<<<` 가 그대로 올라간 페이지는 다음 사람이 읽을 때 더 큰 비용이 된다.
 */
export async function resolveConflict(
  vault: Vault,
  client: HubClient,
  conflict: SyncConflict,
  merged: string,
): Promise<{ ok: true; version: number } | { ok: false; reason: string; conflict?: SyncConflict }> {
  if (hasMarkers(merged)) return { ok: false, reason: '충돌 표시가 남아 있습니다' };
  try {
    parsePage(merged);
  } catch (e) {
    return { ok: false, reason: `병합 결과가 페이지 형식이 아닙니다: ${e instanceof Error ? e.message : String(e)}` };
  }

  const spaceId = vault.config.id;
  const r = await client.putPage(spaceId, conflict.pageId, {
    path: conflict.path,
    content: merged,
    baseVersion: conflict.serverVersion,
  });
  if (!r.ok) {
    const p: Pending = { pageId: conflict.pageId, kind: 'update', path: conflict.path, content: merged, entry: null };
    return {
      ok: false,
      reason: '병합하는 사이에 허브가 또 바뀌었습니다',
      conflict: await conflictOf(vault, p, r.conflict.serverVersion, r.conflict.serverContent, merged, r.conflict.baseContent),
    };
  }

  const full = safeJoin(vault.root, conflict.path);
  await fs.mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(full, merged, 'utf8');
  await writeBase(vault, conflict.pageId, merged);

  const state = await readState(vault);
  state.pages[conflict.pageId] = { pageId: conflict.pageId, path: conflict.path, version: r.version, hash: pageHash(merged) };
  await writeState(vault, state);
  return { ok: true, version: r.version };
}
