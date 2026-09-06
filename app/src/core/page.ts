// 위키 페이지 모델. PLAN.md §3 의 front-matter 계약을 코드로 옮긴 것.
//
// 디스크가 진실이다 — 페이지는 Obsidian 이 그대로 읽을 수 있는 마크다운이어야 한다.
// front-matter 는 YAML, 본문은 wikilink 와 앵커 인용을 쓴다.
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { createHash } from 'node:crypto';
import { CLASSIFICATIONS, DEFAULT_CLASSIFICATION, DOC_GENRES } from './types.ts';
import type { Classification, DocGenre } from './types.ts';

export type PageType = 'source' | 'entity' | 'concept' | 'synthesis' | 'overview';
export type Confidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

/** INFERRED 는 자유 실수가 아니라 다섯 개 중 택일이다.
 *  "0~1 사이로 매겨라"라고 하면 뭉개진 값이 나오고, 고르라고 하면 일관된다. */
export const INFERRED_SCORES = [0.95, 0.85, 0.75, 0.65, 0.55] as const;
export type InferredScore = (typeof INFERRED_SCORES)[number];

export interface Claim {
  text: string;
  /** `src-kickoff#slide-12`. AMBIGUOUS 가 아니면 반드시 있어야 한다. */
  source: string | null;
  confidence: Confidence;
  score?: InferredScore;
}

export interface PageFrontMatter {
  id: string;
  type: PageType;
  title: string;
  /** index.md 조립에 쓰인다. 300자 상한. */
  summary: string;
  /**
   * 열람 등급. 없으면 `internal` 이다 — 빠뜨렸을 때 공개로 떨어지면 실수가 유출이 된다.
   * 관문 9 가 인용한 원본보다 느슨한 등급을 막는다.
   */
  classification: Classification;
  /** 원래 문서가 무엇인가. 엔티티·개념 페이지에는 해당이 없어 null 이다 */
  docGenre: DocGenre | null;
  aliases: string[];
  tags: string[];
  claims: Claim[];
  openQuestions: string[];
  /** CO 페이지를 채택한 경우 `co://ACME/entities/acme-corp@v12` */
  derivedFrom: string | null;
  /** 어느 CLI 가 만들었는지. 공급자별 품질 추적용 (PROVIDER-ROUTING.md §8) */
  generatedBy: string | null;
  updated: string;
  updatedBy: string;
}

export interface Page {
  front: PageFrontMatter;
  body: string;
}

export const SUMMARY_MAX = 300;

/** front-matter 의 YAML 키는 스네이크가 아니라 원문 그대로 쓴다 (Obsidian Dataview 호환). */
const YAML_KEYS = {
  openQuestions: 'open_questions',
  derivedFrom: 'derived_from',
  generatedBy: 'generated_by',
  updatedBy: 'updated_by',
  docGenre: 'doc_genre',
} as const;

// 닫는 `---` 뒤의 줄바꿈은 본문에 남긴다. 여기서 먹어 버리면 읽고 다시 쓸 때마다
// 첫 줄이 바뀌어 diff 에 잡음이 낀다 — 사람이 diff 로 승인하는 구조라 그게 곧 비용이다.
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export class PageParseError extends Error {}

