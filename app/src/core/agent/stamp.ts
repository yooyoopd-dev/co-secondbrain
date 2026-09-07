// 앱이 덮어써야 하는 front-matter. M2-PLAN.md §1.1
//
// **모델은 규약 파일에 넣은 페이지 표본을 그대로 베낀다.** 2026-09-05 회수본 6건이
// 전부 `generated_by: claude-code` 와 `updated: 2026-09-05T00:00:00.000Z` 를 복사했다.
// Gemini 가 낸 페이지에도 `claude-code` 가 박혀 있었다.
//
// 이걸 두면 두 가지가 깨진다.
// - 공급자별 품질 추적(PROVIDER-ROUTING.md §8)이 거짓 값을 본다
// - 모든 페이지의 `updated` 가 같은 가짜 날짜라 "낡은 주장" 검사가 아무것도 못 잡는다
//
// 사람이 diff 로 승인하기 **전에** 고친다. 승인한 화면과 디스크에 들어간 것이 달라지면
// 관문 8 이 무의미해진다.
import { parsePage, serializePage } from '../page.ts';
import type { ChangeSet } from '../changeset.ts';
import type { ProviderId } from './types.ts';

/**
 * `updated_by` 는 건드리지 않는다. 앱이 아직 사용자 신원을 모른다 —
 * 모르는 값을 지어내는 것보다 표본의 `app` 을 두는 편이 낫다.
 */
export function stampProvider(cs: ChangeSet, provider: ProviderId, now: string = new Date().toISOString()): ChangeSet {
  // 스키마를 강제해도 `ops` 가 없는 응답이 올 수 있다. 여기서 터지면 어댑터의 catch 가
  // "CLI 를 띄우지 못했습니다" 로 잘못 보고한다. 판정은 관문에 맡기고 그대로 넘긴다.
  if (!Array.isArray(cs?.ops)) return cs;
  return {
    ...cs,
    ops: cs.ops.map((op) => {
      if (op.op === 'delete' || typeof op.content !== 'string') return op;
      let page;
      try {
        page = parsePage(op.content);
      } catch {
        return op; // 관문 1 이 잡는다. 여기서 삼키지 않는다
      }
      page.front.generatedBy = provider;
      page.front.updated = now;
      return { ...op, content: serializePage(page) };
    }),
  };
}
