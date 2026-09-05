// Lint 판단 검사 4종 — LLM 이 봐야 하는 것. PLAN.md §4
//
// 계산 검사 7종(`lint/index.ts`)은 즉시 무료로 돈다. 여기 넷은 판단이 필요하다.
//
// **결과는 제안일 뿐 자동으로 고치지 않는다.** 인제스트·질의와 달리 ChangeSet 을 만들지
// 않는다 — 사람이 읽고 무엇을 할지 정한다.
//
// 위키 전체를 프롬프트에 밀어 넣지 않는다. 페이지 목록만 주고 **에이전트가 MCP 로 필요한
// 것만 당겨 간다** (PLAN.md §7.2 안 B). 200쪽을 통째로 보내면 한 번에 월 예산이 날아간다.
import type { WikiEntry } from '../wiki.ts';

export type JudgmentId = 1 | 2 | 4 | 6;

export const JUDGMENT_NAMES: Record<JudgmentId, string> = {
  1: '페이지 간 모순',
  2: '낡은 주장',
  4: '언급되지만 없는 페이지',
  6: '데이터 공백',
};

export const JUDGMENT_IDS: JudgmentId[] = [1, 2, 4, 6];

export interface JudgmentFinding {
  check: JudgmentId;
  /** 관련 위키 페이지 경로. 실재하는 것만 남는다 */
  pages: string[];
  message: string;
  /** 사람이 무엇을 하면 되는가 */
  fix: string;
}

export const JUDGMENT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          check: { type: 'integer', enum: [1, 2, 4, 6], description: '1 모순 · 2 낡은 주장 · 4 없는 페이지 · 6 데이터 공백' },
          pages: { type: 'array', items: { type: 'string' }, description: '관련 페이지 경로' },
          message: { type: 'string', description: '무엇이 문제인지 한국어 한두 문장' },
          fix: { type: 'string', description: '사람이 무엇을 하면 되는지' },
        },
        required: ['check', 'pages', 'message', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

/** 페이지 목록만 준다. 본문은 에이전트가 `get_page` 로 가져간다. */
export function judgmentPrompt(entries: readonly WikiEntry[]): string {
  const list = entries.map((e) => `- ${e.path} — ${e.page.front.title}`).join('\n');
  return `위키를 검사하라. 아래 네 가지만 본다. **도구로 읽은 것에만 근거한다.**

## 검사 항목

1. **페이지 간 모순** — 두 페이지가 같은 사실을 다르게 말한다
2. **낡은 주장** — 나중 원본이 대체한 내용이 옛 페이지에 남아 있다. \`updated\` 를 참고하라
4. **언급되지만 없는 페이지** — 여러 페이지가 가리키는데 정작 그 페이지가 없다
6. **데이터 공백** — 판단에 필요한데 위키에 없는 것. 사내에서 찾아볼 원본을 제안하라

## 위키 페이지 ${entries.length}장

${list}

## 방법

\`search\` 와 \`get_page\` 로 필요한 페이지를 읽어라. 전부 읽을 필요는 없다.
링크를 따라가야 하면 \`neighbors\` 를 쓴다.

## 규칙

- **확실한 것만 낸다.** 오탐이 하나만 있어도 사람이 검사 자체를 무시하게 된다
- \`pages\` 에는 위 목록에 있는 경로만 쓴다. 없는 경로를 쓰면 그 지적은 버려진다
- 4번은 없는 페이지의 이름을 \`message\` 에 쓰고 \`pages\` 에는 그것을 언급한 페이지를 넣는다
- 지적할 것이 없으면 findings 를 빈 배열로 낸다. 억지로 채우지 않는다`;
}

export interface ParsedJudgment {
  findings: JudgmentFinding[];
  /** 없는 페이지를 가리켜 버린 지적. 몇 건인지 사람에게 보여준다 */
  dropped: number;
  reason: string | null;
}

/**
 * 모델이 없는 경로를 지어내면 그 지적을 버린다. 4번은 예외다 —
 * 없는 페이지를 지적하는 검사라 `pages` 가 비어도 살린다.
 */
export function parseJudgment(data: unknown, knownPaths: ReadonlySet<string>): ParsedJudgment {
  const d = data as { findings?: unknown } | null;
  if (!d || !Array.isArray(d.findings)) return { findings: [], dropped: 0, reason: 'findings 가 없습니다' };

  const out: JudgmentFinding[] = [];
  let dropped = 0;
  for (const raw of d.findings as Partial<JudgmentFinding>[]) {
    const check = raw?.check;
    if (typeof check !== 'number' || !JUDGMENT_IDS.includes(check as JudgmentId)) {
      dropped++;
      continue;
    }
    if (typeof raw.message !== 'string' || !raw.message.trim() || typeof raw.fix !== 'string' || !raw.fix.trim()) {
      dropped++;
      continue;
    }
    const pages = (Array.isArray(raw.pages) ? raw.pages : []).filter((p) => typeof p === 'string' && knownPaths.has(p));
    if (pages.length === 0 && check !== 4) {
      dropped++;
      continue;
    }
    out.push({ check: check as JudgmentId, pages, message: raw.message.trim(), fix: raw.fix.trim() });
  }
  return { findings: out, dropped, reason: null };
}

/** `log.md` 에 남길 한 줄. `lint/index.ts` 의 summarize 와 같은 모양이다. */
export function summarizeJudgment(p: ParsedJudgment): string {
  const counts = new Map<JudgmentId, number>();
  for (const f of p.findings) counts.set(f.check, (counts.get(f.check) ?? 0) + 1);
  const parts = JUDGMENT_IDS.filter((id) => counts.has(id)).map((id) => `${JUDGMENT_NAMES[id]} ${counts.get(id)}건`);
  if (parts.length === 0) return p.dropped > 0 ? `지적 없음 (버린 지적 ${p.dropped}건)` : '지적 없음';
  return p.dropped > 0 ? `${parts.join(', ')} (버린 지적 ${p.dropped}건)` : parts.join(', ');
}
