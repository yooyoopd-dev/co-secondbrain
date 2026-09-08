// 위키 임베딩 보관. `.sb/` 아래라 동기화도 Obsidian 도 안 본다.
//
// **다시 만들 수 있는 캐시다.** 지워도 손실이 없고, 다만 다시 만드는 데 시간이 든다 —
// 사내 실측에서 청크당 시간이 크게 나왔으므로 (docs/LOCAL-LLM.md §7 · ROADMAP §20)
// 본문이 그대로인 청크의 벡터는 반드시 재사용한다. 그 재사용을 위해 해시를 같이 적는다.
//
// 두 파일로 나눈다. 벡터를 JSON 에 넣으면 5,000 청크가 수십 MB 짜리 텍스트가 되고
// 켤 때마다 그것을 파싱하게 된다. 숫자는 이진 파일에, 이름은 JSON 에 둔다.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { safeJoin } from '../security.ts';
import type { Vault } from '../vault.ts';

const JSON_PATH = '.sb/wiki-vectors.json';
const BIN_PATH = '.sb/wiki-vectors.bin';

export interface VectorEntry {
  /** 청크 본문의 해시. 본문이 바뀌면 이 벡터는 못 쓴다 */
  hash: string;
  vec: Float32Array;
}

export interface VectorStore {
  /** 어느 모델로 만들었나. 모델이 바뀌면 전부 다시 만들어야 한다 */
  model: string;
  dim: number;
  entries: Map<string, VectorEntry>;
}

export function chunkHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

interface Meta {
  version: 1;
  model: string;
  dim: number;
  keys: { key: string; hash: string }[];
}

/** 없거나 깨졌으면 null. 캐시가 없는 것은 오류가 아니다 */
export async function readVectors(vault: Vault): Promise<VectorStore | null> {
  try {
    const meta = JSON.parse(await fs.readFile(safeJoin(vault.root, JSON_PATH), 'utf8')) as Meta;
    if (meta.version !== 1 || !Number.isInteger(meta.dim) || meta.dim <= 0) return null;
    const bin = await fs.readFile(safeJoin(vault.root, BIN_PATH));
    if (bin.length !== meta.keys.length * meta.dim * 4) return null;
    const entries = new Map<string, VectorEntry>();
    for (const [i, k] of meta.keys.entries()) {
      const off = i * meta.dim * 4;
      // Buffer 는 풀에서 잘라 오므로 byteOffset 을 반드시 넘겨야 한다
      const vec = new Float32Array(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + meta.dim * 4));
      entries.set(k.key, { hash: k.hash, vec });
    }
    return { model: meta.model, dim: meta.dim, entries };
  } catch {
    return null;
  }
}

export async function writeVectors(vault: Vault, store: VectorStore): Promise<void> {
  const keys = [...store.entries.entries()];
  const meta: Meta = {
    version: 1,
    model: store.model,
    dim: store.dim,
    keys: keys.map(([key, e]) => ({ key, hash: e.hash })),
  };
  const bin = Buffer.alloc(keys.length * store.dim * 4);
  for (const [i, [, e]] of keys.entries()) {
    Buffer.from(e.vec.buffer, e.vec.byteOffset, store.dim * 4).copy(bin, i * store.dim * 4);
  }
  await fs.writeFile(safeJoin(vault.root, JSON_PATH), JSON.stringify(meta), 'utf8');
  await fs.writeFile(safeJoin(vault.root, BIN_PATH), bin);
}

/** 모델을 바꿨거나 캐시가 없으면 빈 것에서 시작한다 */
export function reusable(prev: VectorStore | null, model: string): VectorStore {
  if (prev && prev.model === model) return prev;
  return { model, dim: 0, entries: new Map() };
}
