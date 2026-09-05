// 승인 판정 — 어느 op 을 적용할지, 승인 버튼을 열어도 되는지.
//
// **이 파일은 Node 모듈을 쓰지 않는다.** 렌더러가 체크박스를 누를 때마다 부르기 때문이다.
// 디스크를 읽는 review.ts 를 그대로 가져오면 브라우저 번들이 node:fs 를 끌고 온다.
import type { ChangeSet } from './changeset.ts';
import type { Review } from './review.ts';

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
