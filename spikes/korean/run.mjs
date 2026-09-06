import fs from 'node:fs/promises';
import { detect, maskProtected } from './detect.mjs';

const SCRATCH = '/tmp/claude-0/-home-user-co-secondbrain/45fa23d7-75b0-5e63-a575-7616998a14db/scratchpad/m0';
const read = async (p) => { try { return await fs.readFile(p, 'utf8'); } catch { return null; } };

/* ---------- 보호 구역 마스킹 검증 ---------- */
const PROTECTED_SAMPLE = `---
id: ent-acme
title: 에이콤(주)
summary: 결론적으로 이를 통해 중요한 것은 협력사다.
---

# 에이콤(주)

에이콤은 주 협력사가 아니라 유일한 공급사다. [^src-kickoff#slide-12]
관련: [[concepts/contract-renewal|계약 갱신]]

| 항목 | 값 |
|---|---|
| 결론적으로 | 이를 통해 |

\`\`\`
결론적으로 이를 통해 중요한 것은 코드다.
\`\`\`
`;

console.log('\n=== 한국어 AI 티 탐지 · 보호 구역 검증 ===\n');
const masked = maskProtected(PROTECTED_SAMPLE);
const leaked = ['id: ent-acme', '[^src-kickoff', '[[concepts/', '| 결론적으로 |', '코드다'];
let ok = 0;
for (const s of leaked) {
  const gone = !masked.includes(s);
  if (gone) ok++;
  console.log(`  ${gone ? 'OK  ' : 'FAIL'} 마스킹: ${JSON.stringify(s)}`);
}
const bodyKept = masked.includes('주 협력사가 아니라');
console.log(`  ${bodyKept ? 'OK  ' : 'FAIL'} 본문 산문은 남음: "주 협력사가 아니라"`);
console.log(`  → ${ok}/${leaked.length} 마스킹, 본문 보존 ${bodyKept ? 'PASS' : 'FAIL'}`);
console.log(`  탐지 결과: S1=${detect(PROTECTED_SAMPLE).s1} (front-matter·표·코드블록의 "결론적으로"는 세지 않음)`);

/* ---------- A/B 실측 ---------- */
const a = await read(`${SCRATCH}/ab_a.md`);
const b = await read(`${SCRATCH}/ab_b.md`);
if (!a || !b) { console.log('\n(A/B 산출물 없음 — CLI 호출 필요)'); process.exit(0); }

console.log('\n=== A/B: quick-rules 주입 효과 (동일 질문·동일 근거·동일 모델) ===\n');
const ra = detect(a);
const rb = detect(b);
const line = (label, r) =>
  console.log(`  ${label.padEnd(24)} 등급 ${r.grade}  S1=${String(r.s1).padStart(2)}  S2=${String(r.s2).padStart(2)}  (${r.chars}자)`);
line('A 규칙 없이', ra);
line('B quick-rules 주입', rb);

const byId = (r) => new Map(r.hits.map((h) => [h.id, h]));
const ma = byId(ra), mb = byId(rb);
const ids = [...new Set([...ma.keys(), ...mb.keys()])].sort();
console.log('\n  패턴별 (A → B)');
for (const id of ids) {
  const x = ma.get(id), y = mb.get(id);
  const na = x?.n ?? 0, nb = y?.n ?? 0;
  const mark = nb < na ? '개선' : nb > na ? '★악화' : '';
  console.log(`    ${id.padEnd(6)} ${(x ?? y).sev}  ${(x ?? y).name.padEnd(18)} ${String(na).padStart(2)} → ${String(nb).padStart(2)}  ${mark}`);
}
const d1 = ra.s1 - rb.s1;
console.log(`\n  S1 ${ra.s1} → ${rb.s1} (${d1 >= 0 ? '-' : '+'}${Math.abs(d1)})   S2 ${ra.s2} → ${rb.s2}`);
console.log(`  ${rb.s1 < ra.s1 ? 'quick-rules 주입이 S1 패턴을 줄였다.' : 'S1 감소 없음.'}`);

await fs.mkdir(new URL('../out/', import.meta.url).pathname, { recursive: true });
await fs.writeFile(new URL('../out/korean.json', import.meta.url).pathname, JSON.stringify({ a: ra, b: rb }, null, 1));
