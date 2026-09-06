// 링크 그래프 분석. M0 §5 실측에서 나온 것을 그대로 구현한다.
//
// 우리는 이미 그래프를 갖고 있다 — Obsidian 호환이라 wikilink 가 그대로 간선이다.
// **새 저장 계층이 필요 없고**, 순회해서 분석만 하면 된다.
//
// Lint #3(고아)·#5(누락 상호참조)를 LLM 질의가 아니라 여기서 계산한다.
// graphology 는 CJS 이고 타입 선언이 `export default` 로 돼 있어 NodeNext 에서 기본 임포트가
// 네임스페이스로 잡힌다. 런타임에서 확인한 실제 모양에 맞춰 이름 임포트와 캐스트를 쓴다.
import { UndirectedGraph } from 'graphology';
import louvainFn from 'graphology-communities-louvain';
import type { Page } from './page.ts';
import { outboundLinks } from './page.ts';

const louvain = louvainFn as unknown as (
  graph: UndirectedGraph,
  options?: { resolution?: number; rng?: () => number },
) => Record<string, number>;

/**
 * Louvain 은 기본값이 `Math.random` 이라 같은 그래프에서도 실행마다 다른 결과를 낸다.
 * 실제로 테스트가 한 번 흔들려서 발견했다. 이건 시험 편의가 아니라 제품 요건이다 —
 * 위키가 그대로인데 "의외의 연결"과 god node 순위가 Lint 를 돌릴 때마다 바뀌면
 * 사람이 결과를 믿지 않는다.
 *
 * mulberry32. 씨앗을 고정한다.
 */
function seededRng(seed = 0x9e3779b9): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GraphNode {
  id: string;
  title: string;
  type: Page['front']['type'];
}

export interface Analysis {
  /** 커뮤니티 id → 페이지 id 목록 */
  communities: Map<number, string[]>;
  /** 연결 수 상위. "모든 게 이걸 통과한다" */
  godNodes: { id: string; degree: number }[];
  /** 인바운드 링크가 없는 페이지 (Lint #3) */
  orphans: string[];
  /** A→B 는 있는데 B→A 가 없는 쌍 (Lint #5) */
  missingBacklinks: { from: string; to: string }[];
  /** 서로 다른 커뮤니티를 잇는 의외의 연결. 허브는 제외한다 */
  surprising: { a: string; b: string; surprise: number }[];
  nodeCount: number;
  edgeCount: number;
}

/** 허브를 제외할 백분위. M0 §5.3 — 안 빼면 순위가 오염돼 정답 포착이 1/3 로 떨어진다. */
const HUB_PERCENTILE = 0.9;

/** 페이지 목록에서 링크 그래프를 만든다. 링크 대상은 페이지 id 또는 경로로 온다. */
export function buildGraph(pages: readonly Page[]): UndirectedGraph {
  const g = new UndirectedGraph();
  const byId = new Map<string, string>(); // 별칭(경로·제목) → id

  for (const p of pages) {
    if (!g.hasNode(p.front.id)) {
      g.addNode(p.front.id, { title: p.front.title, type: p.front.type });
    }
    byId.set(p.front.id, p.front.id);
    byId.set(p.front.title, p.front.id);
  }
  // `entities/acme-corp` 형태의 링크도 받는다
  for (const p of pages) {
    const slug = p.front.id.replace(/^(ent|con|src|syn)-/, '');
    byId.set(`entities/${slug}`, p.front.id);
    byId.set(`concepts/${slug}`, p.front.id);
    byId.set(`sources/${slug}`, p.front.id);
    byId.set(`synthesis/${slug}`, p.front.id);
  }

  for (const p of pages) {
    for (const link of outboundLinks(p.body)) {
      const target = byId.get(link) ?? byId.get(link.split('/').pop() ?? '');
      if (!target || target === p.front.id) continue; // 깨진 링크는 Lint 가 따로 본다
      if (!g.hasEdge(p.front.id, target)) g.addEdge(p.front.id, target);
    }
  }
  return g;
}

