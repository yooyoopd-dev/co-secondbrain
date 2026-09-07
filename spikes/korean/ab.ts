// 한국어 작문 규칙 A/B 재측정. docs/ROADMAP.md 9번, PLAN.md §9.6
//
// 질문: `09_TEMPLATES/AGENTS.md` 의 "한국어 작문" 절이 실제로 산출물의 AI 티를 줄이는가.
// M0 에서는 표본이 작아 판단을 미뤘다. 여기서 팔당 20건으로 다시 잰다.
//
// 방법: 같은 원본 20건을 두 번 돌린다. A 는 작문 규칙을 뺀 규약, B 는 넣은 규약.
// 산출된 페이지의 `summary` 와 본문을 `detect.mjs` 로 채점한다.
//
// 한계 (CLAUDE.md §9):
// - 원본이 합성이다. 실제 사내 문서의 길이·잡음을 재지 못한다
// - 팔마다 한 세션으로 배치를 돌린다 (`--resume`). 뒤쪽 문서가 앞 문서의 출력을 보므로
//   팔 안에서 문체가 수렴할 수 있다. 비용 때문에 감수한 설계다
// - 모델 하나(claude-sonnet-5)만 본다. Gemini 는 비용을 보고하지 않아 따로 잰다
import fs from 'node:fs/promises';
import { serializePage, parsePage } from '../../app/src/core/page.ts';
import { CHANGESET_SCHEMA } from '../../app/src/core/agent/schema.ts';
import { createClaudeCode } from '../../app/src/core/agent/claude-code.ts';
import { prepareWorkdir, disposeWorkdir } from '../../app/src/core/agent/workdir.ts';
import { runBatch, type BatchItem } from '../../app/src/core/agent/batch.ts';
import type { ChangeSet } from '../../app/src/core/changeset.ts';
// @ts-expect-error 스파이크 스크립트라 선언 파일을 두지 않는다
import { detect } from './detect.mjs';

const RULES = `
## 한국어 작문

- "~을 가지고 있다" 금지 → "경쟁력이 강하다"
- 이중 피동 "~되어진다" 금지
- 분열문 "핵심은 ~다" 금지 → 주어-서술 직결
- 부정 대구 "A가 아니라 B" 문서당 1회 이하
- 연결어미 뒤 쉼표("~하고, ~하며,") 금지
- "결론적으로 / 이를 통해 / 요약하면" 문서당 1회 이하
- 이모지 금지
`;

const TEMPLATE = serializePage({
  front: {
    id: 'ent-example', type: 'entity', title: '보기', summary: '한 줄 요약.', aliases: [], tags: [],
    claims: [{ text: '주장 한 문장.', source: 'src-example#p-1', confidence: 'EXTRACTED' }],
    openQuestions: [], derivedFrom: null, generatedBy: 'claude-code',
    updated: '2026-09-05T00:00:00.000Z', updatedBy: 'app',
  },
  body: '\n# 보기\n\n## 개요\n\n두세 문장으로 정리한 글.\n\n## 주장\n\n주장 한 문장.[^src-example#p-1]\n',
});

const convention = (withRules: boolean) => `# 위키 규약

- 모든 주장에 앵커 인용을 붙인다. 출처 없는 문장은 쓰지 않는다
- 본문에 \`## 개요\` 를 두고 **두세 문장으로 직접 정리해 쓴다.** 원문을 그대로 옮기지 않는다
- confidence 는 EXTRACTED · INFERRED · AMBIGUOUS 중 하나
${withRules ? RULES : ''}
## 페이지 형식

\`\`\`markdown
${TEMPLATE}\`\`\`
`;

/** 합성 원본 20건. 모델이 요약을 직접 써야 하도록 사실을 여러 개 준다. */
const ORGS = [
  ['에이콤', '협력사 선정'], ['베타테크', '납품 지연'], ['세종회계', '4분기 감사'],
  ['델타물류', '운송 단가 인상'], ['오메가시스템', 'ERP 유지보수'], ['한빛소재', '원자재 수급'],
  ['미래설비', '설비 교체'], ['정우엔지니어링', '설계 변경'], ['대성화학', '품질 이슈'],
  ['신원테크', '라이선스 갱신'],
] as const;
const ANGLES = ['킥오프 회의록', '분기 보고'] as const;

