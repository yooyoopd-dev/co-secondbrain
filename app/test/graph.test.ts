import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, buildGraph } from '../src/core/graph.ts';
import { emptyPage, type Page } from '../src/core/page.ts';

const page = (id: string, title: string, body: string, type: Page['front']['type'] = 'entity'): Page => {
  const p = emptyPage(id, type, title);
  p.body = body;
  return p;
};

const link = (...targets: string[]) => `\n${targets.map((t) => `[[${t}]]`).join(' ')}\n`;

test('wikilink 이 그대로 간선이 된다 — 별도 저장 계층이 없다', () => {
  const g = buildGraph([page('ent-a', '가', link('ent-b')), page('ent-b', '나', '')]);
  assert.equal(g.order, 2);
  assert.equal(g.size, 1);
  assert.ok(g.hasEdge('ent-a', 'ent-b'));
});

test('링크를 id · 제목 · 경로 세 형태로 받는다', () => {
  const pages = [
    page('ent-a', '가', link('ent-b', '다', 'entities/d')),
    page('ent-b', '나', ''),
    page('ent-c', '다', ''),
    page('ent-d', '라', ''),
  ];
  const g = buildGraph(pages);
  assert.equal(g.size, 3);
  assert.ok(g.hasEdge('ent-a', 'ent-c'), '제목으로 건 링크');
  assert.ok(g.hasEdge('ent-a', 'ent-d'), '경로로 건 링크');
});

test('없는 대상을 가리키는 링크는 간선이 되지 않는다 (Lint 가 따로 본다)', () => {
  const g = buildGraph([page('ent-a', '가', link('없는페이지'))]);
  assert.equal(g.size, 0);
});

test('자기 자신을 가리키는 링크는 무시한다', () => {
  const g = buildGraph([page('ent-a', '가', link('ent-a'))]);
  assert.equal(g.size, 0);
});

test('Lint #3 — 인바운드가 없는 페이지가 고아다', () => {
  const r = analyze([
    page('ent-a', '가', link('ent-b')),
    page('ent-b', '나', ''),
    page('ent-z', '외톨이', ''),
  ]);
  assert.deepEqual(r.orphans.sort(), ['ent-a', 'ent-z']);
});

test('Lint #3 — overview 는 진입점이라 고아로 세지 않는다', () => {
  const r = analyze([page('ov', '개요', '', 'overview'), page('ent-b', '나', '')]);
  assert.deepEqual(r.orphans, ['ent-b']);
});

test('Lint #5 — 한쪽만 가리키면 누락 상호참조다', () => {
  const r = analyze([page('ent-a', '가', link('ent-b')), page('ent-b', '나', '')]);
  assert.deepEqual(r.missingBacklinks, [{ from: 'ent-a', to: 'ent-b' }]);
});

test('Lint #5 — 양방향이면 지적하지 않는다', () => {
  const r = analyze([page('ent-a', '가', link('ent-b')), page('ent-b', '나', link('ent-a'))]);
  assert.deepEqual(r.missingBacklinks, []);
});

test('커뮤니티를 나눈다 — 두 덩어리는 두 커뮤니티', () => {
  const pages = [
    // 덩어리 1
    page('a1', 'a1', link('a2', 'a3')), page('a2', 'a2', link('a1', 'a3')), page('a3', 'a3', link('a1', 'a2')),
    // 덩어리 2
    page('b1', 'b1', link('b2', 'b3')), page('b2', 'b2', link('b1', 'b3')), page('b3', 'b3', link('b1', 'b2')),
  ];
  const r = analyze(pages);
  assert.equal(r.communities.size, 2);
  const sets = [...r.communities.values()].map((v) => v.sort().join(','));
  assert.ok(sets.includes('a1,a2,a3'), `받은 값: ${sets.join(' | ')}`);
  assert.ok(sets.includes('b1,b2,b3'), `받은 값: ${sets.join(' | ')}`);
});

test('god node — 연결 수 상위가 먼저 온다', () => {
  const pages = [
    page('hub', '허브', ''),
    ...[1, 2, 3, 4, 5].map((i) => page(`n${i}`, `n${i}`, link('hub'))),
  ];
  const r = analyze(pages);
  assert.equal(r.godNodes[0]?.id, 'hub');
  assert.equal(r.godNodes[0]?.degree, 5);
});

/* M0 §5.3 — 허브를 제외하지 않으면 의외의 연결 순위가 오염된다.
   허브는 누구와도 이웃이 안 겹쳐서 자카드 0 으로 무조건 상위를 차지한다.
   임계가 상위 백분위라서 노드가 적으면 아무도 허브가 아니다 — 그래서 17노드로 만든다. */
test('의외의 연결 — 허브 간선은 빠지고 진짜 다리가 1위다', () => {
  const ring = (prefix: string) =>
    Array.from({ length: 8 }, (_, i) =>
      page(`${prefix}${i}`, `${prefix}${i}`, link(`${prefix}${(i + 1) % 8}`, `${prefix}${(i + 7) % 8}`, 'hub')),
    );
  const pages = [...ring('a'), ...ring('b'), page('hub', '허브', '')];
  pages[0]!.body += link('b0'); // 두 고리를 잇는 유일한 다리

  const r = analyze(pages);
  assert.equal(r.godNodes[0]?.id, 'hub');
  assert.equal(r.godNodes[0]?.degree, 16);

  const pairs = r.surprising.map((s) => `${s.a}-${s.b}`);
  assert.ok(!pairs.some((p) => p.includes('hub')), `허브 간선이 남았습니다: ${pairs.join(' ')}`);
  assert.deepEqual([r.surprising[0]?.a, r.surprising[0]?.b].sort(), ['a0', 'b0']);
});

test('빈 위키에서도 죽지 않는다', () => {
  const r = analyze([]);
  assert.equal(r.nodeCount, 0);
  assert.deepEqual(r.surprising, []);
  assert.deepEqual(r.orphans, []);
});

test('같은 위키는 같은 결과를 낸다 — Louvain 기본 난수를 고정했다', () => {
  // 고정하기 전에 전체 스위트에서 한 번 흔들렸다. 위키가 그대로인데 순위가 바뀌면
  // 사람이 Lint 결과를 믿지 않는다.
  const ring = (prefix: string) =>
    Array.from({ length: 8 }, (_, i) =>
      page(`${prefix}${i}`, `${prefix}${i}`, link(`${prefix}${(i + 1) % 8}`, `${prefix}${(i + 7) % 8}`, 'hub')),
    );
  const build = () => {
    const pages = [...ring('a'), ...ring('b'), page('hub', '허브', '')];
    pages[0]!.body += link('b0');
    return pages;
  };
  const key = () => {
    const r = analyze(build());
    return JSON.stringify({
      c: [...r.communities.entries()].sort(),
      g: r.godNodes.map((x) => x.id),
      s: r.surprising.map((x) => `${x.a}-${x.b}`),
    });
  };
  const first = key();
  for (let i = 0; i < 30; i++) assert.equal(key(), first, `${i + 1}회차에서 결과가 달라졌습니다`);
});
