// 질의 → 인용 답변 → synthesis 보관. PLAN.md §4 Query
//
// 답변은 **디스크에 바로 안 쓴다.** 보관을 누르면 ChangeSet 이 되고 사람이 diff 로
// 승인해야 `synthesis/` 페이지가 된다. 질의라고 해서 관문 8 을 건너뛰지 않는다.
//
// 근거는 페이지 경로가 아니라 **앵커 인용**으로 받는다. 페이지 경로만 받으면 보관된
// synthesis 페이지의 주장에 출처가 없어 관문 4 에서 막힌다.
import { serializePage, type Claim } from './page.ts';
import { pageSlug } from './security.ts';
import type { ChangeSet } from './changeset.ts';

export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: '한국어 답변. 두세 문장' },
    claims: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '근거가 되는 사실 한 문장' },
          source: { type: 'string', description: '앵커 인용. `src-kickoff#slide-12` 형태' },
        },
        required: ['text', 'source'],
        additionalProperties: false,
      },
    },
    pages: { type: 'array', items: { type: 'string', description: '참고한 위키 페이지 경로' } },
  },
  required: ['answer', 'claims'],
  additionalProperties: false,
} as const;

export interface Answer {
  answer: string;
  claims: { text: string; source: string }[];
  pages: string[];
}

/**
 * 도구로 확인하라고 못박는다. 위키를 안 읽고 아는 대로 답하면 인용이 붙지 않는다.
 * 후보 페이지를 밀어 넣지 않는다 — 에이전트가 MCP 로 당겨 간다 (PLAN.md §7.2 안 B).
 */
export function questionPrompt(question: string): string {
  return `위키에서 찾아 답하라. **도구로 확인한 것만 쓴다.** 아는 대로 지어내지 않는다.

## 질문

${question}

## 답하는 법

1. \`search\` 로 관련 페이지를 찾는다
2. \`get_page\` 로 전문을 읽는다. 링크를 따라가야 하면 \`neighbors\` 를 쓴다
3. 페이지의 \`claims\` 에 붙은 \`source\` 를 그대로 인용에 옮긴다

근거를 못 찾으면 answer 에 "위키에서 확인하지 못했습니다" 라고 쓴다.
없는 앵커를 지어내면 보관 단계에서 전부 거부된다.`;
}

const ANCHOR_RE = /^[a-z0-9가-힣-]+#.+$/i;

/** 모델이 낸 것이 쓸 만한지 본다. 앵커 형식이 틀리면 보관 단계에서 어차피 막힌다. */
export function parseAnswer(data: unknown): { answer: Answer | null; reason: string | null } {
  const d = data as Partial<Answer> | null;
  if (!d || typeof d.answer !== 'string' || !d.answer.trim()) return { answer: null, reason: '답변이 비었습니다' };
  if (!Array.isArray(d.claims) || d.claims.length === 0) return { answer: null, reason: '근거가 없습니다' };
  for (const [i, c] of d.claims.entries()) {
    if (typeof c?.text !== 'string' || !c.text.trim()) return { answer: null, reason: `claims[${i}] 에 문장이 없습니다` };
    if (typeof c?.source !== 'string' || !ANCHOR_RE.test(c.source)) {
      return { answer: null, reason: `claims[${i}].source 가 앵커 형식이 아닙니다: ${c.source}` };
    }
  }
  return {
    answer: { answer: d.answer.trim(), claims: d.claims, pages: Array.isArray(d.pages) ? d.pages : [] },
    reason: null,
  };
}

/** 보관할 페이지의 경로. 질문에서 만든다. */
export function synthesisPath(question: string): string {
  return `wiki/synthesis/${pageSlug(question)}.md`;
}

/**
 * 보관 버튼이 부르는 것. **디스크에 쓰지 않고 ChangeSet 만 만든다** —
 * 이후는 인제스트와 같은 길(관문 7개 + 사람의 승인)을 간다.
 */
export function toChangeSet(question: string, a: Answer, now: string, updatedBy = 'app'): ChangeSet {
  const claims: Claim[] = a.claims.map((c) => ({ text: c.text, source: c.source, confidence: 'EXTRACTED' }));
  const cited = a.claims.map((c) => `${c.text}[^${c.source}]`).join('\n\n');
  const links = a.pages.length
    ? `\n\n## 참고한 페이지\n\n${a.pages.map((p) => `- [[${p.replace(/^wiki\//, '').replace(/\.md$/, '')}]]`).join('\n')}\n`
    : '\n';
  const path = synthesisPath(question);

  return {
    summary: `질의 보관 — ${question}`,
    ops: [
      {
        op: 'create',
        path,
        baseHash: null,
        content: serializePage({
          front: {
            id: `syn-${path.slice(path.lastIndexOf('/') + 1, -3)}`,
            type: 'synthesis',
            title: question,
            summary: a.answer.slice(0, 300),
            aliases: [],
            tags: [],
            claims,
            openQuestions: [],
            classification: 'internal', docGenre: null,
            derivedFrom: null,
            generatedBy: null,
            updated: now,
            updatedBy,
          },
          body: `\n# ${question}\n\n## 답변\n\n${a.answer}\n\n## 근거\n\n${cited}\n${links}`,
        }),
      },
    ],
  };
}
