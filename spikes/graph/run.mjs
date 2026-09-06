// M0 항목 8 — 링크 그래프 분석 실측.
// 계획서 §8.1이 "JS에 Leiden이 없고 Louvain만 있는 듯한데 확실하지 않다,
// Louvain으로 충분한지 모르겠다"고 표시한 부분.
//
// npm 조회 결과: leidenalg-js / @rapideditor/leiden / louvain-community 전부 없음.
//                graphology-communities-louvain 2.0.2 만 유지보수됨. → Leiden 없음 확정.
// 남은 질문: Louvain으로 충분한가? 정답을 아는 합성 위키에 돌려서 확인한다.
import fs from 'node:fs/promises';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

/* ---------- 정답을 아는 합성 위키 ----------
   업무 위키의 실제 모양을 모사한다: 주제 클러스터 3개가 있고,
   클러스터를 가로지르는 링크가 소수 있으며, 아무도 안 가리키는 고아가 몇 장 있다. */
const TRUTH = {
  계약: ['ent-acme', 'ent-purchasing', 'con-renewal', 'con-terms', 'src-kickoff', 'src-mail-thread', 'ent-hong'],
  인프라: ['ent-datacenter', 'con-migration', 'con-capacity', 'src-arch-review', 'ent-infra-team', 'con-backup'],
  보안: ['con-access-control', 'con-audit', 'src-sec-policy', 'ent-security-team', 'con-incident'],
};
const ORPHANS = ['con-orphan-idea', 'src-stray-memo'];

const g = new Graph({ type: 'undirected' });
for (const nodes of Object.values(TRUTH)) for (const n of nodes) g.addNode(n);
for (const n of ORPHANS) g.addNode(n);

// 클러스터 내부: 조밀하게 연결
const link = (a, b) => { if (a !== b && !g.hasEdge(a, b)) g.addEdge(a, b); };
for (const nodes of Object.values(TRUTH))
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++)
      if ((i + j) % 3 !== 0) link(nodes[i], nodes[j]);   // 완전그래프는 비현실적이라 솎아냄

// 클러스터를 가로지르는 소수의 링크 = "의외의 연결"의 정답
const CROSS = [
  ['ent-acme', 'con-migration'],        // 협력사가 인프라 이관에도 등장
  ['con-audit', 'con-renewal'],         // 감사가 계약 갱신을 건드림
  ['ent-hong', 'ent-security-team'],    // 구매팀 사람이 보안팀과 연결
];
for (const [a, b] of CROSS) link(a, b);

// god node: 모든 클러스터가 참조하는 허브 1장
g.addNode('overview');
for (const nodes of Object.values(TRUTH)) for (const n of nodes.slice(0, 3)) link('overview', n);

/* ---------- 1. 커뮤니티 탐지 ---------- */
const t0 = Date.now();
const communities = louvain(g, { resolution: 1 });
const louvainMs = Date.now() - t0;

const truthOf = new Map();
for (const [name, nodes] of Object.entries(TRUTH)) for (const n of nodes) truthOf.set(n, name);

