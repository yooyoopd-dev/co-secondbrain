// M0 항목 7 — 한국어 엔티티명 유사도 실측.
// 계획서 §8.2가 "라틴 문자 기준 설계라 한국어 정확도를 모른다"고 표시한 부분.
import fs from 'node:fs/promises';

/* ---------- 정규화 ---------- */
const LEGAL = /(주식회사|㈜|\(주\)|\(유\)|유한회사|Inc\.?|Corp\.?|Co\.,?\s*Ltd\.?|LLC|Ltd\.?|GmbH)/gi;
// 한국어 조사: 엔티티명 뒤에 붙는 흔한 것들. 명사 끝 음절을 잘라먹지 않도록 목록으로 한정.
const JOSA = /(으로부터|에게서|이라고|라고|으로서|로서|으로|에서|에게|과의|와의|이라|라는|이는|은|는|이|가|을|를|의|와|과|도|만|에|로)$/;
const norm = (s) =>
  s.normalize('NFKC').replace(LEGAL, '').replace(/[()\[\]{}·.,'"-]/g, '').replace(/\s+/g, '').toLowerCase();
const stripJosa = (s) => {
  const t = s.replace(JOSA, '');
  return t.length >= 2 ? t : s;
};
const key = (s) => stripJosa(norm(s));

/* ---------- 엔트로피 게이트 (graphify dedup 2단계) ---------- */
function entropyPerChar(s) {
  if (!s.length) return 0;
  const c = new Map();
  for (const ch of s) c.set(ch, (c.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of c.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
// 한글은 음절 자체가 정보량이 커서 글자당 엔트로피만으로는 짧은 약어를 못 거른다.
// 길이 하한을 함께 본다. (graphify의 2.5비트/글자 기준을 그대로 쓰면 한글에서 오작동)
const gate = (s) => s.length >= 3 && entropyPerChar(s) >= 1.0;

/* ---------- Jaro-Winkler ---------- */
function jaro(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const win = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const ma = new Array(a.length).fill(false);
  const mb = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - win); j < Math.min(b.length, i + win + 1); j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = mb[j] = true;
      m++;
      break;
    }
  }
  if (!m) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  return (m / a.length + m / b.length + (m - t / 2) / m) / 3;
}
function jaroWinkler(a, b, p = 0.1) {
  const j = jaro(a, b);
  let l = 0;
  while (l < 4 && l < a.length && l < b.length && a[l] === b[l]) l++;
  return j + l * p * (1 - j);
}

/* ---------- 자모 분해 (한글 전용 보강) ----------
   한글 음절은 원자가 아니다. "에이콤" vs "베이콤"은 음절 단위로 보면 1/3이 다르지만
   자모로 펴면 초성 하나만 다르다. 어느 쪽이 나은지 실측으로 정한다. */
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const toJamo = (s) =>
  [...s]
    .map((ch) => {
      const c = ch.charCodeAt(0) - 0xac00;
      if (c < 0 || c > 11171) return ch;
      return CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + JONG[c % 28];
    })
    .join('');

/* ---------- 테스트 세트 ----------
   same=true  : 병합돼야 하는 쌍
   same=false : 절대 병합되면 안 되는 쌍 (위키에서 오병합은 복구가 어려움) */
const PAIRS = [
  ['에이콤(주)', '에이콤', true, '법인격 접미사'],
  ['에이콤(주)', '주식회사 에이콤', true, '법인격 위치 변화'],
  ['에이콤', '에이콤이', true, '주격 조사'],
  ['에이콤', '에이콤은', true, '보조사'],
  ['에이콤', '에이콤에서', true, '부사격 조사'],
  ['에이콤 주식회사', '에이콤주식회사', true, '띄어쓰기'],
  ['Acme Corp', 'ACME Corp.', true, '영문 대소문자·마침표'],
  ['홍길동 과장', '홍길동과장', true, '직함 띄어쓰기'],
  ['클라우드 마이그레이션', '클라우드마이그레이션', true, '합성어 띄어쓰기'],
  ['데이타베이스', '데이터베이스', true, '외래어 표기 흔들림'],
  ['프로젝트 킥오프', '프로젝트 킥 오프', true, '외래어 분절'],

  ['에이콤', '에이스콤', false, '다른 회사 (1음절 삽입)'],
  ['김철수', '김영수', false, '다른 사람 (1음절)'],
  ['구매팀', '구매팀장', false, '조직 vs 직책'],
  ['개발1팀', '개발2팀', false, '숫자만 다름'],
  ['에이콤', '베이콤', false, '첫 음절 다름'],
  ['계약 갱신', '계약 해지', false, '반대 개념'],
  ['2026년 계획', '2027년 계획', false, '연도만 다름'],
  ['서울지사', '서울지점', false, '유사하지만 다른 조직'],
];
const SHORT = ['AI', 'DB', 'PM', 'QA', 'PO', '팀', '안']; // 게이트가 걸러야 할 것

function evaluate(threshold, useJamo) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  const misses = [];
  for (const [a, b, same, label] of PAIRS) {
    const ka = key(a);
    const kb = key(b);
    if (!gate(ka) || !gate(kb)) {
      if (same) {
        fn++;
        misses.push(`게이트차단 ${a} | ${b}`);
      } else tn++;
      continue;
    }
    const s = ka === kb ? 1 : jaroWinkler(useJamo ? toJamo(ka) : ka, useJamo ? toJamo(kb) : kb);
    const merged = s >= threshold;
    if (same && merged) tp++;
    else if (same && !merged) {
      fn++;
      misses.push(`놓침    ${a} | ${b} (${label}) ${s.toFixed(3)}`);
    } else if (!same && merged) {
      fp++;
      misses.push(`★오병합 ${a} | ${b} (${label}) ${s.toFixed(3)}`);
    } else tn++;
  }
  return {
    threshold,
    useJamo,
    tp,
    fp,
    tn,
    fn,
    misses,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
  };
}

console.log('\n=== M0 항목 7 · 한국어 엔티티 유사도 실측 ===\n');
console.log(
  `테스트 쌍 ${PAIRS.length}개 (병합돼야 함 ${PAIRS.filter((p) => p[2]).length} / 병합 금지 ${PAIRS.filter((p) => !p[2]).length})\n`,
);

console.log('--- 엔트로피 게이트: 짧은 약어 차단 확인 ---');
for (const s of SHORT) {
  const k = key(s);
  console.log(`  ${s.padEnd(4)} len=${k.length} H=${entropyPerChar(k).toFixed(2)}  → ${gate(k) ? '통과(위험)' : '차단 OK'}`);
}

console.log('\n--- 임계값 스윕 ---');
console.log('  자모   임계  TP FP TN FN   정밀도  재현율');
const grid = [];
for (const useJamo of [false, true]) {
  for (const th of [0.88, 0.9, 0.92, 0.94, 0.96]) {
    const r = evaluate(th, useJamo);
    grid.push(r);
    console.log(
      `  ${useJamo ? '적용  ' : '미적용'} ${th.toFixed(2)}  ${String(r.tp).padStart(2)} ${String(r.fp).padStart(2)} ${String(r.tn).padStart(2)} ${String(r.fn).padStart(2)}   ${r.precision.toFixed(3)}   ${r.recall.toFixed(3)}`,
    );
  }
}

// 위키에서 잘못된 병합은 복구가 어렵다 → 오병합(FP) 0을 절대 조건으로 두고 재현율 최대화
const safe = grid.filter((r) => r.fp === 0).sort((a, b) => b.recall - a.recall)[0];
console.log('\n--- 권장 설정 (오병합 0 조건에서 재현율 최대) ---');
if (!safe) {
  console.log('  오병합 0인 설정이 없음 → 자동 후보 제시를 포기하고 전량 수동으로 돌려야 함');
} else {
  console.log(`  자모 분해 ${safe.useJamo ? '적용' : '미적용'}, 임계 ${safe.threshold}`);
  console.log(`  정밀도 ${safe.precision.toFixed(3)} · 재현율 ${safe.recall.toFixed(3)} · 오병합 ${safe.fp}건`);
  console.log('\n  놓친 쌍 (자동 후보로 안 잡혀 사람이 직접 병합해야 하는 것):');
  for (const m of safe.misses) console.log(`    ${m}`);
}

await fs.mkdir(new URL('../out/', import.meta.url).pathname, { recursive: true });
await fs.writeFile(new URL('../out/similarity.json', import.meta.url).pathname, JSON.stringify({ grid, safe }, null, 1));
