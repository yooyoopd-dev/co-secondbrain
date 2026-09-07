// 관문 8 — 사람의 diff 승인. PLAN.md §7.1, DESIGN-SYSTEM.md "Diff 검토 카드"
//
// changeset.ts 의 관문 7개는 형식만 본다. **내용이 맞는지는 사람만 판정할 수 있다.**
// 이 파일은 그 판정에 필요한 재료를 한 곳에 모은다 — 현재 문서, 제안, 줄 diff,
// 걸린 위반, 인용의 실재 여부, 주장별 신뢰도.
//
// 여기서는 디스크에 쓰지 않는다. 쓰는 건 사람이 승인한 뒤 applyChangeSet 이 한다.
import fs from 'node:fs/promises';
import { diffLines, diffStat, type DiffLine } from './diff.ts';
import { citations, pageHash, parsePage, type Claim } from './page.ts';
import { safeJoin } from './security.ts';
import {
  sourceClassification,
  validateAnchors,
  validateClassification,
  validateShape,
  type ChangeSet,
  type ChangeOp,
  type Violation,
} from './changeset.ts';
import type { Vault } from './vault.ts';

/** ChangeSet 전체에 걸린 위반은 이 경로로 표시된다 (changeset.ts) */
export const GLOBAL_PATH = '(changeset)';

export interface CitationRef {
  sourceId: string;
  locator: string;
  /** 원본에 실재하는가. false 면 칩에 취소선을 긋는다 */
  ok: boolean;
}

export interface OpReview {
  op: ChangeOp;
  /** 사람이 읽는 제목. 파싱이 안 되면 경로에서 만든다 */
  title: string;
  /** 디스크의 현재 내용. 새 페이지면 null */
  before: string | null;
  /** 제안된 내용. 삭제면 null */
  after: string | null;
  diff: DiffLine[];
  added: number;
  deleted: number;
  violations: Violation[];
  citations: CitationRef[];
  claims: Claim[];
  /**
   * 관문 7 에서 막힐 이유. null 이면 통과한다.
   * 사람이 승인 버튼을 누른 뒤에 실패하는 것보다 미리 보여 주는 편이 낫다.
   */
  conflict: string | null;
}

export interface Review {
  summary: string;
  /** 모델이 사람에게 물은 것. 카드 위에 인용 블록으로 띄운다 */
  discussion: string | null;
  ops: OpReview[];
  /** 경로에 안 걸리는 ChangeSet 전체 수준의 위반 */
  globalViolations: Violation[];
}

/** 검토 화면에 필요한 것을 전부 모은다. 디스크를 읽기만 한다. */
export async function buildReview(
  vault: Vault,
  cs: ChangeSet,
  anchors: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Review> {
  const all = [
    ...validateShape(cs),
    ...validateAnchors(cs, anchors),
    ...validateClassification(cs, await sourceClassification(vault)),
  ];
  const ops: OpReview[] = [];

  for (const op of cs.ops) {
    const before = await readOrNull(safeJoin(vault.root, op.path));
    const after = op.op === 'delete' ? null : (op.content ?? null);
    const diff = diffLines(before ?? '', after ?? '');
    const { added, deleted } = diffStat(diff);

    let title = op.path.slice(op.path.lastIndexOf('/') + 1, -3);
    let claims: Claim[] = [];
    let refs: { sourceId: string; locator: string }[] = [];
    if (after !== null) {
      try {
        const page = parsePage(after);
        title = page.front.title;
        claims = page.front.claims;
        refs = collectRefs(page);
      } catch {
        // 관문 1 이 이미 위반으로 잡았다. 여기서는 경로에서 만든 제목으로 보여준다.
      }
    }

    ops.push({
      op,
      title,
      before,
      after,
      diff,
      added,
      deleted,
      violations: all.filter((v) => v.path === op.path),
      citations: refs.map((r) => ({ ...r, ok: anchors.get(r.sourceId)?.has(r.locator) ?? false })),
      claims,
      conflict: conflictOf(op, before),
    });
  }

  return {
    summary: cs.summary,
    discussion: cs.discussion ?? null,
    ops,
    globalViolations: all.filter((v) => v.path === GLOBAL_PATH),
  };
}

/** 관문 7 을 미리 돌려 본다. applyChangeSet 과 같은 판정이다. */
function conflictOf(op: ChangeOp, before: string | null): string | null {
  if (op.op === 'create') {
    return before === null ? null : '이미 있는 페이지입니다. 다른 곳에서 먼저 만들었습니다';
  }
  if (before === null) return '고칠 페이지가 없습니다. 다른 곳에서 지웠습니다';
  const actual = pageHash(before);
  if (actual !== op.baseHash) return `제안이 만들어진 뒤 페이지가 바뀌었습니다 (${actual.slice(0, 8)})`;
  return null;
}

function collectRefs(page: ReturnType<typeof parsePage>): { sourceId: string; locator: string }[] {
  const fromBody = citations(page.body);
  const fromClaims = page.front.claims
    .filter((c) => c.source)
    .map((c) => {
      const [sourceId, ...rest] = c.source!.split('#');
      return { sourceId: sourceId!, locator: rest.join('#') };
    });
  const seen = new Set<string>();
  return [...fromBody, ...fromClaims].filter((r) => {
    const k = `${r.sourceId}#${r.locator}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export { applyBlockReason, canApply, editOp, selectOps } from './approve.ts';
