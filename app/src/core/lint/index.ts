// Lint 계산 검사 7종. PLAN.md §4 의 표에서 "계산" 으로 표시된 것 전부.
//
// LLM 이 필요한 4종(#1 모순 · #2 낡은 주장 · #4 없는 페이지 · #6 데이터 공백)은
// 여기 없다. 이 파일은 **LLM 없이 즉시·무료로** 도는 것만 담는다.
//
// 결과는 제안이다. 자동 수정하지 않는다 — 사람이 diff 검토에서 고른다.
import { analyze } from '../graph.ts';
import type { Page } from '../page.ts';
import { citations } from '../page.ts';
import { findDuplicates } from './dedup.ts';
import { detect } from './korean.ts';
import type { KoreanHit } from './korean.ts';

/** PLAN.md §4 Lint 표의 번호를 그대로 쓴다. 빠진 번호는 LLM 검사다. */
export type CheckId = 3 | 5 | 7 | 8 | 9 | 10 | 11;

export const CHECK_NAMES: Record<CheckId, string> = {
  3: '고아 페이지',
  5: '누락 상호참조',
  7: '출처 없는 주장',
  8: '깨진 앵커',
  9: '엔티티 중복 후보',
  10: 'AMBIGUOUS 주장',
  11: '한국어 AI 티',
};

export interface Finding {
  check: CheckId;
  /** 대상 페이지 id. 쌍(#5·#9)이면 첫 번째 쪽 */
  page: string;
  /** 쌍 검사의 상대편 */
  related?: string;
  message: string;
  /** 사람이 뭘 하면 되는지 한 줄 */
  fix: string;
}

export interface LintReport {
  findings: Finding[];
  /** 검사 번호별 건수. log.md 한 줄 요약에 쓴다 */
  counts: Record<CheckId, number>;
  /** #11 은 페이지별 등급이 따로 의미가 있어 남긴다 */
  koreanGrades: { page: string; grade: 'A' | 'B' | 'C' | 'D'; s1: number; s2: number; hits: KoreanHit[] }[];
}

/**
 * 계산 검사 7종을 한 번에 돌린다.
 *
 * @param pages   위키 페이지 전부
 * @param anchors 원본 id → 존재하는 앵커 locator 집합. `.structure.json` 에서 만든다
 */
