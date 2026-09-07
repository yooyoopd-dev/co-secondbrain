#!/usr/bin/env node
// 18번 — 엔티티 유사도 자가검사. docs/ROADMAP.md §3.3
//
// 사내 엔티티명 목록으로 오병합이 실제로 몇 건 나는지 본다. M0 §4.3 에서 정한 임계
// 0.96 이 한국어 사내 데이터에서도 오병합 0 인가가 물음이다.
//
// **화면이 두 칸으로 나뉜다. 섞지 마십시오.**
//   1) 회수 표 — 숫자뿐이다. 옮겨 적는다
//   2) 후보쌍 목록 — 이름이 그대로 뜬다. **화면에서만 보고 개수만 세십시오**
//
// 사람이 세는 이유가 있다. 두 이름이 같은 대상인지는 사내 사정을 아는 사람만 안다.
// 스크립트는 못 판정한다. 그래서 이름은 화면에 두고 **판정한 숫자만** 나간다.
//
//   node --experimental-strip-types spikes/selfcheck/entities.mjs <이름목록.txt>
//   node --experimental-strip-types spikes/selfcheck/entities.mjs --selftest
//
// 이름 목록은 한 줄에 하나다. 빈 줄과 `#` 로 시작하는 줄은 건너뛴다.
import fs from 'node:fs/promises';
import {
  MIN_ENTROPY,
  MIN_LABEL_LEN,
  SIMILARITY_THRESHOLD,
  entropyPerChar,
  findDuplicates,
  jaroWinkler,
  normalizeLabel,
  passesGate,
} from '../../app/src/core/lint/dedup.ts';

const selftest = process.argv.includes('--selftest');

/** 정답을 아는 입력. 앞 넷은 같은 대상, 뒤 넷은 다른 대상이다 (M0 §4 와 같은 결). */
const SELFTEST_NAMES = [
  '에이콤(주)', '에이콤 주식회사', '에이콤', // 같은 대상 셋
  '구매팀', '구매팀장', // 다른 대상 — 0.92 면 붙고 0.96 이면 안 붙는다
  '한빛소재', '한빛소재㈜', // 같은 대상 둘
  'AI', 'DB', '팀', // 게이트에 걸려야 하는 짧은 이름
  '대한전선', '대한전기',
];

const raw = selftest
  ? SELFTEST_NAMES
  : (await fs.readFile(process.argv[2] ?? '', 'utf8').catch(() => null))?.split(/\r?\n/) ?? null;

if (raw === null) {
  console.error('이름 목록 파일을 주십시오.  node --experimental-strip-types spikes/selfcheck/entities.mjs <이름목록.txt>');
  process.exit(2);
}

const names = [...new Set(raw.map((s) => s.trim()).filter((s) => s && !s.startsWith('#')))];
if (names.length < 2) {
  console.error(`이름이 ${names.length}개입니다. 둘 이상이어야 비교합니다.`);
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 게이트와 점수. 앱이 쓰는 함수를 그대로 부른다 — 여기서 다시 구현하면 앱과 갈린다.
 * ------------------------------------------------------------------ */

const gated = names.filter((n) => !passesGate(n));
const usable = names.filter((n) => passesGate(n));

// 히스토그램은 게이트를 통과한 쌍 전부를 본다. 임계 근처가 얼마나 붐비는지가 요점이다.
const BUCKETS = 20; // 0.05 구간
const hist = new Array(BUCKETS).fill(0);
let pairs = 0;
for (let i = 0; i < usable.length; i++) {
  for (let j = i + 1; j < usable.length; j++) {
    const a = normalizeLabel(usable[i]);
    const b = normalizeLabel(usable[j]);
    const score = a === b ? 1 : jaroWinkler(a, b);
    pairs++;
    hist[Math.min(BUCKETS - 1, Math.floor(score / 0.05))]++;
  }
}

const cands = findDuplicates(names.map((label, i) => ({ id: String(i), label })));

/* ---------------- 1) 옮겨 적을 표 ---------------- */

console.log('');
console.log('===== 아래 표만 적어 주세요 (이름 없음) =====');
console.log(`이름 ${names.length}개 · 게이트 통과 ${usable.length} · 게이트 탈락 ${gated.length} · 비교한 쌍 ${pairs}`);
console.log(`임계 ${SIMILARITY_THRESHOLD} 초과 쌍 ${cands.length}건   (게이트: ${MIN_LABEL_LEN}자 이상 · 엔트로피 ${MIN_ENTROPY} 이상)`);
console.log('');
console.log('  점수 분포 (0.05 구간, 0 인 구간은 생략)');
for (let b = 0; b < BUCKETS; b++) {
  if (hist[b] === 0) continue;
  const lo = (b * 0.05).toFixed(2);
  const hi = ((b + 1) * 0.05).toFixed(2);
  console.log(`  ${lo}~${hi}  ${String(hist[b]).padStart(6)}`);
}
console.log('');
console.log('  오병합 건수  ____  ← 아래 목록을 보고 사람이 세어 넣습니다');
console.log('=============================================');

/* ---------------- 2) 화면에서만 볼 목록 ---------------- */

console.log('');
console.log('----- 여기부터는 이름이 뜹니다. 옮겨 적지 마십시오 -----');
if (cands.length === 0) {
  console.log('임계를 넘은 쌍이 없습니다. 오병합 건수는 0 입니다.');
} else {
  console.log('둘이 실제로 **다른 대상**이면 오병합입니다. 그 개수만 위 표에 적으십시오.');
  console.log('');
  for (const c of cands) {
    console.log(`  ${c.score.toFixed(3)}  ${names[Number(c.a)]}  ↔  ${names[Number(c.b)]}`);
  }
}
console.log('--------------------------------------------------------');

/* ---------------- 자가 검사 (CLAUDE.md §9) ---------------- */

if (selftest) {
  console.log('');
  const fails = [];
  const ok = (name, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${JSON.stringify(got)}`}`);
    if (!cond) fails.push(name);
  };
  const pairOf = (x, y) =>
    cands.some((c) => {
      const s = new Set([names[Number(c.a)], names[Number(c.b)]]);
      return s.has(x) && s.has(y);
    });

  ok('짧고 모호한 이름은 게이트에 걸린다', gated.length === 3 && ['AI', 'DB', '팀'].every((n) => gated.includes(n)), gated);
  ok('법인 표기만 다르면 후보로 잡는다', pairOf('한빛소재', '한빛소재㈜'), cands.map((c) => c.score));
  // **오병합 0 이 절대 조건이다** (dedup.ts 머리말). 이 쌍이 붙으면 임계가 다시 낮은 것이다.
  ok('구매팀 ↔ 구매팀장 은 안 붙는다 — 0.92 에서 오병합 나던 쌍', !pairOf('구매팀', '구매팀장'), jaroWinkler(normalizeLabel('구매팀'), normalizeLabel('구매팀장')).toFixed(3));
  ok('대한전선 ↔ 대한전기 는 안 붙는다', !pairOf('대한전선', '대한전기'), jaroWinkler(normalizeLabel('대한전선'), normalizeLabel('대한전기')).toFixed(3));
  ok('히스토그램 합이 비교한 쌍 수와 같다', hist.reduce((a, b) => a + b, 0) === pairs, { hist: hist.reduce((a, b) => a + b, 0), pairs });
  ok('엔트로피 계산이 앱 것과 같다', entropyPerChar('가나다') > 1, entropyPerChar('가나다'));

  console.log(fails.length === 0 ? '\n전부 통과' : `\n실패 ${fails.length}건`);
  process.exit(fails.length === 0 ? 0 : 1);
}
