// 탐지기 검증 — 정답을 아는 문장에 패턴을 심어 정밀도·재현율을 잰다.
// n=1 LLM A/B로는 탐지기 품질을 알 수 없어서, 심은 패턴으로 따로 검증한다.
//
// POS: 그 규칙이 반드시 잡아야 하는 문장
// NEG: 잡으면 오탐인 문장 (업무 위키에 정상적으로 나오는 한국어)
import fs from 'node:fs/promises';
import { RULES, detect, maskProtected } from './detect.mjs';

const CASES = {
  'A-7': {
    pos: ['에이콤은 국내 최고 수준의 기술력을 가지고 있다.', '구매팀이 최종 결정권을 갖고 있다.'],
    neg: ['에이콤의 기술력이 국내 최고 수준이다.', '최종 결정권은 구매팀에 있다.'],
  },
  'A-8': {
    pos: ['갱신일은 구매팀에서 판단되어진다.', '계약은 자동으로 연장되어 진다.'],
    neg: ['갱신일은 구매팀이 판단한다.', '계약이 자동 연장된다.'],
  },
  'A-19': {
    pos: ['킥오프에서의 논의는 slide-12에 있다.', '본사로의 이관이 검토됐다.'],
    neg: ['킥오프 논의는 slide-12에 있다.', '본사 이관을 검토했다.'],
  },
  'C-8': {
    pos: ['이는 단순 요청이 아니라 공식 변경 통보다.', '문제는 일정이 아니라 승인 절차다.'],
    neg: ['이는 공식 변경 통보다.', '승인 절차가 지연됐다.', '요청이 접수되지 않았다.'],
  },
  'C-11': {
    pos: ['갱신일은 1월이고, 조정 요청은 3월이다.', '메일은 8월에 왔지만, 슬라이드는 9월에 만들어졌다.'],
    neg: ['갱신일은 1월이고 조정 요청은 3월이다.', '구매팀, 영업팀, 법무팀이 검토한다.', '2027-01-15, 2027-03-01 두 날짜가 있다.'],
  },
  'D-1': {
    pos: ['결론적으로 갱신일은 미정이다. 이를 통해 확인된 것은 하나다. 요약하면 재검토가 필요하다.'],
    neg: ['갱신일은 미정이다. 확인된 것은 하나다.', '이를 통해 갱신일을 확인했다.'],
  },
  'D-2': {
    pos: ['이 불일치가 시사하는 바가 크다.', '구매팀의 대응은 주목할 만하다.'],
    neg: ['이 불일치는 승인 절차를 지연시킨다.', '구매팀은 8월 20일에 회신했다.'],
  },
  'D-3': {
    pos: ['원인은 크게 세 가지로 나눌 수 있다.', '다음과 같은 문제가 있다.'],
    neg: ['원인은 시차, 승인 지연, 기록 누락이다.'],
  },
  'D-8': {
    pos: ['중요한 것은 승인 시점이다.', '핵심은 구매팀의 최종 검토다.', '문제는 두 문서의 발행 시차다.', '차이는 발행 시점에 있다.'],
    neg: ['승인 시점을 확인해야 한다.', '구매팀이 최종 검토한다.', '두 문서의 발행 시차가 원인이다.', '발행 시점이 다르다.', '이유는 아직 확인되지 않았으므로 구매팀에 문의한다.'],
  },
  'D-10': {
    pos: ['슬라이드가 갱신되지 않은 이유다.', '승인이 지연된 배경이다.'],
    neg: ['그래서 슬라이드가 갱신되지 않았다.', '이유를 확인해야 한다.', '지연 이유는 승인 절차다.'],
  },
  'G-2': {
    pos: ['갱신일이 변경될 가능성이 있을 수 있다.'],
    neg: ['갱신일이 변경될 수 있다.', '변경 가능성이 있다.'],
  },
  'I-2': {
    pos: ['주목할 점은 메일이 슬라이드보다 앞선다는 것이다.'],
    neg: ['메일이 슬라이드보다 앞선다.', '발행 시점이 다르다.'],
  },
  'I-3': {
    pos: ['갱신일이 확정되지 않았다는 것이다. 승인이 남았다는 뜻이다.'],
    neg: ['갱신일이 확정되지 않았다. 승인이 남았다.'],
  },
};