// 발견된 커뮤니티마다 정답 라벨의 최빈값을 붙이고 일치율을 본다
const found = new Map();
for (const [node, c] of Object.entries(communities)) {
  if (!found.has(c)) found.set(c, []);
  found.get(c).push(node);
}
let correct = 0;
let labeled = 0;
const labels = [];
for (const [c, nodes] of found) {
  const votes = new Map();
  for (const n of nodes) {
    const t = truthOf.get(n);
    if (t) votes.set(t, (votes.get(t) ?? 0) + 1);
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  labels.push({ community: c, size: nodes.length, label: best?.[0] ?? '(라벨없음)', purity: best ? best[1] / nodes.filter((n) => truthOf.has(n)).length : 0, nodes });
  for (const n of nodes) {
    if (!truthOf.has(n)) continue;
    labeled++;
    if (truthOf.get(n) === best?.[0]) correct++;
  }
}

/* ---------- 2. god node (연결 중심성) ---------- */
const degrees = g.nodes().map((n) => ({ node: n, degree: g.degree(n) })).sort((a, b) => b.degree - a.degree);

/* ---------- 3. 고아 페이지 (Lint #3) ---------- */
const orphansFound = g.nodes().filter((n) => g.degree(n) === 0);

/* ---------- 4. 의외의 연결 ----------
   서로 다른 커뮤니티를 잇고, 양쪽 이웃이 거의 안 겹치는 간선일수록 의외다.
   Jaccard 유사도가 낮을수록 의외성이 높다. */
const nbr = (n) => new Set(g.neighbors(n));
const jaccard = (a, b) => {
  const A = nbr(a);
  const B = nbr(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size;
  return uni ? inter / uni : 0;
};
// 허브(god node)는 모든 것과 이웃이 안 겹쳐서 무조건 의외성이 높게 나온다.
// 상위 백분위 허브를 제외해야 진짜 의외의 연결이 올라온다. (graphify의 --exclude-hubs와 동일한 이유)
const degList = g.nodes().map((n) => g.degree(n)).sort((x, y) => x - y);
const hubCut = degList[Math.floor(degList.length * 0.9)] ?? Infinity;
const isHub = (n) => g.degree(n) > hubCut;

const rank = (excludeHubs) =>
  g
    .edges()
    .map((e) => {
      const [a, b] = g.extremities(e);
      return { a, b, crossCommunity: communities[a] !== communities[b], surprise: 1 - jaccard(a, b) };
    })
    .filter((x) => x.crossCommunity && (!excludeHubs || (!isHub(x.a) && !isHub(x.b))))
    .sort((x, y) => y.surprise - x.surprise);

const surprisingRaw = rank(false);
const surprising = rank(true);

/* ---------- 5. 규모 테스트 ---------- */
function bench(nodes, edgesPerNode) {
  const big = new Graph({ type: 'undirected' });
  for (let i = 0; i < nodes; i++) big.addNode(`n${i}`);
  const clusters = 20;
  for (let i = 0; i < nodes; i++) {
    const c = i % clusters;
    for (let k = 0; k < edgesPerNode; k++) {
      const j = (Math.floor(i / clusters) * clusters + c + (k + 1) * clusters) % nodes;
      if (i !== j && !big.hasEdge(`n${i}`, `n${j}`)) big.addEdge(`n${i}`, `n${j}`);
    }
  }
  const t = Date.now();
  const res = louvain(big, { resolution: 1 });
  return { nodes, edges: big.size, ms: Date.now() - t, communities: new Set(Object.values(res)).size };
}

console.log('\n=== M0 항목 8 · 링크 그래프 분석 실측 ===\n');
console.log('--- npm 조회 결과 ---');
console.log('  leidenalg-js / @rapideditor/leiden / louvain-community  → 없음');
console.log('  graphology-communities-louvain 2.0.2                    → 있음');
console.log('  결론: JS 생태계에 Leiden 구현체 없음. Louvain이 유일한 선택.\n');

console.log(`--- 1. 커뮤니티 탐지 (${g.order}노드 ${g.size}간선, ${louvainMs}ms) ---`);
console.log(`  정답 클러스터 ${Object.keys(TRUTH).length}개 → 발견 ${found.size}개`);
for (const l of labels.sort((a, b) => b.size - a.size))
  console.log(`    [${String(l.label).padEnd(8)}] ${String(l.size).padStart(2)}장  순도 ${(l.purity * 100).toFixed(0)}%`);
console.log(`  전체 일치율: ${correct}/${labeled} = ${((correct / labeled) * 100).toFixed(1)}%`);

console.log('\n--- 2. God node (상위 5) ---');
for (const d of degrees.slice(0, 5)) console.log(`  ${d.node.padEnd(22)} 연결 ${d.degree}`);

console.log('\n--- 3. 고아 페이지 (Lint #3, LLM 없이 계산) ---');
console.log(`  정답 ${ORPHANS.length}장 → 검출 ${orphansFound.length}장: ${orphansFound.join(', ')}`);
console.log(`  ${orphansFound.length === ORPHANS.length && ORPHANS.every((o) => orphansFound.includes(o)) ? 'PASS 완전 일치' : 'FAIL'}`);

console.log('\n--- 4. 의외의 연결 (상위 5) ---');
const crossSet = new Set(CROSS.map(([a, b]) => [a, b].sort().join('|')));
for (const s of surprising.slice(0, 5)) {
  const isTruth = crossSet.has([s.a, s.b].sort().join('|'));
  console.log(`  ${(s.a + ' ↔ ' + s.b).padEnd(42)} 의외성 ${s.surprise.toFixed(3)} ${isTruth ? '★정답' : ''}`);
}
const hit = (list, k) => list.slice(0, k).filter((s) => crossSet.has([s.a, s.b].sort().join('|'))).length;
console.log(`  허브 제외 임계: 연결 ${hubCut} 초과 (제외된 노드: ${g.nodes().filter(isHub).join(', ') || '없음'})`);
console.log(`  상위 3개 중 정답 — 허브 미제외 ${hit(surprisingRaw, 3)}/${CROSS.length} vs 허브 제외 ${hit(surprising, 3)}/${CROSS.length}`);

console.log('\n--- 5. 규모별 처리 시간 ---');
for (const [n, e] of [[500, 6], [2000, 8], [10000, 10]]) {
  const r = bench(n, e);
  console.log(`  ${String(r.nodes).padStart(5)}노드 ${String(r.edges).padStart(6)}간선 → ${String(r.ms).padStart(4)}ms, 커뮤니티 ${r.communities}개`);
}

await fs.mkdir(new URL('../out/', import.meta.url).pathname, { recursive: true });
await fs.writeFile(
  new URL('../out/graph.json', import.meta.url).pathname,
  JSON.stringify({ accuracy: correct / labeled, labels, degrees: degrees.slice(0, 10), orphansFound, surprising: surprising.slice(0, 5) }, null, 1),
);
