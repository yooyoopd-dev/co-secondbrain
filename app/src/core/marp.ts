// Marp 내보내기. PLAN.md §4 Query 출력 형식
//
// 마크다운이라 추가 의존성이 없다. 차트(matplotlib)는 사내 PC 에 Python 보장이 안 돼
// v2 로 미뤘고, 슬라이드는 지금 된다.
//
// **인용을 살린다.** 슬라이드로 뽑았다고 근거가 사라지면 이 앱을 쓰는 이유가 없어진다.
import type { WikiEntry } from './wiki.ts';

export interface DeckOptions {
  title: string;
  /** 표지에 넣을 한 줄. 날짜나 작성자 */
  subtitle?: string;
  /** 슬라이드 하나에 넣을 주장 수 상한. 넘치면 잘라 낸다 */
  maxClaims?: number;
}

const DEFAULT_MAX_CLAIMS = 6;

/**
 * Marp 는 `---` 를 슬라이드 구분자로 읽는다. 페이지 본문에 그 줄이 있으면 덱이 쪼개진다.
 * 앞에 공백을 넣어 수평선으로 남기되 구분자로는 안 읽히게 한다.
 */
export function neutralizeSeparators(text: string): string {
  return text.replace(/^(\s*)(---+|\*\*\*+|___+)\s*$/gm, ' $2');
}

/** 앵커 인용을 슬라이드에서 읽히는 형태로. 각주 정의가 없으면 `[^x]` 가 그대로 나온다. */
export function inlineCitations(text: string): string {
  return text.replace(/\[\^([a-z0-9가-힣-]+#[^\]]+)\](?!:)/gi, ' `$1`');
}

/** 슬라이드에 올릴 텍스트에 항상 거는 것. 구분자 충돌과 각주 깨짐을 같이 막는다. */
function clean(text: string): string {
  return inlineCitations(neutralizeSeparators(text));
}

function slide(e: WikiEntry, maxClaims: number): string {
  const f = e.page.front;
  const lines = [`## ${f.title}`];
  if (f.summary) lines.push('', clean(f.summary));

  const claims = f.claims.slice(0, maxClaims);
  if (claims.length > 0) {
    lines.push('');
    for (const c of claims) {
      const src = c.source ? ` \`${c.source}\`` : '';
      const badge = c.confidence === 'EXTRACTED' ? '' : ` _(${c.confidence === 'AMBIGUOUS' ? '불확실' : `추론 ${c.score ?? ''}`})_`;
      lines.push(`- ${clean(c.text)}${src}${badge}`);
    }
    if (f.claims.length > claims.length) lines.push(`- _주장 ${f.claims.length - claims.length}건 더 있음_`);
  }
  if (f.openQuestions.length > 0) {
    lines.push('', '**남은 질문**', ...f.openQuestions.map((q) => `- ${clean(q)}`));
  }
  return lines.join('\n');
}

/**
 * 위키 페이지에서 슬라이드 덱을 만든다.
 *
 * 본문 산문은 넣지 않는다 — 슬라이드가 넘친다. 요약과 주장만 올리고 근거는 인용으로 남긴다.
 */
export function toMarp(entries: readonly WikiEntry[], opts: DeckOptions): string {
  const max = opts.maxClaims ?? DEFAULT_MAX_CLAIMS;
  const head = ['---', 'marp: true', 'theme: default', 'paginate: true', '---', ''].join('\n');
  const cover = [`# ${opts.title}`, ...(opts.subtitle ? ['', opts.subtitle] : [])].join('\n');
  const body = entries.map((e) => slide(e, max));
  return `${head}${[cover, ...body].join('\n\n---\n\n')}\n`;
}
