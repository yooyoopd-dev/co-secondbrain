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
//   node --experimental-strip-types spikes/selfcheck/extract.mjs --deps
//
// 앱의 추출기를 그대로 부른다. **`app` 의 운영 의존성만 있으면 된다** — electron 은
// 필요 없다. `npm ci --omit=dev` 로 깐다 (ROADMAP §12).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * `--deps` — 어떤 라이브러리가 실제로 깔렸는가.
 *
 * 사내 PC 에서 설치가 반쯤 되는 일이 잦다. 그 상태로 문서 폴더를 훑으면 **특정 확장자만
 * 조용히 전부 실패**하고 그 수치를 진짜로 착각한다. 먼저 여기서 걸러 낸다.
 * ------------------------------------------------------------------ */
/**
 * **라이브러리 이름으로 부르지 않는다.** 이 스크립트는 `spikes/` 아래에 있어서
 * `import('mammoth')` 는 `spikes/node_modules` 에서 찾는다. 정작 추출기가 쓰는 것은
 * `app/node_modules` 다. 실제로 `yaml` 하나가 그 차이로 잘못 "실패" 로 나왔다.
 *
 * 앱 모듈을 경로로 부르면 그 안의 `import mammoth` 가 `app/` 기준으로 풀린다.
 * 재려는 것이 바로 그 해석이다.
 */
const APP_MODULES = [
  ['../../app/src/core/extract/docx.ts', 'docx        mammoth'],
  ['../../app/src/core/extract/xlsx.ts', 'xlsx · csv  exceljs'],
  ['../../app/src/core/extract/pptx.ts', 'pptx        jszip · fast-xml-parser'],
  ['../../app/src/core/extract/pdf.ts', 'pdf         pdfjs-dist'],
  ['../../app/src/core/extract/email.ts', 'eml · msg   mailparser · msgreader'],
  ['../../app/src/core/extract/transcript.ts', 'vtt · srt   (라이브러리 없음)'],
  ['../../app/src/core/extract/plain.ts', 'txt · md    (라이브러리 없음)'],
  ['../../app/src/core/page.ts', '페이지 파싱  yaml'],
  ['../../app/src/core/lint/dedup.ts', '엔티티 유사도 (라이브러리 없음)'],
];

if (process.argv.includes('--deps')) {
  let bad = 0;
  console.log('');
  for (const [mod, what] of APP_MODULES) {
    try {
      await import(mod);
      console.log(`  OK    ${what}`);
    } catch (e) {
      bad++;
      console.log(`  실패  ${what}  ← ${String(e?.code ?? e?.message).slice(0, 50)}`);
    }
  }
  console.log('');
  console.log(
    bad === 0
      ? '전부 깔렸습니다. 자가검사로 넘어가십시오.'
      : `${bad}개가 안 열립니다. app 폴더에서 npm ci --omit=dev 를 다시 돌리십시오.`,
  );
  process.exit(bad === 0 ? 0 : 2);
}

const { extractFile, kindOf } = await import('../../app/src/core/extract/index.ts');

const selftest = process.argv.includes('--selftest');
const target = selftest ? path.join(HERE, '..', 'fixtures', 'files') : process.argv[2];

if (!target) {
  console.error('폴더를 주십시오.  node --experimental-strip-types spikes/selfcheck/extract.mjs <폴더>');
  process.exit(2);
}

if (selftest) {
  // 시험용 원본은 저장소에 안 담겨 있다. 없으면 무엇을 하라는지 알려 주고 멈춘다.
  const n = await fs.readdir(target).catch(() => []);
  if (n.length === 0) {
    console.error('시험용 원본이 없습니다. 먼저 만드십시오:');
    console.error('  cd spikes && npm install && node fixtures/make.mjs');
    process.exit(2);
  }
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

let unreadable = 0;

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // 못 여는 폴더의 경로는 안 찍는다. 대신 **몇 개인지는 센다** — 권한 때문에 절반만
    // 훑고서 그 수치를 전부인 줄 아는 것이 제일 나쁘다.
    unreadable++;
    return out;
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

/**
 * 대상 폴더가 진짜 있는지 먼저 본다.
 *
 * **없는 경로를 조용히 0건으로 처리하면 안 된다.** 사내 회차에서 실제로 "대상 파일 0건"
 * 짜리 빈 표만 나왔고, 그것만 보고는 경로가 틀린 것인지 폴더가 빈 것인지 알 수 없었다.
 *
 * PowerShell 함정 하나: `"D:\폴더\"` 처럼 역슬래시로 끝나면 따옴표가 이스케이프돼
 * 인자가 깨진다. 끝의 역슬래시를 빼야 한다.
 */
const stat = await fs.stat(target).catch(() => null);
if (stat === null) {
  console.error(`그런 폴더가 없습니다: ${target}`);
  console.error('');
  console.error('PowerShell 에서 경로가 역슬래시로 끝나면 따옴표가 깨집니다.');
  console.error('  틀림  "D:\\문서폴더\\"');
  console.error('  맞음  "D:\\문서폴더"');
  process.exit(2);
}
if (!stat.isDirectory()) {
  console.error(`폴더가 아닙니다: ${target}`);
  process.exit(2);
}

const files = await walk(target);

if (files.length === 0) {
  console.error(`파일이 하나도 없습니다: ${target}`);
  if (unreadable > 0) console.error(`못 연 하위 폴더가 ${unreadable}개 있습니다. 권한을 보십시오.`);
  else console.error('하위 폴더까지 훑었는데 비어 있습니다. 경로를 다시 보십시오.');
  process.exit(2);
}
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
if (unreadable > 0) console.log(`못 연 하위 폴더 ${unreadable}개 — 이 수치는 전부가 아닙니다`);
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
