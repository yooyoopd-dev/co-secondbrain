// ChangeSet — LLM 이 낸 변경안을 디스크에 적용하기 전에 통과시키는 관문.
//
// PROVIDER-ROUTING.md §6 의 근거가 되는 코드다.
// **8개 관문 중 7개가 여기(결정론적 검사)이고, 마지막 하나가 사람의 diff 승인이다.**
// 그래서 공급자를 바꿔서 나빠질 수 있는 것은 "내용의 질"이지 "형식의 안전"이 아니다.
//
// LLM 은 이 파일을 거치지 않고는 디스크에 닿을 수 없다.
import fs from 'node:fs/promises';
import { safeJoin, slugify } from './security.ts';
import { citations, pageHash, parsePage, PageParseError, SUMMARY_MAX, serializePage } from './page.ts';
import type { Vault } from './vault.ts';

export type Op = 'create' | 'update' | 'delete';

export interface ChangeOp {
  op: Op;
  /** `wiki/entities/acme-corp.md` — 아래 정규식을 지켜야 한다 */
  path: string;
  /** update·delete 는 필수. create 는 null. 낙관적 동시성의 기준 */
  baseHash: string | null;
  /** create·update 는 필수 */
  content?: string;
}

export interface ChangeSet {
  summary: string;
  /** 사람에게 물을 것. diff 검토 화면 위에 인용 블록으로 뜬다 */
  discussion?: string;
  ops: ChangeOp[];
}

/** M0 §1.4 — 모델이 지시를 무시하고 `entities/에이콤(주).md` 를 냈다.
 *  프롬프트만으로는 부족해서 스키마와 여기서 이중으로 막는다. */
export const PAGE_PATH_RE = /^wiki\/(sources|entities|concepts|synthesis)\/[a-z0-9가-힣-]+\.md$/;
export const OVERVIEW_PATH = 'wiki/overview.md';

export interface Violation {
  /** 몇 번 관문인가 */
  gate: number;
  path: string;
  reason: string;
}

export interface ApplyResult {
  applied: string[];
  /** 관문에서 막힌 것. 하나라도 있으면 아무것도 적용하지 않는다 */
  violations: Violation[];
  /** baseHash 불일치 — 3-way 병합이 필요하다 */
  conflicts: { path: string; expected: string; actual: string }[];
}

/* ------------------------------------------------------------------ *
 * 관문 1~6 — 디스크를 읽지 않고 판정할 수 있는 것
 * ------------------------------------------------------------------ */

/** 관문 1·2·3·4 — ChangeSet 구조, path 정규식, 제목 안전성, 앵커 인용 형식. */
export function validateShape(cs: ChangeSet): Violation[] {
  const v: Violation[] = [];
  if (typeof cs.summary !== 'string' || !cs.summary.trim()) {
    v.push({ gate: 1, path: '(changeset)', reason: 'summary 가 비었습니다' });
  }
  if (!Array.isArray(cs.ops) || cs.ops.length === 0) {
    v.push({ gate: 1, path: '(changeset)', reason: 'ops 가 비었습니다' });
    return v;
  }

  const seen = new Set<string>();
  for (const op of cs.ops) {
    const p = op.path;

    if (!['create', 'update', 'delete'].includes(op.op)) {
      v.push({ gate: 1, path: p, reason: `알 수 없는 op: ${op.op}` });
      continue;
    }
    if (seen.has(p)) v.push({ gate: 1, path: p, reason: '같은 경로가 두 번 나옵니다' });
    seen.add(p);

    // 관문 2 — path 정규식
    if (p !== OVERVIEW_PATH && !PAGE_PATH_RE.test(p)) {
      v.push({ gate: 2, path: p, reason: `경로 형식이 아닙니다 (${PAGE_PATH_RE.source})` });
      continue;
    }
    // 관문 3 — 파일명이 slugify 를 통과한 형태인가 (경로 탈출·예약어 방어)
    const base = p.slice(p.lastIndexOf('/') + 1, -3);
    if (slugify(base) !== base) {
      v.push({ gate: 3, path: p, reason: `파일명이 안전하지 않습니다 (기대: ${slugify(base)})` });
    }

    if (op.op === 'delete') {
      if (!op.baseHash) v.push({ gate: 1, path: p, reason: 'delete 에 baseHash 가 없습니다' });
      continue;
    }
    if (typeof op.content !== 'string' || !op.content) {
      v.push({ gate: 1, path: p, reason: `${op.op} 에 content 가 없습니다` });
      continue;
    }
    if (op.op === 'create' && op.baseHash) {
      v.push({ gate: 1, path: p, reason: 'create 에 baseHash 가 있습니다' });
    }
    if (op.op === 'update' && !op.baseHash) {
      v.push({ gate: 1, path: p, reason: 'update 에 baseHash 가 없습니다' });
    }

    // 관문 1 (계속) — 페이지가 파싱되는가
    let page;
    try {
      page = parsePage(op.content);
    } catch (e) {
      v.push({ gate: 1, path: p, reason: e instanceof PageParseError ? e.message : String(e) });
      continue;
    }

    if (page.front.summary.length > SUMMARY_MAX) {
      v.push({ gate: 1, path: p, reason: `summary 가 ${SUMMARY_MAX}자를 넘습니다` });
    }

    // 관문 4 — 주장에 출처가 붙어 있는가.
    // AMBIGUOUS 는 "불확실하다"는 표시 자체가 내용이므로 출처를 요구하지 않는다.
    for (const [i, c] of page.front.claims.entries()) {
      if (c.confidence !== 'AMBIGUOUS' && !c.source) {
        v.push({ gate: 4, path: p, reason: `claims[${i}] 에 출처가 없습니다: "${c.text.slice(0, 30)}"` });
      }
      if (c.source && !/^[a-z0-9가-힣-]+#.+$/i.test(c.source)) {
        v.push({ gate: 4, path: p, reason: `claims[${i}].source 형식 오류: ${c.source}` });
      }
    }
  }
  return v;
}

