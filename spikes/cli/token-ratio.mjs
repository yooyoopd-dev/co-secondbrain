#!/usr/bin/env node
// W10 · W11 회수 스크립트 — 한국어 토큰 환산과 Gemini 봉투. docs/ROADMAP.md §9
//
// **입력은 전부 이 파일 안의 합성 한국어다.** 사내 문서를 읽지 않는다. 출력도 숫자와
// JSON 키 이름뿐이라 화면을 보고 그대로 옮겨 적으면 된다 (CLAUDE.md §9, ROADMAP §3).
//
// 재는 방법: **같은 골격에 길이만 다른 글 둘을 보내고 기울기를 본다.**
//   토큰/자 = (긴 쪽 토큰 - 짧은 쪽 토큰) / (긴 쪽 글자 - 짧은 쪽 글자)
// CLI 고정 오버헤드가 약 3만 토큰인데(M0-RESULTS.md), 빼기로 그것이 상쇄된다. 절대값을
// 그냥 나누면 오버헤드가 섞여 몇 배로 부풀어 오른다.
//
//   node spikes/cli/token-ratio.mjs            전체
//   node spikes/cli/token-ratio.mjs --only claude
//   node spikes/cli/token-ratio.mjs --only gemini
//
// 비용: claude 호출 6회. 고정 오버헤드가 대부분이라 회당 $0.13 안팎이다 (M0 실측).
import { spawn } from 'node:child_process';
import { resolveBin } from './win-bin.mjs';

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i === -1 ? null : process.argv[i + 1];
};
const only = arg('--only');

/* ------------------------------------------------------------------ *
 * 합성 한국어. 세 갈래로 나눈 이유는 갈래마다 배수가 다를 것이기 때문이다.
 * 위키 페이지는 front-matter 와 앵커가 섞여 있어 순수 산문과 다르다.
 * ------------------------------------------------------------------ */

const PROSE = (n) =>
  Array.from({ length: n }, (_, i) =>
    `${i + 1}번 협력사와의 계약 조건을 다시 확인했다. 단가는 지난 분기보다 올랐고 납기는 그대로다. ` +
    `구매팀은 이 조건으로 진행하되 검수 기준을 한 줄 더 넣기로 했다.`,
  ).join('\n');

const PAGE = (n) =>
  Array.from({ length: n }, (_, i) =>
    `---\nid: ent-vendor-${i}\ntype: entity\ntitle: 협력사 ${i}호\n` +
    `summary: 구매팀이 관리하는 협력사.\nclassification: internal\n` +
    `claims:\n  - text: 단가가 지난 분기보다 올랐다.\n    source: src-kickoff#slide-${i}\n` +
    `    confidence: EXTRACTED\n---\n# 협력사 ${i}호\n\n` +
    `단가가 지난 분기보다 올랐다.[^src-kickoff#slide-${i}]\n`,
  ).join('\n');

const MIXED = (n) =>
  Array.from({ length: n }, (_, i) =>
    `${i + 1}. ACME Corp. 의 SLA 는 99.9% 이고 갱신일은 2026-12-31 이다. ` +
    `PO 번호 PO-2026-${String(i).padStart(4, '0')} 로 처리한다. 담당은 구매팀 대리다.`,
  ).join('\n');

const KINDS = [
  { id: 'prose', label: '한국어 산문', gen: PROSE, small: 3, large: 24 },
  { id: 'page', label: '위키 페이지', gen: PAGE, small: 2, large: 16 },
  { id: 'mixed', label: '한영 혼용', gen: MIXED, small: 3, large: 24 },
];

/** 답을 짧게 받는다. 재는 것은 입력 토큰이라 출력은 짧을수록 좋다. */
const wrap = (body) => `아래 글을 읽고 "확인" 두 글자만 답하라. 다른 말은 하지 마라.\n\n${body}\n`;

/* ------------------------------------------------------------------ */

function run(bin, args, stdin, timeoutMs = 180_000) {
  return new Promise((resolve) => {
    const p = spawn(bin.path, args, { shell: bin.shell, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      stderr += `\n${timeoutMs / 1000}초 안에 응답이 없어 포기했습니다`;
      done();
    }, timeoutMs);
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('error', (e) => {
      stderr += `\n${e.message}`;
      done();
    });
    p.on('close', done);
    p.stdin.on('error', () => {});
    p.stdin.write(stdin);
    p.stdin.end();
  });
}

/**
 * 입력 토큰 전부를 센다. 캐시에 올라간 것도 입력이다 — `input_tokens` 만 보면 두 호출의
 * 캐시 상태가 다를 때 기울기가 엉킨다.
 */
function claudeInputTokens(stdout) {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  const u = j.usage ?? {};
  const n =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
  return n > 0 ? n : null;
}

const lines = [];
const fail = (m) => {
  console.error(m);
  process.exit(2);
};

/* ---------------- 자가 검사 — CLI 를 안 부르고 셈만 확인한다 (CLAUDE.md §9) ---------------- */