const CASES = ORGS.flatMap(([org, topic], i) =>
  ANGLES.map((angle, j) => {
    const id = `src-${i}-${j}`;
    const n = i * 2 + j;
    return {
      id,
      chunks: [
        [`p-1`, `${org}의 ${topic} 건이 2026년 ${3 + (n % 9)}월 검토 대상으로 올라왔다.`],
        [`p-2`, `담당 부서는 ${['구매', '개발', '품질', '재무'][n % 4]}팀이고 결정 기한은 2026-${String(6 + (n % 6)).padStart(2, '0')}-30 이다.`],
        [`p-3`, `직전 계약 대비 비용이 ${5 + (n % 20)}퍼센트 ${n % 2 ? '올랐다' : '내렸다'}.`],
        [`p-4`, `${angle}에서 ${['재검토', '조건부 승인', '보류'][n % 3]}로 정리됐다.`],
      ] as [string, string][],
      org,
    };
  }),
);

function promptFor(c: (typeof CASES)[number]): string {
  return `아래 원본에서 엔티티 페이지 하나를 만들어라. 도구는 쓸 수 없다.

## 원본 ${c.id}

${c.chunks.map(([loc, t]) => `- ${loc}: ${t}`).join('\n')}

## 쓸 수 있는 앵커

${c.chunks.map(([loc]) => `${c.id}#${loc}`).join(' · ')}

제목은 ${c.org} 이고 path 는 02_NOTES/entities/e${c.id.replace(/[^0-9]/g, '')}.md 다.
\`## 개요\` 절에 두세 문장으로 직접 정리해 써라.`;
}

async function arm(label: string, withRules: boolean) {
  const wd = await prepareWorkdir({ 'CLAUDE.md': convention(withRules) });
  const items: BatchItem[] = CASES.map((c) => ({ id: c.id, prompt: promptFor(c) }));
  const rep = await runBatch(createClaudeCode(), items, CHANGESET_SCHEMA, { workdir: wd.root });
  await disposeWorkdir(wd);

  const scores: { id: string; s1: number; s2: number; grade: string; hits: string[] }[] = [];
  let failed = 0;
  for (const o of rep.outcomes) {
    if (!o.result.ok) {
      failed++;
      continue;
    }
    for (const op of (o.result.data as ChangeSet).ops) {
      if (!op.content) continue;
      let page;
      try {
        page = parsePage(op.content);
      } catch {
        failed++;
        continue;
      }
      const r = detect(`${page.front.summary}\n\n${page.body}`);
      scores.push({ id: o.id, s1: r.s1, s2: r.s2, grade: r.grade, hits: r.hits.map((h: { id: string; n: number }) => `${h.id}x${h.n}`) });
    }
  }
  const sum = (f: (x: (typeof scores)[number]) => number) => scores.reduce((a, x) => a + f(x), 0);
  const byRule = new Map<string, number>();
  for (const s of scores) for (const h of s.hits) {
    const [id, n] = h.split('x');
    byRule.set(id!, (byRule.get(id!) ?? 0) + Number(n));
  }
  console.log(`\n[${label}] 페이지 ${scores.length}건 · 실패 ${failed}건 · $${rep.usage.costUsd.toFixed(4)} · 콜드 ${rep.coldRuns}회`);
  console.log(`  S1 합계 ${sum((x) => x.s1)} (평균 ${(sum((x) => x.s1) / (scores.length || 1)).toFixed(2)})`);
  console.log(`  S2 합계 ${sum((x) => x.s2)} (평균 ${(sum((x) => x.s2) / (scores.length || 1)).toFixed(2)})`);
  const grades = ['A', 'B', 'C', 'D'].map((g) => `${g}=${scores.filter((s) => s.grade === g).length}`);
  console.log(`  등급 ${grades.join(' ')}`);
  console.log(`  규칙별 ${[...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(' ') || '없음'}`);
  return { label, scores, cost: rep.usage.costUsd, s1: sum((x) => x.s1), s2: sum((x) => x.s2) };
}

console.log(`원본 ${CASES.length}건 × 2팔`);
const a = await arm('A 규칙 없음', false);
const b = await arm('B 규칙 있음', true);

console.log('\n===== 결과 =====');
const per = (x: typeof a, f: 'ok') => (x.scores.length || 1);
console.log(`A 규칙 없음  S1/페이지 ${(a.s1 / per(a, 'ok')).toFixed(2)}  S2/페이지 ${(a.s2 / per(a, 'ok')).toFixed(2)}`);
console.log(`B 규칙 있음  S1/페이지 ${(b.s1 / per(b, 'ok')).toFixed(2)}  S2/페이지 ${(b.s2 / per(b, 'ok')).toFixed(2)}`);
console.log(`총 비용 $${(a.cost + b.cost).toFixed(4)}`);
const better = b.s1 / per(b, 'ok') < a.s1 / per(a, 'ok');
console.log(better ? '\n규칙이 S1 을 줄였다' : '\n규칙이 S1 을 줄이지 못했다 — 결과를 그대로 적는다');
await fs.writeFile(
  new URL('../out/ab-result.json', import.meta.url),
  JSON.stringify({ at: new Date().toISOString(), a, b }, null, 1),
  'utf8',
);