/** 관문 5 — 인용한 앵커가 실제로 존재하는가. 원본 목록을 받아 판정한다. */
export function validateAnchors(
  cs: ChangeSet,
  known: ReadonlyMap<string, ReadonlySet<string>>,
): Violation[] {
  const v: Violation[] = [];
  for (const op of cs.ops) {
    if (!op.content) continue;
    let page;
    try {
      page = parsePage(op.content);
    } catch {
      continue; // 관문 1 이 이미 잡았다
    }
    const refs = [
      ...citations(page.body),
      ...page.front.claims
        .filter((c) => c.source)
        .map((c) => {
          const [sourceId, ...rest] = c.source!.split('#');
          return { sourceId: sourceId!, locator: rest.join('#') };
        }),
    ];
    for (const r of refs) {
      const locators = known.get(r.sourceId);
      if (!locators) {
        v.push({ gate: 5, path: op.path, reason: `없는 원본을 인용했습니다: ${r.sourceId}` });
      } else if (!locators.has(r.locator)) {
        v.push({ gate: 5, path: op.path, reason: `없는 앵커를 인용했습니다: ${r.sourceId}#${r.locator}` });
      }
    }
  }
  return v;
}

/* ------------------------------------------------------------------ *
 * 관문 7 — 낙관적 동시성. 적용 직전에 디스크와 대조한다.
 * ------------------------------------------------------------------ */

/**
 * ChangeSet 을 적용한다. **하나라도 관문에 걸리면 아무것도 적용하지 않는다.**
 * 부분 적용은 위키를 중간 상태로 남겨 되돌리기를 어렵게 만든다.
 *
 * @param onSnapshot 적용 직전에 불린다. 스냅샷을 여기서 만든다.
 */
export async function applyChangeSet(
  vault: Vault,
  cs: ChangeSet,
  known: ReadonlyMap<string, ReadonlySet<string>>,
  onSnapshot?: (paths: string[]) => Promise<void>,
): Promise<ApplyResult> {
  const violations = [...validateShape(cs), ...validateAnchors(cs, known)];
  const conflicts: ApplyResult['conflicts'] = [];
  if (violations.length) return { applied: [], violations, conflicts };

  // 관문 7 — baseHash 대조. 전부 확인한 뒤에 쓴다.
  const writes: { full: string; content: string | null }[] = [];
  for (const op of cs.ops) {
    const full = safeJoin(vault.root, op.path);
    const current = await readOrNull(full);

    if (op.op === 'create') {
      if (current !== null) {
        conflicts.push({ path: op.path, expected: '(없음)', actual: pageHash(current) });
        continue;
      }
    } else {
      if (current === null) {
        conflicts.push({ path: op.path, expected: op.baseHash ?? '', actual: '(없음)' });
        continue;
      }
      const actual = pageHash(current);
      if (actual !== op.baseHash) {
        conflicts.push({ path: op.path, expected: op.baseHash ?? '', actual });
        continue;
      }
    }
    writes.push({ full, content: op.op === 'delete' ? null : (op.content ?? '') });
  }

  if (conflicts.length) return { applied: [], violations, conflicts };

  // 관문 8(사람의 승인)은 UI 가 이 함수를 부르기 전에 끝냈다고 본다.
  await onSnapshot?.(cs.ops.map((o) => o.path));

  const applied: string[] = [];
  for (const w of writes) {
    if (w.content === null) await fs.rm(w.full, { force: true });
    else {
      await fs.mkdir(w.full.slice(0, w.full.lastIndexOf('/')), { recursive: true });
      await fs.writeFile(w.full, w.content, 'utf8');
    }
  }
  for (const op of cs.ops) applied.push(op.path);
  return { applied, violations: [], conflicts: [] };
}

/** 페이지를 읽어 baseHash 를 구한다. ChangeSet 을 만들 때 LLM 에게 줄 값. */
export async function currentHash(vault: Vault, relPath: string): Promise<string | null> {
  const raw = await readOrNull(safeJoin(vault.root, relPath));
  return raw === null ? null : pageHash(raw);
}

/** 페이지 하나를 안전하게 쓴다 (사람이 UI 에서 직접 고칠 때). */
export async function writePage(vault: Vault, relPath: string, page: Parameters<typeof serializePage>[0]): Promise<void> {
  const full = safeJoin(vault.root, relPath);
  await fs.mkdir(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(full, serializePage(page), 'utf8');
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}