if (process.argv.includes('--selftest')) {
  const eq = (got, want, name) => {
    if (got !== want) {
      console.error(`FAIL  ${name}  ${got} !== ${want}`);
      process.exit(1);
    }
    console.log(`PASS  ${name}`);
  };
  // 캐시에 올라간 것도 입력이다. 셋을 더해야 두 호출의 캐시 상태가 달라도 기울기가 산다.
  eq(claudeInputTokens('{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}'), 17, '입력 토큰 셋을 더한다');
  eq(claudeInputTokens('{"usage":{}}'), null, '토큰이 없으면 null');
  eq(claudeInputTokens('JSON 아님'), null, 'JSON 이 아니면 null');
  // 기울기가 고정 오버헤드를 상쇄하는가. 오버헤드 30000, 자당 0.5 토큰인 가짜 CLI 를 가정한다.
  const fake = (chars) => 30000 + chars * 0.5;
  eq(Number(((fake(2000) - fake(200)) / (2000 - 200)).toFixed(3)), 0.5, '기울기가 오버헤드를 상쇄한다');
  // 갈래마다 짧은 쪽과 긴 쪽이 실제로 갈려 있어야 기울기가 의미를 갖는다.
  for (const k of KINDS) {
    const a = [...k.gen(k.small)].length;
    const b = [...k.gen(k.large)].length;
    eq(b > a * 4, true, `${k.label} 두 길이가 4배 넘게 벌어진다 (${a} → ${b})`);
  }
  console.log('\n전부 통과');
  process.exit(0);
}

/* ---------------- A. claude — 한국어 토큰 환산 (W10) ---------------- */

if (only !== 'gemini') {
  const bin = resolveBin('claude');
  if (bin === null) fail('claude 를 찾지 못했습니다. `where claude` 가 무엇을 주는지 확인하십시오.');

  const out = [];
  for (const k of KINDS) {
    const pts = [];
    for (const rep of [k.small, k.large]) {
      const body = k.gen(rep);
      const prompt = wrap(body);
      const r = await run(bin, ['-p', '--output-format', 'json'], prompt);
      const tok = claudeInputTokens(r.stdout);
      if (tok === null) {
        console.error(`claude 가 토큰 수를 주지 않았습니다 (${k.label}, ${rep}배).`);
        console.error(`  실행 파일: ${bin.path}${bin.shell ? '  [cmd 경유]' : ''}`);
        console.error(`  stdout 앞 200자: ${r.stdout.trim().slice(0, 200) || '(빈 응답)'}`);
        console.error(`  stderr 앞 200자: ${r.stderr.trim().slice(0, 200) || '(없음)'}`);
        process.exit(2);
      }
      pts.push({ chars: [...body].length, tok });
      process.stderr.write(`  ${k.label} ${rep}배: ${pts.at(-1).chars}자 → ${tok}토큰\n`);
    }
    const dChars = pts[1].chars - pts[0].chars;
    const dTok = pts[1].tok - pts[0].tok;
    out.push(`${k.id}=${(dTok / dChars).toFixed(3)}`);
  }
  lines.push(`1 W10 claude 토큰/자  ${out.join(' ')}`);
}

/* ---------------- B. gemini — 봉투에 무엇이 오는가 (W10 · W11) ---------------- */

if (only !== 'claude') {
  const bin = resolveBin('gemini');
  if (bin === null) fail('gemini 를 찾지 못했습니다. `where gemini` 가 무엇을 주는지 확인하십시오.');

  const r = await run(bin, ['--skip-trust', '--approval-mode', 'plan', '-o', 'json'], '"확인" 두 글자만 답하라.\n');
  // **오류 봉투는 stderr 로 온다** (0.58.0 실측, 종료 코드 41). 성공 봉투는 stdout 이다.
  // 둘 다 안 보면 쿼터 오류의 모양을 놓친다 — W11 이 필요로 하는 것이 바로 그 모양이다.
  let j = null;
  for (const raw of [r.stdout, r.stderr]) {
    if (j !== null) break;
    try {
      j = JSON.parse(raw.trim());
    } catch {
      /* 다음 것 */
    }
  }
  if (j === null) {
    lines.push(`2 W10 gemini  JSON 아님`);
    lines.push(`3 W11 봉투    앞 120자: ${(r.stdout + r.stderr).trim().slice(0, 120) || '(빈 응답)'}`);
  } else {
    // **본문은 안 적는다.** 키 이름과 숫자만 낸다.
    const keys = Object.keys(j).join(',');
    const nums = [];
    for (const [k, v] of Object.entries(j)) {
      if (!/stat|usage|token|quota|limit|metric/i.test(k)) continue;
      nums.push(`${k}=${JSON.stringify(v).slice(0, 200)}`);
    }
    lines.push(`2 W10 gemini  키: ${keys}`);
    lines.push(`3 W11 봉투    ${nums.join(' ') || '토큰·쿼터 필드 없음'}`);
    if (j.error) lines.push(`4 오류       code=${j.error.code} ${String(j.error.message).slice(0, 100)}`);
  }
}

console.log('');
console.log('===== 아래 줄만 적어 주세요 =====');
for (const l of lines) console.log(l);
console.log('=================================');
console.log('');
console.log('토큰/자 가 클수록 같은 글자 수에 토큰을 많이 먹는다. 영어는 대략 0.25 안팎이다.');
console.log('2번에 stats 나 usage 같은 키가 있으면 Gemini 지출도 셀 수 있다는 뜻이다.');