/** 마크다운 파일 전문을 Page 로 읽는다. front-matter 가 없거나 깨지면 던진다. */
export function parsePage(markdown: string): Page {
  const m = FM_RE.exec(markdown);
  if (!m) throw new PageParseError('front-matter 가 없습니다');

  let raw: unknown;
  try {
    raw = parseYaml(m[1] ?? '');
  } catch (e) {
    throw new PageParseError(`front-matter YAML 오류: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw === null || typeof raw !== 'object') throw new PageParseError('front-matter 가 객체가 아닙니다');
  const o = raw as Record<string, unknown>;

  const str = (k: string, required = true): string => {
    const v = o[k];
    if (typeof v === 'string') return v;
    if (!required) return '';
    throw new PageParseError(`front-matter 에 ${k} 가 없습니다`);
  };
  const arr = (k: string): string[] => {
    const v = o[k];
    if (v == null) return [];
    if (!Array.isArray(v)) throw new PageParseError(`${k} 는 배열이어야 합니다`);
    return v.map(String);
  };

  const type = str('type') as PageType;
  if (!['source', 'entity', 'concept', 'synthesis', 'overview'].includes(type)) {
    throw new PageParseError(`알 수 없는 type: ${type}`);
  }

  // 없으면 기본값을 채우고, **적혀 있는데 목록 밖이면 던진다.** 모르는 값을 조용히
  // 기본값으로 떨어뜨리면 오타 하나가 등급을 낮춘다.
  const rawClass = o['classification'];
  if (rawClass != null && !CLASSIFICATIONS.includes(rawClass as Classification)) {
    throw new PageParseError(`알 수 없는 classification: ${String(rawClass)} (${CLASSIFICATIONS.join(' / ')})`);
  }
  const rawGenre = o[YAML_KEYS.docGenre];
  if (rawGenre != null && !DOC_GENRES.includes(rawGenre as DocGenre)) {
    throw new PageParseError(`알 수 없는 doc_genre: ${String(rawGenre)} (${DOC_GENRES.join(' / ')})`);
  }

  return {
    front: {
      id: str('id'),
      type,
      title: str('title'),
      summary: str('summary', false),
      classification: (rawClass as Classification | undefined) ?? DEFAULT_CLASSIFICATION,
      docGenre: (rawGenre as DocGenre | undefined) ?? null,
      aliases: arr('aliases'),
      tags: arr('tags'),
      claims: parseClaims(o['claims']),
      openQuestions: arr(YAML_KEYS.openQuestions),
      derivedFrom: typeof o[YAML_KEYS.derivedFrom] === 'string' ? (o[YAML_KEYS.derivedFrom] as string) : null,
      generatedBy: typeof o[YAML_KEYS.generatedBy] === 'string' ? (o[YAML_KEYS.generatedBy] as string) : null,
      updated: str('updated', false) || new Date().toISOString(),
      updatedBy: str(YAML_KEYS.updatedBy, false),
    },
    body: markdown.slice(m[0].length),
  };
}

function parseClaims(v: unknown): Claim[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new PageParseError('claims 는 배열이어야 합니다');
  return v.map((c, i) => {
    if (c === null || typeof c !== 'object') throw new PageParseError(`claims[${i}] 가 객체가 아닙니다`);
    const o = c as Record<string, unknown>;
    const confidence = String(o['confidence'] ?? '') as Confidence;
    if (!['EXTRACTED', 'INFERRED', 'AMBIGUOUS'].includes(confidence)) {
      throw new PageParseError(`claims[${i}].confidence 가 잘못됨: ${confidence}`);
    }
    const claim: Claim = {
      text: String(o['text'] ?? ''),
      source: typeof o['source'] === 'string' ? o['source'] : null,
      confidence,
    };
    if (confidence === 'INFERRED') {
      const s = Number(o['score']);
      if (!(INFERRED_SCORES as readonly number[]).includes(s)) {
        throw new PageParseError(
          `claims[${i}].score 는 ${INFERRED_SCORES.join(' / ')} 중 하나여야 합니다 (받은 값: ${o['score']})`,
        );
      }
      claim.score = s as InferredScore;
    }
    return claim;
  });
}

/** Page 를 마크다운 파일 전문으로 만든다. parsePage 의 역함수. */
export function serializePage(page: Page): string {
  const f = page.front;
  const fm: Record<string, unknown> = {
    id: f.id,
    type: f.type,
    title: f.title,
    summary: f.summary.slice(0, SUMMARY_MAX),
    classification: f.classification,
    [YAML_KEYS.docGenre]: f.docGenre,
    aliases: f.aliases,
    tags: f.tags,
    claims: f.claims.map((c) => ({
      text: c.text,
      source: c.source,
      confidence: c.confidence,
      ...(c.score != null ? { score: c.score } : {}),
    })),
    [YAML_KEYS.openQuestions]: f.openQuestions,
    [YAML_KEYS.derivedFrom]: f.derivedFrom,
    [YAML_KEYS.generatedBy]: f.generatedBy,
    updated: f.updated,
    [YAML_KEYS.updatedBy]: f.updatedBy,
  };
  const body = /^\r?\n/.test(page.body) ? page.body : `\n${page.body}`;
  return `---\n${stringifyYaml(fm)}---${body}`;
}

/* ---------- 본문에서 뽑는 것들 (전부 결정론적) ---------- */

/** 앵커 인용 `[^src-kickoff#slide-12]`. 각주 정의(`[^x]:`)는 제외한다. */
export function citations(body: string): { sourceId: string; locator: string }[] {
  const out: { sourceId: string; locator: string }[] = [];
  for (const m of body.matchAll(/\[\^([a-z0-9가-힣-]+)#([^\]]+)\](?!:)/gi)) {
    out.push({ sourceId: m[1]!, locator: m[2]! });
  }
  return out;
}

/** wikilink `[[entities/acme-corp|에이콤]]` 과 상대 마크다운 링크. */
export function outboundLinks(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) out.add(m[1]!.trim());
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)]+\.md)\)/g)) out.add(m[1]!.replace(/\.md$/, '').trim());
  return [...out];
}

/** 낙관적 동시성의 기준. 파일 전문의 sha256. */
export function pageHash(markdown: string): string {
  return `sha256:${createHash('sha256').update(markdown, 'utf8').digest('hex')}`;
}

/** 빈 페이지 하나. 테스트와 새 페이지 생성에 쓴다. */
export function emptyPage(id: string, type: PageType, title: string): Page {
  return {
    front: {
      id, type, title,
      summary: '',
      aliases: [], tags: [], claims: [], openQuestions: [],
      classification: 'internal', docGenre: null,
      derivedFrom: null, generatedBy: null,
      updated: new Date().toISOString(),
      updatedBy: '',
    },
    body: `\n# ${title}\n`,
  };
}
