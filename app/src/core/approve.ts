// 승인 판정 — 어느 op 을 적용할지, 승인 버튼을 열어도 되는지.
//
// **이 파일은 Node 모듈을 쓰지 않는다.** 렌더러가 체크박스를 누를 때마다 부르기 때문이다.
// 디스크를 읽는 review.ts 를 그대로 가져오면 브라우저 번들이 node:fs 를 끌고 온다.
import type { ChangeSet } from './changeset.ts';
import type { Review } from './review.ts';

/**
 * 사람이 고친 내용으로 op 하나를 바꾼다. `DESIGN-SYSTEM.md` 가 검토 카드에 둔
 * "편집 후 승인" 이다.
 *
 * **고친 내용도 관문을 다시 통과해야 한다.** 여기서는 갈아 끼우기만 하고 판정하지 않는다 —
 * 부르는 쪽이 `buildReview` 를 다시 돌려 위반과 충돌을 새로 계산한다. 편집이 관문을
 * 건너뛰는 문이 되면 관문 8 이 무의미해진다.
 *
 * `delete` 는 내용이 없으므로 그대로 둔다.
 */
export function editOp(cs: ChangeSet, path: string, content: string): ChangeSet {
  return {
    ...cs,
    ops: cs.ops.map((o) => (o.path === path && o.op !== 'delete' ? { ...o, content } : o)),
  };
}

/** 사람이 승인한 경로만 남긴다. 거부한 op 은 아예 빠진 채로 적용된다. */
export function selectOps(cs: ChangeSet, approved: readonly string[]): ChangeSet {
  const keep = new Set(approved);
  const out: ChangeSet = { summary: cs.summary, ops: cs.ops.filter((o) => keep.has(o.path)) };
  if (cs.discussion !== undefined) out.discussion = cs.discussion;
  return out;
}

/**
 * 승인 버튼을 열어도 되는가. **거부한 op 의 위반은 세지 않는다** —
 * 걸린 페이지 하나 때문에 멀쩡한 나머지를 통째로 버리게 하면 사람이 Lint 를 무시하게 된다.
 */
export function applyBlockReason(review: Review, approved: readonly string[]): string | null {
  if (review.globalViolations.length > 0) return '변경안 자체가 형식에 맞지 않습니다';
  const keep = new Set(approved);
  const picked = review.ops.filter((o) => keep.has(o.op.path));
  if (picked.length === 0) return '승인한 페이지가 없습니다';
  const bad = picked.find((o) => o.violations.length > 0 || o.conflict !== null);
  if (bad) return `${bad.title} 을 승인 목록에서 빼거나 문제를 먼저 고쳐야 합니다`;
  return null;
}

export function canApply(review: Review, approved: readonly string[]): boolean {
  return applyBlockReason(review, approved) === null;
}
