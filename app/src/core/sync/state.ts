// 동기화 상태. `.sb/sync/` 아래에만 산다.
//
// **상태는 캐시다.** 지우면 다음 동기화에서 전량을 다시 받는다. 진실은 디스크의
// 마크다운과 허브의 DB 두 곳뿐이고, 여기는 "어디까지 맞춰 놨는가" 만 적는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { safeJoin } from '../security.ts';
import type { Vault } from '../vault.ts';

export interface MirrorEntry {
  pageId: string;
  /** Vault 기준 상대 경로. `02_NOTES/entities/acme-corp.md` */
  path: string;
  /** 허브 판본. 다음 쓰기의 If-Match 값 */
  version: number;
  /** 마지막으로 맞춰 놓은 내용의 sha256. 디스크와 비교해 보류 변경을 가려낸다 */
  hash: string;
}

export interface SyncState {
  /** `GET /changes?since=` 에 넣는 이벤트 커서 */
  cursor: number;
  /** pageId → 미러 항목 */
  pages: Record<string, MirrorEntry>;
}

const STATE_PATH = '.sb/sync/state.json';
const BASE_DIR = '.sb/sync/base';

export function emptyState(): SyncState {
  return { cursor: 0, pages: {} };
}

export async function readState(vault: Vault): Promise<SyncState> {
  try {
    const raw = JSON.parse(await fs.readFile(safeJoin(vault.root, STATE_PATH), 'utf8')) as Partial<SyncState>;
    return { cursor: Number(raw.cursor) || 0, pages: raw.pages ?? {} };
  } catch {
    return emptyState();
  }
}

/** 임시 파일에 쓰고 이름을 바꾼다 — 쓰는 중에 앱이 죽어도 반쪽 상태가 남지 않는다. */
export async function writeState(vault: Vault, state: SyncState): Promise<void> {
  const full = safeJoin(vault.root, STATE_PATH);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, full);
}

/**
 * 기준본 파일명. pageId 를 그대로 쓰지 않는다 — 허브의 pageId 는 임의 문자열이고
 * Windows 파일명 규칙(`: * ?` 금지)을 지킨다는 보장이 없다. 대응은 state.json 이 갖는다.
 */
export function baseFile(pageId: string): string {
  return `${BASE_DIR}/${createHash('sha256').update(pageId, 'utf8').digest('hex').slice(0, 32)}.md`;
}

/** 3-way 병합의 기준본. 마지막으로 허브와 맞춰 놓은 내용이다. */
export async function readBase(vault: Vault, pageId: string): Promise<string | null> {
  try {
    return await fs.readFile(safeJoin(vault.root, baseFile(pageId)), 'utf8');
  } catch {
    return null;
  }
}

export async function writeBase(vault: Vault, pageId: string, content: string): Promise<void> {
  const full = safeJoin(vault.root, baseFile(pageId));
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

export async function removeBase(vault: Vault, pageId: string): Promise<void> {
  await fs.rm(safeJoin(vault.root, baseFile(pageId)), { force: true });
}
