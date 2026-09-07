// 한국어 AI 티 결정론적 탐지기 — im-not-ai(MIT)의 quick-rules를 이식.
// 검증: 심은 패턴 54건에서 정밀도 1.000 · 재현율 1.000 · 오탐 0 (spikes/korean/validate.mjs)
// 원본: https://github.com/epoko77-ai/im-not-ai  skills/humanize-korean/references/quick-rules.md
//
// 목적은 "윤문"이 아니라 **Lint**다. 위키 페이지·질의 답변의 한국어 산문에서
// AI 티 패턴을 세어 점수를 내고, 사람이 고칠 자리를 짚는다.
// LLM을 부르지 않으므로 계산 검사(무료·즉시)에 속한다.
//
// 보호 구역: front-matter / 코드블록 / 앵커 인용 / wikilink / 표
// — 이 안의 문자열은 탐지·치환 대상이 아니다. 우리 위키의 핵심 계약이기 때문이다.

/** 탐지 대상에서 제외할 구간을 공백으로 치환한다(오프셋 보존). */
export function maskProtected(md: string): string {
  const spans: [number, number][] = [];
  const push = (re: RegExp): void => {
    for (const m of md.matchAll(re)) spans.push([m.index!, m.index! + m[0].length]);
  };
  push(/^---\r?\n[\s\S]*?\r?\n---\r?\n/gm); // YAML front-matter (문서 선두)
  push(/```[\s\S]*?```/g); // 코드블록
  push(/`[^`\n]*`/g); // 인라인 코드
  push(/\[\^[^\]]+\]:?/g); // 앵커 인용 / 각주 정의
  push(/\[\[[^\]]+\]\]/g); // wikilink
  push(/^\|.*\|$/gm); // 표 행
  push(/^\s{0,3}(?:#{1,6})\s.*$/gm); // 헤딩
  push(/https?:\/\/\S+/g); // URL
  let out = md;
  for (const [a, b] of spans) out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
  return out;
}

const paragraphs = (t: string): string[] => t.split(/\n\s*\n/).filter((p) => p.trim());
const sentences = (t: string): string[] =>
  t
    .split(/(?<=[.!?。])\s+|\n/)
    .map((s) => s.trim())
    .filter(Boolean);

const countAll = (t: string, re: RegExp): number => [...t.matchAll(re)].length;
/** 문단 단위로 임계 이상 밀집한 경우만 센다. AI 티는 빈도가 아니라 밀집이 신호다. */
const denseInParagraph = (t: string, re: RegExp, min: number): number =>
  paragraphs(t).reduce((n, p) => n + (countAll(p, re) >= min ? countAll(p, re) : 0), 0);

/* ── 규칙 ──────────────────────────────────────────────────────────────
   sev S1 = 강한 신호(잔존 0이 목표), S2 = 밀집일 때만 신호
   출처 열은 im-not-ai 원 규칙 ID.                                        */
export type Severity = 'S1' | 'S2';

export interface Rule {
  id: string;
  sev: Severity;
  name: string;
  why: string;
  fix: string;
  find: (t: string) => number;
}

export interface KoreanHit {
  id: string;
  sev: Severity;
  name: string;
  why: string;
  fix: string;
  n: number;
}

export interface KoreanReport {
  chars: number;
  s1: number;
  s2: number;
  grade: 'A' | 'B' | 'C' | 'D';
  hits: KoreanHit[];
}

export const RULES: Rule[] = [
  // A. 번역투
  { id: 'A-7', sev: 'S1', name: 'have/make 직역', why: '"~을 가지고 있다"', fix: '형용사·이중주어로 ("경쟁력을 가지고 있다"→"경쟁력이 강하다")',
    find: (t: string) => countAll(t, /[을를]\s*(?:가지고\s*있|갖고\s*있|가진다)/g) },
  { id: 'A-8', sev: 'S1', name: '이중 피동', why: '"~되어진다/~지게 된다"', fix: '단일 피동 또는 능동',
    find: (t: string) => countAll(t, /(?:되어지|되어\s*진|지게\s*되)[다는며고]/g) },
  { id: 'A-9', sev: 'S2', name: '"~에 의해" 피동', why: '행위자가 뒤로 밀림', fix: '행위자를 주어로',
    find: (t: string) => denseInParagraph(t, /에\s*의(?:해|하여)/g, 2) },
  { id: 'A-19', sev: 'S2', name: '이중 조사', why: '"~에서의/~으로의/~에의"', fix: '절로 풀어쓰기',
    find: (t: string) => countAll(t, /(?:에서의|에로의|으로의|로의|에의|으로부터의)/g) },
  { id: 'A-20', sev: 'S2', name: '"~되고 있다" 밀집', why: '진행 피동 반복', fix: '일부는 완료·단언으로',
    find: (t: string) => denseInParagraph(t, /(?:되고|지고)\s*있[다는었]/g, 3) },

  // C. 구조
  { id: 'C-8', sev: 'S1', name: '부정 대구', why: '"A가 아니라 B" — 사람 대비 9.2배(G²=41.7)', fix: '한 번만 남기고 직접 단언으로',
    find: (t: string) => countAll(t, /(?:가|이)\s*아니라|것이\s*아니라|것은\s*아니다|인가,?\s*.{1,20}인가/g) },
  { id: 'C-11', sev: 'S1', name: '연결어미 뒤 쉼표', why: '"-고, -며, -지만," — KatFish 4.84배 분리도', fix: '쉼표 제거',
    find: (t: string) => countAll(t, /(?:고|며|지만|면서|아서|어서|하여),/g) },
  { id: 'C-5', sev: 'S1', name: '이모지', why: '업무 문서에 이모지', fix: '전부 삭제',
    find: (t: string) => countAll(t, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) },
  { id: 'C-7', sev: 'S2', name: '"먼저-반면-결국" 공식', why: '문두 3단 공식', fix: '접속사 1~2개로',
    find: (t: string) => countAll(t, /^\s*(?:먼저|반면|결국|한편)[,\s]/gm) >= 3 ? countAll(t, /^\s*(?:먼저|반면|결국|한편)[,\s]/gm) : 0 },

  // D. 관용구
  { id: 'D-1', sev: 'S1', name: '결산 lexicon', why: '"결론적으로/따라서/이를 통해/요약하면"', fix: '3회 초과분 삭제',
    find: (t: string) => Math.max(0, countAll(t, /(?:결론적으로|이를\s*통해|그러므로|요약하면|정리하자면)/g) - 1) },
  { id: 'D-2', sev: 'S1', name: '의의 과장', why: '"시사하는 바가 크다/주목할 만하다"', fix: '삭제 또는 구체 결론으로',
    find: (t: string) => countAll(t, /(?:시사하는\s*바가?\s*크|주목할\s*만하|매우\s*중요하)/g) },
  { id: 'D-3', sev: 'S1', name: '열거 도입구', why: '"크게 세 가지로/다음과 같은"', fix: '도입구 없이 바로 본론',
    find: (t: string) => countAll(t, /(?:크게\s*[가-힣]+\s*가지로|다음과\s*같은|아래와\s*같이)/g) },
  { id: 'D-4', sev: 'S2', name: 'hype 어휘', why: '혁신적/획기적/압도적/전례 없는', fix: '구체 수치로 환원',
    find: (t: string) => (countAll(t, /(?:혁신적|획기적|압도적|파격적|폭발적|전례\s*없)/g) >= 3 ? countAll(t, /(?:혁신적|획기적|압도적|파격적|폭발적|전례\s*없)/g) : 0) },
  // 한국어 정규식 함정 2가지 (둘 다 검증에서 실제로 놓쳐서 발견):
  //  1) \b 는 한글 경계에서 동작하지 않는다 → 문장 종결 앵커로 교체
  //  2) 조사 이형태 — 받침 유무로 은/는이 갈린다(핵심'은' vs 문제'는'). 둘 다 받아야 한다.
  //  3) 분열문의 서술부는 연결어미 없이 바로 종결된다. 절 경계를 넘어가면 정상 문장을 오탐한다.
  { id: 'D-8', sev: 'S1', name: '분열문', why: '"중요한 것은 ~이다 / 핵심은 ~다 / 차이는 ~에 있다"', fix: '주어-서술 직결로',
    find: (t: string) => countAll(t, /(?:필요한|중요한|주목할)\s*(?:것|점)은|(?:문제|핵심|관건|답|차이|이유|원인)(?:은|는)\s*(?:(?!으므로|므로|지만|는데|면서|아서|어서|하여|거나|든지)[^.\n]){1,30}(?:이다|다|있다)[.\n]/g) },
  { id: 'D-9', sev: 'S2', name: '"결국" 결산', why: '논리 결산용 "결국" 2회+', fix: '1회만 남김',
    find: (t: string) => Math.max(0, countAll(t, /결국/g) - 1) },
  { id: 'D-10', sev: 'S1', name: '"~하는 이유다" 도치', why: '문말 도치 결산', fix: '순방향 단언으로',
    find: (t: string) => countAll(t, /(?:이유|배경|까닭)(?:다|이다)\s*[.\n]/g) },
  { id: 'D-11', sev: 'S2', name: '결말부 시간어', why: '"향후/앞으로/중장기적으로"', fix: '실제 시점으로 교체(날조 금지)',
    find: (t: string) => countAll(t, /^\s*(?:향후|앞으로|중장기적으로)/gm) },
  { id: 'D-12', sev: 'S2', name: '"과제도 남아 있다" 문패', why: '내용 없는 문패 문장', fix: '실제 과제를 첫 문장으로',
    find: (t: string) => countAll(t, /(?:과제도\s*남아|한계도\s*분명|아쉬운\s*점도)/g) },

  // F/G/H/I. 수식·완곡·접속·형식명사
  { id: 'F-5', sev: 'S2', name: '"~적 N" 추상 체인', why: '전략적 함의 / 실천적 기반', fix: '명사+명사 또는 풀어쓰기',
    find: (t: string) => (countAll(t, /[가-힣]적\s+[가-힣]{2,}/g) >= 3 ? countAll(t, /[가-힣]적\s+[가-힣]{2,}/g) : 0) },
  { id: 'G-2', sev: 'S1', name: '이중 완곡', why: '"~할 가능성이 있을 수 있다"', fix: '완곡 하나만 (극성 유지)',
    find: (t: string) => countAll(t, /(?:가능성이\s*있을\s*수\s*있|보여질\s*수\s*있|될\s*수\s*있을\s*것)/g) },
  { id: 'H-1', sev: 'S2', name: '문두 접속사 밀집', why: '한 문단에 또한/따라서/즉 3회+', fix: '절반만 남김(일괄 제거 금지)',
    find: (t: string) => denseInParagraph(t, /(?:^|[.!?]\s+)(?:또한|따라서|즉|나아가|아울러|게다가|더욱이)[,\s]/gm, 3) },
  { id: 'I-2', sev: 'S1', name: '형식명사 강조', why: '"주목할 점은 / ~라는 점에 있다"', fix: '직설로',
    find: (t: string) => countAll(t, /주목할\s*점은|라는\s*점에\s*있(?:다|으)/g) },
  { id: 'I-3', sev: 'S1', name: '"~다는 것이다" 결말', why: '형식명사 종결', fix: '"~다" 직접 종결',
    find: (t: string) => Math.max(0, countAll(t, /(?:다는|라는)\s*(?:것이다|뜻이다|의미다)/g) - 1) },

  // E. 리듬 — 결핍 신호 (im-not-ai 실측: 장문 결핍 G²=60.9)
  { id: 'E-1', sev: 'S2', name: '장문 결핍', why: '100자+ 문장 0개 — AI 8.1 vs 사람 91.3/1k(G²=60.9)', fix: '인접 문장 잇기(내용 추가 금지)',
    find: (t: string) => {
      const ss = sentences(t);
      if (ss.length < 5) return 0;
      return ss.some((s) => s.length >= 100) ? 0 : 1;
    } },
  { id: 'E-2', sev: 'S2', name: '동일 종결어미 연속', why: '같은 어미 4문장+ 연속', fix: '종결어미 다양화',
    find: (t: string) => {
      const ends = sentences(t).map((s) => (s.match(/([가-힣]{2})[.!?]?\s*$/) ?? [, ''])[1]);
      let run = 1;
      let hits = 0;
      for (let i = 1; i < ends.length; i++) {
        if (ends[i] && ends[i] === ends[i - 1]) { run++; if (run === 4) hits++; }
        else run = 1;
      }
      return hits;
    } },
];

export function detect(md: string): KoreanReport {
  const t = maskProtected(md);
  const hits = RULES.map((r) => ({ id: r.id, sev: r.sev, name: r.name, why: r.why, fix: r.fix, n: r.find(t) })).filter((h) => h.n > 0);
  const s1 = hits.filter((h) => h.sev === 'S1').reduce((a, h) => a + h.n, 0);
  const s2 = hits.filter((h) => h.sev === 'S2').reduce((a, h) => a + h.n, 0);
  // 등급: S1 잔존을 우선한다. 위키 문장은 짧아 밀집 신호(S2)가 잘 안 잡히기 때문.
  const grade = s1 === 0 ? (s2 <= 2 ? 'A' : s2 <= 4 ? 'B' : 'C') : s1 <= 2 ? 'C' : 'D';
  return { chars: t.replace(/\s/g, '').length, s1, s2, grade, hits };
}