const ruleById = new Map(RULES.map((r) => [r.id, r]));
const rows = [];
let tp = 0;
let fn = 0;
let fp = 0;
let tn = 0;

for (const [id, { pos, neg }] of Object.entries(CASES)) {
  const rule = ruleById.get(id);
  if (!rule) { rows.push({ id, note: '규칙 없음' }); continue; }
  let p = 0;
  let n = 0;
  const missed = [];
  const false_ = [];
  for (const s of pos) {
    if (rule.find(maskProtected(s)) > 0) { p++; tp++; } else { fn++; missed.push(s); }
  }
  for (const s of neg) {
    if (rule.find(maskProtected(s)) > 0) { fp++; false_.push(s); } else { n++; tn++; }
  }
  rows.push({ id, name: rule.name, sev: rule.sev, pos: `${p}/${pos.length}`, neg: `${n}/${neg.length}`, missed, false_ });
}

console.log('\n=== 한국어 AI 티 탐지기 검증 (심은 패턴) ===\n');
console.log('  규칙   sev  이름                 검출  오탐없음');
for (const r of rows) {
  if (r.note) { console.log(`  ${r.id.padEnd(6)} ${r.note}`); continue; }
  const bad = r.missed.length || r.false_.length;
  console.log(`  ${r.id.padEnd(6)} ${r.sev}   ${r.name.padEnd(20)} ${r.pos}   ${r.neg}  ${bad ? '←' : ''}`);
  for (const s of r.missed) console.log(`         놓침: ${s}`);
  for (const s of r.false_) console.log(`         ★오탐: ${s}`);
}

const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 1;
console.log(`\n  TP=${tp} FN=${fn} FP=${fp} TN=${tn}`);
console.log(`  정밀도 ${precision.toFixed(3)} · 재현율 ${recall.toFixed(3)}`);
console.log(
  `  ${fp === 0 ? '오탐 0건 — Lint 후보로 제시해도 사람이 신뢰할 수 있다.' : `★오탐 ${fp}건 — 이대로 쓰면 정상 문장을 지적한다.`}`,
);

/* ---------- 우리 위키 페이지 모양에서의 동작 ---------- */
const WIKI = `---
id: con-contract-renewal
type: concept
title: 계약 갱신
summary: 결론적으로 중요한 것은 승인 시점이다.
---

# 계약 갱신

에이콤의 갱신일은 문서마다 다르다. [^src-kickoff#slide-12]
이는 단순 요청이 아니라 공식 변경 통보이고, 구매팀 검토가 남았다. [^src-mail-a41f#body]

관련: [[entities/acme-corp|에이콤(주)]]
`;
const w = detect(WIKI);
console.log('\n=== 위키 페이지 형태에서의 동작 ===');
console.log(`  등급 ${w.grade} · S1=${w.s1} S2=${w.s2}`);
for (const h of w.hits) console.log(`    ${h.id} ${h.name} x${h.n} → ${h.fix}`);
console.log(`  front-matter의 "결론적으로/중요한 것은"은 세지 않음 (본문만 대상): ${w.hits.some((h) => h.id === 'D-1') ? 'FAIL' : 'OK'}`);

await fs.mkdir(new URL('../out/', import.meta.url).pathname, { recursive: true });
await fs.writeFile(new URL('../out/korean-validate.json', import.meta.url).pathname, JSON.stringify({ rows, tp, fn, fp, tn, precision, recall }, null, 1));
process.exit(fp === 0 ? 0 : 1);
