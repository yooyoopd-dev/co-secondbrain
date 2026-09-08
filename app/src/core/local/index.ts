// 로컬 질의 경로의 순수 계산. HTTP 는 `ollama.ts` 가 한다.
//
// 흐름은 `docs/LOCAL-LLM.md` §2.2 다.
//
//   질문 → 위키 청크를 BM25 와 임베딩으로 각각 뽑는다 → RRF 로 합친다
//        → 상위 k 개를 프롬프트에 넣는다 → 한 번 부른다 → 관문
//
// **임계값을 만들지 않는다.** BM25 점수와 코사인 유사도는 단위가 달라서 가중합을 하려면
// 상수를 둘 정해야 하는데, 이 프로젝트는 그렇게 들여온 상수에 두 번 데었다
// (CLAUDE.md §5). RRF 는 순위만 보므로 조율할 것이 `K` 하나뿐이다.
import { citations, type Page } from '../page.ts';
import type { WikiEntry } from '../wiki.ts';

/** RRF 의 감쇠 상수. 원 논문(Cormack 2009)의 값이고 여기서 재보정하지 않았다 */
export const RRF_K = 60;

/** 모델에게 넣는 청크 수. 늘리면 답이 좋아지는 대신 로컬 모델이 느려진다 */
export const TOP_K = 8;

/** 자를 때 목표 길이. 문단을 쪼개지 않으므로 넘길 수 있다 */
const TARGET_CHARS = 700;

/** 위키 청크 하나. 임베딩과 BM25 가 같은 것을 가리킨다 */
export interface WikiChunk {
  /** `02_NOTES/entities/acme-corp.md#3` — 벡터 파일과 짝을 맞추는 열쇠 */
  key: string;
  /** Vault 기준 페이지 경로 */
  path: string;
  /** 페이지 제목. 프롬프트의 머리로 붙는다 */
  title: string;
  text: string;
}

/**
 * 페이지를 문단 묶음으로 자른다.
 *
 * **문단 안에서 자르지 않는다.** 앵커 인용 `[^src-x#loc]` 은 문장 끝에 붙으므로
 * 문단 중간을 자르면 인용이 그 문장에서 떨어져 나간다. 그러면 모델이 출처를 못 붙이고,
 * 붙이더라도 엉뚱한 것을 붙인다 (docs/LOCAL-LLM.md §3.2).
 */
export function chunkPage(path: string, page: Page): WikiChunk[] {
  const title = page.front.title;
  const paras = page.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const out: WikiChunk[] = [];
  let buf: string[] = [];
  let len = 0;
  const flush = () => {
    if (!buf.length) return;
    out.push({ key: `${path}#${out.length}`, path, title, text: buf.join('\n\n') });
    buf = [];
    len = 0;
  };
  for (const p of paras) {
    buf.push(p);
    len += p.length;
    if (len >= TARGET_CHARS) flush();
  }
  flush();

  // 본문이 비고 front-matter 만 있는 페이지도 검색에 걸려야 한다
  if (out.length === 0 && page.front.summary.trim()) {
    out.push({ key: `${path}#0`, path, title, text: page.front.summary.trim() });
  }
  return out;
}

/** 위키 전체를 청크로. 순서는 `readWikiPages` 가 준 순서 그대로다 */
export function chunkWiki(entries: readonly WikiEntry[]): WikiChunk[] {
  return entries.flatMap((e) => chunkPage(e.path, e.page));
}

/**
 * 순위만 보고 합친다.
 *
 * `score(d) = Σ 1/(K + rank(d))`. 한쪽에만 걸린 것도 살아남는다 —
 * 고유명사는 BM25 가, 바꿔 말한 질문은 임베딩이 잡는다.
 */
