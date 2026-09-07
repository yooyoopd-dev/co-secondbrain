#!/usr/bin/env node
// 17번 — 추출기 자가검사. docs/ROADMAP.md §3.2
//
// 사내 문서 폴더를 훑어 **집계 수치만** 낸다. 사람이 화면을 보고 옮겨 적는다.
//
// 반출 규약 (ROADMAP §3.1). 이 넷은 협상 대상이 아니다:
//   - 원문 텍스트 · 파일명 · 엔티티명을 출력하지 않는다. 개수와 분포만 낸다
//   - 파일을 만들지 않는다. 표준 출력으로만 낸다. 딸려 나갈 파일 자체를 안 만든다
//   - 실패 사유는 **분류명과 건수**만 낸다. 사유 문자열에 경로가 섞이므로 통째로 버린다
//   - 확장자는 낸다 (§3.2 가 요구한다). 확장자에는 내용이 없다
//
//   node --experimental-strip-types spikes/selfcheck/extract.mjs <폴더>
//   node --experimental-strip-types spikes/selfcheck/extract.mjs --selftest
//
// 앱의 추출기를 그대로 부른다. `app` 의존성이 깔려 있어야 돈다 (ROADMAP §12).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, kindOf } from '../../app/src/core/extract/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const selftest = process.argv.includes('--selftest');
const target = selftest ? path.join(HERE, '..', 'fixtures', 'files') : process.argv[2];

if (!target) {
  console.error('폴더를 주십시오.  node --experimental-strip-types spikes/selfcheck/extract.mjs <폴더>');
  process.exit(2);
}

/* ------------------------------------------------------------------ *
 * 실패 사유 분류. **원본 메시지를 절대 그대로 담지 않는다** — 거의 항상 경로가 섞인다.
 * 분류에 안 걸리면 `기타` 로 센다. 무엇인지 모르는 채로 세는 편이 경로가 새는 것보다 낫다.
 * ------------------------------------------------------------------ */
const FAIL_KINDS = [
  ['암호·DRM', /password|encrypt|drm|권한|암호/i],
  ['손상·형식 불일치', /corrupt|invalid|not a|zip|형식|손상|깨진/i],
  ['파일 없음·접근 불가', /enoent|eacces|eperm|no such|권한이 없|찾을 수 없/i],
  ['용량·메모리', /heap|memory|too large|범위를 벗어/i],
];
const classifyFail = (e) => {
  const m = String(e?.message ?? e);
  for (const [name, re] of FAIL_KINDS) if (re.test(m)) return name;
  return '기타';
};

/** 경고도 분류만 남긴다. 원문에는 쪽수·비율이 섞여 있다. */
const WARN_KINDS = [
  ['스캔본 의심', /스캔본|텍스트 레이어/],
  ['빈 문서', /비어|내용이 없/],
  ['일부만 읽음', /일부|잘렸|truncat/i],
];
const classifyWarn = (w) => {
  for (const [name, re] of WARN_KINDS) if (re.test(w)) return name;
  return '기타';
};

const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out; // 못 여는 폴더는 조용히 건너뛴다. 경로를 찍지 않는다
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const stats = (xs) => {
  if (!xs.length) return { min: 0, med: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    min: s[0],
    med: s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2),
    max: s[s.length - 1],
  };
};

/* ------------------------------------------------------------------ */

const files = await walk(target);
const byExt = new Map(); // ext → {총, 성공, 실패, 미지원}
const failKinds = new Map();
const warnKinds = new Map();
const chunkCounts = [];
const anchorCounts = [];
let scanned = 0;
let msgTried = 0;
let msgOk = 0;
let xlsxRefs = 0;

