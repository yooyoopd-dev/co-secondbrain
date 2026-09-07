// 사람이 "이 둘은 다른 대상이다" 라고 한 것을 기억한다. ROADMAP.md §14
//
// **임계를 만지는 것보다 이것이 먼저다.** 거부가 쌓이기 전에 숫자만 흔들면 근거가 없다.
// 거부 하나가 곧 오병합 표본 하나라, 쓰다 보면 W5 를 따로 잴 필요가 없어진다.
//
// 자리는 `.sb/` 아래다. 동기화는 `02_NOTES/` 만 올리므로(sync/engine.ts `scanLocal`)
// **CO 영역에서도 이 파일은 동료에게 안 간다.** 이름이 들어 있고 개인의 판단이라 그게 맞다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from '../security.ts';
import type { Vault } from '../vault.ts';
import { normalizeLabel } from './dedup.ts';

export const REJECTED_PATH = '.sb/dedup-rejected.json';

export interface RejectedPair {
  /** 사람이 보던 그대로의 이름. 파일을 열어 보고 "왜 이게 안 뜨지" 를 알 수 있어야 한다 */
  a: string;
  b: string;
  at: string;
}

/**
 * 쌍 하나의 열쇠. **정규화한 뒤 사전순으로 세운다** — 표기가 조금 달라져도, 어느 쪽을
 * 먼저 골랐어도 같은 거부로 잡힌다.
 *
 * `normalizeLabel` 이 공백을 전부 지우므로 탭을 구분자로 써도 안전하다.
 */
export function rejectionKey(a: string, b: string): string {
  return [normalizeLabel(a), normalizeLabel(b)].sort().join('\t');
}

/** 거부 목록. 열쇠 집합이라 `findDuplicates` 가 그대로 받는다. */
export type Rejections = ReadonlySet<string>;

export const NO_REJECTIONS: Rejections = new Set<string>();

/**
 * 읽는다. **없거나 깨졌으면 빈 것으로 본다** — 이 파일 때문에 Lint 가 안 도는 편이
 * 거부를 한두 개 잃는 것보다 나쁘다.
 */
export async function readRejected(vault: Vault): Promise<RejectedPair[]> {
  try {
    const raw = await fs.readFile(safeJoin(vault.root, REJECTED_PATH), 'utf8');
    const j: unknown = JSON.parse(raw);
    const list = (j as { rejected?: unknown })?.rejected;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (x): x is RejectedPair =>
        typeof (x as RejectedPair)?.a === 'string' && typeof (x as RejectedPair)?.b === 'string',
    );
  } catch {
    return [];
  }
}

export function toKeys(pairs: readonly RejectedPair[]): Rejections {
  return new Set(pairs.map((p) => rejectionKey(p.a, p.b)));
}

async function write(vault: Vault, pairs: readonly RejectedPair[]): Promise<void> {
  const full = safeJoin(vault.root, REJECTED_PATH);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, `${JSON.stringify({ version: 1, rejected: pairs }, null, 1)}\n`, 'utf8');
}

/** 거부를 더한다. 같은 쌍을 두 번 눌러도 하나로 남는다. */
export async function reject(vault: Vault, a: string, b: string, now = new Date()): Promise<RejectedPair[]> {
  const pairs = await readRejected(vault);
  const key = rejectionKey(a, b);
  if (pairs.some((p) => rejectionKey(p.a, p.b) === key)) return pairs;
  const next = [...pairs, { a, b, at: now.toISOString() }];
  await write(vault, next);
  return next;
}

/** 거부를 무른다. 잘못 눌렀을 때 파일을 손으로 고치게 하면 안 된다. */
export async function unreject(vault: Vault, a: string, b: string): Promise<RejectedPair[]> {
  const pairs = await readRejected(vault);
  const key = rejectionKey(a, b);
  const next = pairs.filter((p) => rejectionKey(p.a, p.b) !== key);
  if (next.length !== pairs.length) await write(vault, next);
  return next;
}