export function lint(
  pages: readonly Page[],
  anchors: ReadonlyMap<string, ReadonlySet<string>>,
): LintReport {
  const findings: Finding[] = [];
  const g = analyze(pages);

  // #3 고아 페이지 — 그래프에서 계산한다. LLM 에게 묻지 않는다.
  for (const id of g.orphans) {
    findings.push({
      check: 3,
      page: id,
      message: '인바운드 링크가 없습니다',
      fix: '관련 페이지에서 wikilink 를 걸거나, 병합·삭제를 검토합니다',
    });
  }

  // #5 누락 상호참조 — A→B 는 있는데 B→A 가 없다
  for (const { from, to } of g.missingBacklinks) {
    findings.push({
      check: 5,
      page: to,
      related: from,
      message: `${from} 가 가리키는데 되돌아오는 링크가 없습니다`,
      fix: `${to} 본문에 [[${from}]] 를 추가할지 검토합니다`,
    });
  }

  for (const p of pages) {
    for (const [i, c] of p.front.claims.entries()) {
      // #7 출처 없는 주장. AMBIGUOUS 는 #10 이 따로 본다
      if (c.confidence !== 'AMBIGUOUS' && !c.source) {
        findings.push({
          check: 7,
          page: p.front.id,
          message: `claims[${i}] 에 출처가 없습니다: "${trim(c.text)}"`,
          fix: '앵커 인용을 붙이거나 AMBIGUOUS 로 내립니다',
        });
      }
      // #10 AMBIGUOUS 누적 — 전부 결과함으로 보낸다.
      // 임계값을 두지 않는다. 몇 건부터 문제인지 실측한 적이 없다.
      if (c.confidence === 'AMBIGUOUS') {
        findings.push({
          check: 10,
          page: p.front.id,
          message: `불확실한 주장: "${trim(c.text)}"`,
          fix: '원본을 더 넣어 확정하거나, 열린 질문으로 옮깁니다',
        });
      }
    }

    // #8 깨진 앵커 — 본문 인용과 claim.source 를 같이 본다.
    //    원본을 교체하면 슬라이드·페이지 번호가 밀려서 여기서 걸린다.
    for (const ref of allRefs(p)) {
      const locators = anchors.get(ref.sourceId);
      if (!locators) {
        findings.push({
          check: 8,
          page: p.front.id,
          message: `없는 원본을 인용합니다: ${ref.sourceId}`,
          fix: '원본을 다시 인제스트하거나 인용을 고칩니다',
        });
      } else if (!locators.has(ref.locator)) {
        findings.push({
          check: 8,
          page: p.front.id,
          message: `없는 앵커를 인용합니다: ${ref.sourceId}#${ref.locator}`,
          fix: '원본이 교체돼 번호가 밀렸을 수 있습니다. 위치를 다시 잡습니다',
        });
      }
    }
  }

  // #9 엔티티 중복 후보. 커뮤니티는 사람이 볼 참고 정보로만 붙인다 (dedup.ts 주석 참고)
  const community = new Map<string, number>();
  for (const [c, ids] of g.communities) for (const id of ids) community.set(id, c);
  const candidates = findDuplicates(
    pages
      .filter((p) => p.front.type === 'entity' || p.front.type === 'concept')
      .map((p) => ({ id: p.front.id, label: p.front.title, aliases: p.front.aliases })),
    (a, b) => community.has(a) && community.get(a) === community.get(b),
  );
  for (const d of candidates) {
    findings.push({
      check: 9,
      page: d.a,
      related: d.b,
      message: `같은 대상일 수 있습니다 (유사도 ${d.score.toFixed(3)}${d.sameCommunity ? ', 같은 커뮤니티' : ''})`,
      fix: '한쪽을 지우고 aliases 에 넣을지 검토합니다. 자동 병합하지 않습니다',
    });
  }

  // #11 한국어 AI 티 — front-matter · 코드 · 앵커 · 표는 korean.ts 가 마스킹한다
  const koreanGrades: LintReport['koreanGrades'] = [];
  for (const p of pages) {
    const r = detect(p.body);
    if (!r.hits.length) continue;
    koreanGrades.push({ page: p.front.id, grade: r.grade, s1: r.s1, s2: r.s2, hits: r.hits });
    for (const h of r.hits) {
      // S2 는 밀집일 때만 신호다. 1건짜리는 정상 문장인 경우가 많아 올리지 않는다.
      if (h.sev === 'S2' && h.n < 2) continue;
      findings.push({
        check: 11,
        page: p.front.id,
        message: `${h.id} ${h.name} ${h.n}건 — ${h.why}`,
        fix: h.fix,
      });
    }
  }

  const counts = { 3: 0, 5: 0, 7: 0, 8: 0, 9: 0, 10: 0, 11: 0 } as Record<CheckId, number>;
  for (const f of findings) counts[f.check]++;

  return { findings, counts, koreanGrades };
}

/** log.md 한 줄. `## [2026-09-04] lint   | 모순 2건, 고아 3건` 형식의 뒷부분. */
export function summarize(report: LintReport): string {
  const parts = (Object.keys(report.counts) as unknown as CheckId[])
    .map(Number)
    .filter((k): k is CheckId => report.counts[k as CheckId] > 0)
    .map((k) => `${CHECK_NAMES[k]} ${report.counts[k]}건`);
  return parts.length ? parts.join(', ') : '지적 없음';
}

function allRefs(p: Page): { sourceId: string; locator: string }[] {
  const fromClaims = p.front.claims
    .filter((c) => c.source?.includes('#'))
    .map((c) => {
      const [sourceId, ...rest] = c.source!.split('#');
      return { sourceId: sourceId!, locator: rest.join('#') };
    });
  return [...citations(p.body), ...fromClaims];
}

const trim = (s: string): string => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
