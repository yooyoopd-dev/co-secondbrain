// MCP 읽기 전용 도구 4종. PLAN.md §7.2 안 B
//
// 에이전트가 **필요한 페이지만 당겨 간다.** 파일 복사 방식은 필요할 것 같은 페이지를
// 추측해서 밀어 넣어야 하고 안 읽힌 페이지까지 전송된다.
//
// 여기서 쓰지 않는다. 읽기만 한다 — 쓰기는 ChangeSet 과 사람의 승인을 거친다.
import { buildGraph } from '../graph.ts';
import type { Page } from '../page.ts';
import { readWikiPages, type WikiEntry } from '../wiki.ts';
import type { Vault } from '../vault.ts';
import type { ToolDef } from './server.ts';

const MAX_HITS = 20;

/** 노출 경로는 `02_NOTES/` 아래 마크다운뿐이다. 이걸 안 막으면 Vault 전체가 새 나간다. */
const READABLE = /^02_NOTES\/[a-z0-9가-힣/-]+\.md$/;

function line(e: WikiEntry): string {
  return `${e.path} — ${e.page.front.title}${e.page.front.summary ? ` · ${e.page.front.summary}` : ''}`;
}

/**
 * 페이지 단위 검색. 원본 조각 검색(FTS5 한국어 하이브리드)은 앱이 갖고 있고
 * 여기서는 위키만 본다 — 에이전트가 찾는 것은 정리된 페이지다.
 *
 * 부분 문자열로 찾는다. 위키는 페이지 수백 개 규모라 색인이 필요하지 않다.
 */
function searchPages(entries: readonly WikiEntry[], q: string): WikiEntry[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const score = (e: WikiEntry): number => {
    const f = e.page.front;
    const hay = [f.title, ...f.aliases, f.summary].join(' ').toLowerCase();
    if (hay.includes(needle)) return 2;
    if (e.page.body.toLowerCase().includes(needle)) return 1;
    return 0;
  };
  return entries
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.e.path.localeCompare(b.e.path, 'ko'))
    .slice(0, MAX_HITS)
    .map((x) => x.e);
}

/** 최단 경로. 링크 그래프는 무방향이다 (graph.ts). */
function shortestPath(pages: readonly Page[], fromId: string, toId: string): string[] | null {
  const g = buildGraph(pages);
  if (!g.hasNode(fromId) || !g.hasNode(toId)) return null;
  if (fromId === toId) return [fromId];
  const prev = new Map<string, string>();
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of g.neighbors(cur)) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      if (next === toId) {
        const out = [toId];
        for (let n = toId; prev.has(n); n = prev.get(n)!) out.unshift(prev.get(n)!);
        return out;
      }
      queue.push(next);
    }
  }
  return null;
}

const strArg = (args: Record<string, unknown>, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${key} 가 필요합니다`);
  return v.trim();
};

/**
 * Vault 하나를 읽는 도구 묶음. 호출할 때마다 디스크에서 다시 읽는다 —
 * 사람이 앱에서 승인한 변경이 바로 보여야 한다.
 */
export function wikiTools(vault: Vault): ToolDef[] {
  const load = async () => (await readWikiPages(vault)).entries;
  const byPath = (entries: readonly WikiEntry[], p: string) => entries.find((e) => e.path === p);

  return [
    {
      name: 'search',
      description: '위키 페이지를 찾는다. 제목·별칭·요약이 먼저 걸리고 본문이 다음이다.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: '찾을 말' } },
        required: ['query'],
        additionalProperties: false,
      },
      async run(args) {
        const entries = await load();
        const hits = searchPages(entries, strArg(args, 'query'));
        if (hits.length === 0) return '결과가 없습니다.';
        return hits.map(line).join('\n');
      },
    },
    {
      name: 'get_page',
      description: '페이지 전문을 그대로 돌려준다. 경로는 02_NOTES/entities/에이콤.md 형태다.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '02_NOTES/ 로 시작하는 페이지 경로' } },
        required: ['path'],
        additionalProperties: false,
      },
      async run(args) {
        const p = strArg(args, 'path');
        if (!READABLE.test(p)) throw new Error(`읽을 수 없는 경로입니다: ${p}`);
        const e = byPath(await load(), p);
        if (!e) throw new Error(`없는 페이지입니다: ${p}`);
        return `---\n${JSON.stringify(e.page.front, null, 1)}\n---\n${e.page.body}`;
      },
    },
    {
      name: 'neighbors',
      description: '이 페이지와 링크로 이어진 페이지 목록. 어디로 더 읽어야 할지 고를 때 쓴다.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      async run(args) {
        const p = strArg(args, 'path');
        const entries = await load();
        const me = byPath(entries, p);
        if (!me) throw new Error(`없는 페이지입니다: ${p}`);
        const g = buildGraph(entries.map((e) => e.page));
        if (!g.hasNode(me.page.front.id)) return '이어진 페이지가 없습니다.';
        const ids = new Set(g.neighbors(me.page.front.id));
        const out = entries.filter((e) => ids.has(e.page.front.id));
        return out.length ? out.map(line).join('\n') : '이어진 페이지가 없습니다.';
      },
    },
    {
      name: 'path',
      description: '두 페이지 사이의 최단 링크 경로. 둘이 어떻게 연결되는지 볼 때 쓴다.',
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      async run(args) {
        const entries = await load();
        const a = byPath(entries, strArg(args, 'from'));
        const b = byPath(entries, strArg(args, 'to'));
        if (!a || !b) throw new Error('없는 페이지입니다.');
        const ids = shortestPath(entries.map((e) => e.page), a.page.front.id, b.page.front.id);
        if (!ids) return '이어지는 경로가 없습니다.';
        const title = (id: string) => entries.find((e) => e.page.front.id === id)?.page.front.title ?? id;
        return ids.map(title).join(' → ');
      },
    },
  ];
}