for (const f of files) {
  const ext = path.extname(f).toLowerCase() || '(없음)';
  const row = byExt.get(ext) ?? { total: 0, ok: 0, fail: 0, skip: 0 };
  row.total++;
  byExt.set(ext, row);

  if (kindOf(path.basename(f)) === null) {
    row.skip++;
    continue;
  }
  const isMsg = ext === '.msg';
  if (isMsg) msgTried++;

  try {
    const x = await extractFile(f);
    row.ok++;
    if (isMsg) msgOk++;
    chunkCounts.push(x.chunks.length);
    // 앵커는 조각마다 하나다. 좌표가 겹치는 경우가 있어 중복 없이 센다.
    anchorCounts.push(new Set(x.chunks.map((c) => c.anchor.locator)).size);
    // 수식의 셀 참조는 `feeds` 로 나온다 (extract/xlsx.ts). `references` 로 세다가 0 이
    // 나왔고 자가 검사가 잡았다.
    if (x.kind === 'xlsx') xlsxRefs += x.relations.filter((r) => r.kind === 'feeds').length;
    for (const w of x.warnings) {
      const k = classifyWarn(w);
      bump(warnKinds, k);
      if (k === '스캔본 의심') scanned++;
    }
  } catch (e) {
    row.fail++;
    bump(failKinds, classifyFail(e));
  }
}

const ch = stats(chunkCounts);
const an = stats(anchorCounts);
const sum = (k) => [...byExt.values()].reduce((a, r) => a + r[k], 0);

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log('');
console.log('===== 아래 표만 적어 주세요 (파일명·원문 없음) =====');
console.log(`대상 파일 ${files.length}건 · 지원 ${sum('total') - sum('skip')}건 · 성공 ${sum('ok')} · 실패 ${sum('fail')} · 미지원 ${sum('skip')}`);
console.log('');
console.log(`  ${pad('확장자', 10)}${num('총', 6)}${num('성공', 6)}${num('실패', 6)}${num('미지원', 8)}`);
for (const [ext, r] of [...byExt].sort((a, b) => b[1].total - a[1].total)) {
  console.log(`  ${pad(ext, 10)}${num(r.total, 6)}${num(r.ok, 6)}${num(r.fail, 6)}${num(r.skip, 8)}`);
}
console.log('');
console.log(`  파일당 조각 수   최소 ${ch.min} · 중앙 ${ch.med} · 최대 ${ch.max}`);
console.log(`  파일당 앵커 수   최소 ${an.min} · 중앙 ${an.med} · 최대 ${an.max}`);
console.log(`  스캔본 판정      ${scanned}건`);
console.log(`  .msg 성공        ${msgOk}/${msgTried}`);
console.log(`  xlsx 셀 참조     ${xlsxRefs}건`);
console.log('');
console.log(`  실패 사유  ${[...failKinds].map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);
console.log(`  경고 종류  ${[...warnKinds].map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);
console.log('==================================================');
console.log('');

/* ---------------- 자가 검사 — 정답을 아는 입력 (CLAUDE.md §9) ---------------- */

if (selftest) {
  const fails = [];
  const ok = (name, cond, got) => {
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${JSON.stringify(got)}`}`);
    if (!cond) fails.push(name);
  };
  // `spikes/fixtures/make.mjs` 가 만드는 아홉 개다. 정답을 안다.
  ok('아홉 개를 전부 읽었다', sum('ok') === 9, { ok: sum('ok'), files: files.length });
  ok('실패가 없다', sum('fail') === 0, [...failKinds]);
  ok('스캔본 하나를 잡았다', scanned === 1, scanned);
  ok('xlsx 셀 참조를 찾았다', xlsxRefs > 0, xlsxRefs);
  // 스캔본은 텍스트 레이어가 없어 조각이 0 이다. 그것이 정상이다.
  ok('스캔본 하나만 조각이 0 이다', chunkCounts.filter((n) => n === 0).length === 1, chunkCounts);
  // 반출 규약 — 출력에 파일명이 섞이면 여기서 걸려야 한다.
  ok('출력에 파일명이 없다', ![...failKinds.keys(), ...warnKinds.keys()].some((k) => /\.|\//.test(k)), [...failKinds.keys(), ...warnKinds.keys()]);
  console.log(fails.length === 0 ? '\n전부 통과' : `\n실패 ${fails.length}건`);
  process.exit(fails.length === 0 ? 0 : 1);
}