/** 방향 있는 링크 맵. 누락 상호참조를 보려면 방향이 필요하다. */
function directedLinks(pages: readonly Page[]): Map<string, Set<string>> {
  const ids = new Set(pages.map((p) => p.front.id));
  const alias = new Map<string, string>();
  for (const p of pages) {
    alias.set(p.front.id, p.front.id);
    alias.set(p.front.title, p.front.id);
    const slug = p.front.id.replace(/^(ent|con|src|syn)-/, '');
    for (const d of ['entities', 'concepts', 'sources', 'synthesis']) alias.set(`${d}/${slug}`, p.front.id);
  }
  const out = new Map<string, Set<string>>();
  for (const p of pages) {
    const set = new Set<string>();
    for (const l of outboundLinks(p.body)) {
      const t = alias.get(l) ?? alias.get(l.split('/').pop() ?? '');
      if (t && t !== p.front.id && ids.has(t)) set.add(t);
    }
    out.set(p.front.id, set);
  }
  return out;
}

export function analyze(pages: readonly Page[]): Analysis {
  const g = buildGraph(pages);
  const links = directedLinks(pages);

  const communities = new Map<number, string[]>();
  if (g.order > 0) {
    const assign = louvain(g, { resolution: 1, rng: seededRng() });
    for (const [node, c] of Object.entries(assign)) {
      const list = communities.get(c) ?? [];
      list.push(node);
      communities.set(c, list);
    }
  }

  const godNodes = g
    .nodes()
    .map((id) => ({ id, degree: g.degree(id) }))
    .sort((a, b) => b.degree - a.degree)
    .slice(0, 10);

  // Lint #3 — 인바운드가 0인 페이지. overview 는 진입점이라 제외한다.
  const inbound = new Map<string, number>();
  for (const targets of links.values()) for (const t of targets) inbound.set(t, (inbound.get(t) ?? 0) + 1);
  const orphans = pages
    .filter((p) => p.front.type !== 'overview' && !inbound.get(p.front.id))
    .map((p) => p.front.id);

  // Lint #5 — 한쪽만 가리키는 링크
  const missingBacklinks: Analysis['missingBacklinks'] = [];
  for (const [from, targets] of links) {
    for (const to of targets) {
      if (!links.get(to)?.has(from)) missingBacklinks.push({ from, to });
    }
  }

  return {
    communities,
    godNodes,
    orphans,
    missingBacklinks,
    surprising: findSurprising(g, communities),
    nodeCount: g.order,
    edgeCount: g.size,
  };
}

/**
 * 의외의 연결 — 서로 다른 커뮤니티를 잇고, 양쪽 이웃이 거의 안 겹치는 간선.
 *
 * ★ 허브를 제외해야 한다. 허브는 모든 것과 이웃이 안 겹쳐서 무조건 상위에 올라온다.
 *   M0 §5.3 실측: 허브 미제외 1/3 → 허브 제외 3/3.
 */
function findSurprising(g: UndirectedGraph, communities: Map<number, string[]>): Analysis['surprising'] {
  if (g.size === 0) return [];
  const community = new Map<string, number>();
  for (const [c, nodes] of communities) for (const n of nodes) community.set(n, c);

  const degrees = g.nodes().map((n) => g.degree(n)).sort((a, b) => a - b);
  const hubCut = degrees[Math.floor(degrees.length * HUB_PERCENTILE)] ?? Infinity;
  const isHub = (n: string) => g.degree(n) > hubCut;

  const jaccard = (a: string, b: string) => {
    const A = new Set(g.neighbors(a));
    const B = new Set(g.neighbors(b));
    const inter = [...A].filter((x) => B.has(x)).length;
    const uni = new Set([...A, ...B]).size;
    return uni ? inter / uni : 0;
  };

  return g
    .edges()
    .map((e) => {
      const [a, b] = g.extremities(e);
      return { a: a!, b: b!, surprise: 1 - jaccard(a!, b!) };
    })
    .filter((x) => community.get(x.a) !== community.get(x.b) && !isHub(x.a) && !isHub(x.b))
    .sort((x, y) => y.surprise - x.surprise)
    .slice(0, 10);
}