export function rrf(lists: readonly (readonly string[])[], k = RRF_K): { key: string; score: number }[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    for (const [i, key] of list.entries()) {
      score.set(key, (score.get(key) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...score.entries()]
    .map(([key, s]) => ({ key, score: s }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

/** 길이를 1 로 맞춘다. 저장할 때 한 번 해 두면 질의는 내적만 하면 된다 */
export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

/** 둘 다 정규화돼 있다고 본다. 아니면 값이 1 을 넘을 수 있다 */
export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * 질의 벡터에 가까운 순서로 열쇠를 돌려준다.
 *
 * 벡터 데이터베이스를 안 쓴다. 5,000 청크 × 1,024 차원이면 512만 회 곱셈이라
 * 자바스크립트에서 한 자릿수 밀리초다. 네이티브 확장을 들이면 포터블 exe 하나로
 * 끝나던 배포가 깨진다 (docs/LOCAL-LLM.md §3.4).
 */
export function nearest(q: Float32Array, vectors: ReadonlyMap<string, Float32Array>, limit: number): string[] {
  const scored: { key: string; s: number }[] = [];
  for (const [key, v] of vectors) {
    if (v.length !== q.length) continue;
    scored.push({ key, s: dot(q, v) });
  }
  scored.sort((a, b) => b.s - a.s || a.key.localeCompare(b.key));
  return scored.slice(0, limit).map((x) => x.key);
}

/**
 * 넣어 준 청크에 실제로 있는 앵커. 답이 이것 밖을 인용하면 지어낸 것이다.
 *
 * MCP 로 당겨 가는 경로에서는 무엇을 읽었는지 앱이 모르므로 관문 5 가 Vault 전체를
 * 놓고 판정한다. 여기서는 앱이 준 것을 알기 때문에 **훨씬 좁게 잡을 수 있다.**
 */
export function allowedAnchors(chunks: readonly WikiChunk[]): Set<string> {
  const out = new Set<string>();
  for (const c of chunks) for (const a of citations(c.text)) out.add(`${a.sourceId}#${a.locator}`);
  return out;
}

/**
 * 로컬 모델에게 주는 프롬프트. 도구 이야기를 안 한다 — 부를 도구가 없다.
 */
export function localPrompt(question: string, chunks: readonly WikiChunk[], core = ''): string {
  const body = chunks
    .map((c, i) => `### 조각 ${i + 1} — ${c.title}\n\n${c.text}`)
    .join('\n\n');
  return `아래 위키 조각만 보고 답하라. **조각에 없는 것은 모른다고 한다.**
${core ? `\n${core}` : ''}
## 위키 조각

${body}

## 질문

${question}

## 답하는 법

1. 주장마다 그 주장이 나온 조각의 대괄호 안 앵커를 \`source\` 에 그대로 옮긴다
2. 조각에 없는 앵커를 적으면 답 전체가 거부된다. 지어내지 않는다
3. 근거를 못 찾으면 answer 에 "위키에서 확인하지 못했습니다" 라고 쓴다`;
}

/**
 * 질문을 색인에 물어볼 낱말로 가른다.
 *
 * 문장 하나를 통째로 FTS 에 넣으면 구(phrase) 매칭이라 거의 안 걸린다. 그래서 낱말로
 * 가른다. 색인이 **접두 매칭**이므로 조사가 붙은 채로도 어절 앞부분은 잡히지만,
 * "갱신일은" 으로 물으면 "갱신일이" 가 안 걸린다. 그래서 아는 조사만 떼어 낸 것도 같이 넣는다.
 *
 * **뗀 것이 틀려도 손해가 없다.** 결과를 RRF 로 합치므로 헛짚은 낱말은 빈 목록을
 * 보태고 끝난다. 임계값으로 거르는 구조였다면 이렇게 못 한다 (CLAUDE.md §7).
 */
const PARTICLES = [
  '에서의', '으로부터', '에게서', '에서', '으로', '에게', '한테', '까지', '부터', '보다', '처럼',
  '은', '는', '이', '가', '을', '를', '의', '에', '로', '와', '과', '도', '만',
];

export function queryTerms(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if ([...t].length < 2 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const raw of question.split(/[^0-9A-Za-z가-힣]+/)) {
    if (!raw) continue;
    add(raw);
    for (const p of PARTICLES) {
      if (!raw.endsWith(p)) continue;
      add(raw.slice(0, raw.length - p.length));
      break;
    }
  }
  return out;
}
