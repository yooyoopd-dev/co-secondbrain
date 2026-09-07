// 시맨틱 캐시 + manifest. PLAN.md §9.1
//
// 원본 100건이 들어 있는 폴더를 다시 인제스트할 때 **바뀐 것만 CLI 로 보낸다.**
// 문서당 $0.02~$0.13 이라 100건을 통째로 다시 돌리면 월 예산의 상당 부분이 날아간다.
//
// 키는 **파일 내용의 SHA256** 이다. 파일 이름이 바뀌어도 내용이 같으면 같은 항목이고,
// 경로만 갱신하고 다시 묻지 않는다.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { safeJoin } from './security.ts';
import type { ProviderId } from './agent/types.ts';
import type { Vault } from './vault.ts';

const MANIFEST_PATH = '.sb/manifest.json';

export interface ManifestEntry {
  /** 내용 해시. 이 값이 항목의 정체다 */
  contentHash: string;
  /** 마지막으로 본 파일 이름. 바뀌면 여기만 고친다 */
  filename: string;
  sourceId: string;
  /** 변경안을 만든 시각. 아직 안 만들었으면 null */
  proposedAt: string | null;
  provider: ProviderId | null;
}

export interface Manifest {
  version: 1;
  /** 내용 해시 → 항목 */
  entries: Record<string, ManifestEntry>;
}

export const EMPTY_MANIFEST: Manifest = { version: 1, entries: {} };

export function hashContent(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 지금 Vault 에 있는 원본 하나. */
export interface SourceState {
  sourceId: string;
  filename: string;
  contentHash: string;
}

export interface WorkPlan {
  /** 처음 보는 내용. 변경안을 만들어야 한다 */
  fresh: SourceState[];
  /** 내용은 같은데 이름이 바뀌었다. 경로만 고치고 다시 묻지 않는다 */
  renamed: { from: string; to: SourceState }[];
  /** 이미 변경안을 만들었고 내용도 그대로다. 건너뛴다 */
  unchanged: SourceState[];
}

/**
 * 무엇을 CLI 로 보낼지 정한다. 순수 함수다 — 디스크를 안 본다.
 *
 * `proposedAt` 이 null 이면 내용을 알고 있어도 `fresh` 다. 인제스트만 하고 변경안을
 * 아직 안 만든 상태라 건너뛰면 그 문서는 영영 위키에 안 들어간다.
 */
export function planWork(manifest: Manifest, sources: readonly SourceState[]): WorkPlan {
  const plan: WorkPlan = { fresh: [], renamed: [], unchanged: [] };
  for (const s of sources) {
    const known = manifest.entries[s.contentHash];
    if (!known) {
      plan.fresh.push(s);
      continue;
    }
    if (known.filename !== s.filename) plan.renamed.push({ from: known.filename, to: s });
    if (known.proposedAt === null) plan.fresh.push(s);
    else if (known.filename === s.filename) plan.unchanged.push(s);
  }
  return plan;
}

/** 인제스트 직후. 아직 변경안은 없다. */
export function recordSource(m: Manifest, s: SourceState): Manifest {
  const prev = m.entries[s.contentHash];
  return {
    ...m,
    entries: {
      ...m.entries,
      [s.contentHash]: {
        contentHash: s.contentHash,
        filename: s.filename,
        sourceId: s.sourceId,
        proposedAt: prev?.proposedAt ?? null,
        provider: prev?.provider ?? null,
      },
    },
  };
}

/** 변경안을 만든 뒤. 여기서부터 건너뛸 수 있게 된다. */
export function markProposed(m: Manifest, contentHash: string, provider: ProviderId, now: string): Manifest {
  const prev = m.entries[contentHash];
  if (!prev) return m;
  return { ...m, entries: { ...m.entries, [contentHash]: { ...prev, proposedAt: now, provider } } };
}

export async function readManifest(vault: Vault): Promise<Manifest> {
  try {
    const raw = await fs.readFile(safeJoin(vault.root, MANIFEST_PATH), 'utf8');
    const m = JSON.parse(raw) as Manifest;
    // 판본이 다르면 버리고 새로 만든다. 캐시는 재생성 가능한 물건이다.
    return m.version === 1 && m.entries ? m : EMPTY_MANIFEST;
  } catch {
    return EMPTY_MANIFEST;
  }
}

/**
 * **성공했을 때만 부른다** (PLAN.md §9.1). 실행 도중 크래시가 나도 다음 실행의
 * 판단이 오염되지 않는다. 임시 파일에 쓰고 바꿔치기해서 반쪽짜리 파일을 남기지 않는다.
 */
export async function writeManifest(vault: Vault, m: Manifest): Promise<void> {
  const dest = safeJoin(vault.root, MANIFEST_PATH);
  const tmp = `${dest}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m, null, 1), 'utf8');
  await fs.rename(tmp, dest);
}
