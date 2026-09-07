// 스냅샷 · 되돌리기. Git 의존성 없이 PLAN.md §3 의 "되돌리기"를 제공한다.
//
// 콘텐츠 주소 방식이라 같은 내용은 한 번만 저장된다.
// 되돌리기의 단위는 "적용 1회"다 — ChangeSet 이 건드린 페이지를 한꺼번에 되돌린다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeJoin } from './security.ts';
import type { Vault } from './vault.ts';

export interface SnapshotEntry {
  path: string;
  /** null 이면 그 시점에 파일이 없었다 (되돌리면 삭제한다) */
  blob: string | null;
}

export interface Snapshot {
  id: string;
  at: string;
  label: string;
  entries: SnapshotEntry[];
}

const INDEX = '.sb/history/index.json';
const BLOBS = '.sb/history/blobs';

/** 적용 직전 상태를 저장한다. 없는 파일은 null 로 남겨 되돌릴 때 삭제한다. */
export async function snapshot(vault: Vault, paths: readonly string[], label: string): Promise<Snapshot> {
  await fs.mkdir(safeJoin(vault.root, BLOBS), { recursive: true });
  const entries: SnapshotEntry[] = [];

  for (const p of paths) {
    let content: string | null = null;
    try {
      content = await fs.readFile(safeJoin(vault.root, p), 'utf8');
    } catch {
      content = null;
    }
    if (content === null) {
      entries.push({ path: p, blob: null });
      continue;
    }
    const blob = createHash('sha256').update(content, 'utf8').digest('hex');
    const dest = safeJoin(vault.root, BLOBS, blob);
    // 콘텐츠 주소 — 이미 있으면 다시 쓰지 않는다
    try {
      await fs.access(dest);
    } catch {
      await fs.writeFile(dest, content, 'utf8');
    }
    entries.push({ path: p, blob });
  }

  const snap: Snapshot = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    label,
    entries,
  };
  const all = await listSnapshots(vault);
  all.unshift(snap);
  await fs.writeFile(safeJoin(vault.root, INDEX), JSON.stringify(all, null, 1), 'utf8');
  return snap;
}

export async function listSnapshots(vault: Vault): Promise<Snapshot[]> {
  try {
    return JSON.parse(await fs.readFile(safeJoin(vault.root, INDEX), 'utf8')) as Snapshot[];
  } catch {
    return [];
  }
}

/** 스냅샷 시점으로 되돌린다. 그 스냅샷이 담은 경로만 건드린다. */
export async function restore(vault: Vault, snapshotId: string): Promise<string[]> {
  const snap = (await listSnapshots(vault)).find((s) => s.id === snapshotId);
  if (!snap) throw new Error(`스냅샷이 없습니다: ${snapshotId}`);

  const restored: string[] = [];
  for (const e of snap.entries) {
    const full = safeJoin(vault.root, e.path);
    if (e.blob === null) {
      await fs.rm(full, { force: true });
    } else {
      const content = await fs.readFile(safeJoin(vault.root, BLOBS, e.blob), 'utf8');
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
    }
    restored.push(e.path);
  }
  return restored;
}
