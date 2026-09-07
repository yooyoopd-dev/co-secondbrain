// W3c — Gemini 가 내장 MCP 서버에 실제로 붙는가.
//
// 2026-09-05 실측에서는 못 붙었다. 격리 작업 디렉터리가 신뢰되지 않아 CLI 가 MCP 를
// 통째로 껐다 (`docs/M2-PLAN.md` §12.2). 2026-09-09 에 사용자가 사내 PC 의 **전역**
// 설정에 `security.folderTrust.enabled: false` 를 넣었다. 그것으로 풀리는지를 여기서 본다.
//
// 앱은 이 결과를 모른 채 이미 Gemini 를 읽기 경로에 넣어 뒀다(`agent/router.ts`).
// 안 붙으면 어댑터가 답을 버리므로 조용히 틀리지는 않지만, **되는지 안 되는지는
// 재 봐야 안다.** 이 스크립트가 그 한 번이다.
//
// 실행: node gemini-mcp-check.mjs
//       node gemini-mcp-check.mjs --selftest   (CLI 를 안 부른다)
//
// 사내에서 돌려도 된다 — **문서를 안 읽고 안 내보낸다.** 임시 폴더에 표식 하나를 두고
// 모델이 그 표식을 도구로 가져오는지만 본다. 화면에 나오는 것은 PASS/FAIL 세 줄이다.
//
// 종료 코드: 0 통과 · 1 실패 · 2 안 돌았음(판정 아님)

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBin } from './win-bin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'mcp-probe.mjs');
const SERVER = 'sb'; // app/src/core/mcp/config.ts 의 SERVER_NAME 과 같아야 한다

/** 앱이 쓰는 것과 같은 조합 (`app/src/core/agent/gemini.ts` buildArgv) */
export function argv() {
  return ['--skip-trust', '--approval-mode', 'plan', '-o', 'json', '--allowed-mcp-server-names', SERVER];
}

/** 앱이 쓰는 것과 같은 설정 (`app/src/core/mcp/config.ts` mcpConfig) */
export function settings(token) {
  return {
    mcpServers: {
      [SERVER]: { command: process.execPath, args: [PROBE], env: { SB_PROBE_TOKEN: token }, trust: true },
    },
  };
}

/** 폴더 신뢰 게이트가 MCP 를 껐는가. 어댑터의 `mcpDisabled` 와 같은 규칙 */
export function mcpDisabled(stderr) {
  return /untrusted/i.test(stderr) && /mcp/i.test(stderr);
}

/** `-o json` 봉투에서 본문만. 어댑터의 `parseEnvelope` 와 같은 자리 */
export function responseOf(stdout) {
  try {
    const j = JSON.parse(stdout.trim());
    if (j && typeof j === 'object' && 'response' in j) return String(j.response ?? '');
  } catch {
    /* 평문이면 그대로 본다 */
  }
  return stdout;
}

let fails = 0;
function ok(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) fails += 1;
}

if (process.argv.includes('--selftest')) {
  const t = 'SB-TEST-0001';
  const a = argv();
  ok('MCP 서버 이름을 좁힌다', a[a.indexOf('--allowed-mcp-server-names') + 1] === SERVER);
  ok('읽기 전용으로 돈다', a.includes('plan'));
  ok('설정이 표식을 환경 변수로 넘긴다', settings(t).mcpServers[SERVER].env.SB_PROBE_TOKEN === t);
  ok('신뢰 경고를 알아본다', mcpDisabled('MCP servers are configured but disabled because this folder is untrusted.'));
  ok('무관한 경고는 안 잡는다', !mcpDisabled('deprecated flag'));
  ok('봉투에서 본문을 꺼낸다', responseOf(JSON.stringify({ response: '가' })) === '가');
  ok('봉투가 아니면 그대로 본다', responseOf('가') === '가');
  process.exit(fails === 0 ? 0 : 1);
}

const BIN = resolveBin('gemini');
if (BIN === null) {
  console.error('gemini 를 찾지 못했습니다. `where gemini` 가 무엇을 주는지 확인하십시오.');
  process.exit(2);
}

const token = `SB-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-'));
fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), JSON.stringify(settings(token), null, 1), 'utf8');

const PROMPT = [
  `도구 목록에 ${SERVER} 서버의 m0_ping 이 있다. 그것을 한 번 호출해라.`,
  '호출 결과로 돌아온 문자열만 그대로 적는다. 다른 말은 붙이지 않는다.',
  '도구를 못 부르면 정확히 NO_TOOL 이라고만 적는다.',
].join('\n');

const r = await new Promise((resolve) => {
  const p = spawn(BIN.path, argv(), { cwd: dir, shell: BIN.shell, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const done = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve({ stdout, stderr, code });
  };
  const timer = setTimeout(() => {
    p.kill('SIGKILL');
    done(-1);
  }, 180_000);
  p.stdout.on('data', (c) => (stdout += c));
  p.stderr.on('data', (c) => (stderr += c));
  p.on('error', (e) => {
    stderr += String(e);
    done(-1);
  });
  p.on('close', done);
  p.stdin.on('error', () => {});
  p.stdin.write(PROMPT);
  p.stdin.end();
});

fs.rmSync(dir, { recursive: true, force: true });

const body = responseOf(r.stdout);
const disabled = mcpDisabled(r.stderr);
const called = body.includes(token);

console.log('');
console.log(`1 신뢰 게이트가 MCP 를 껐는가 : ${disabled ? '껐음' : '안 껐음'}`);
console.log(`2 도구를 실제로 불렀는가     : ${called ? '불렀음' : '못 불렀음'}`);
console.log(`3 종료 코드                  : ${r.code}`);
console.log('');

// 아무것도 안 나왔으면 판정이 아니다. CLI 가 안 뜬 것과 모델이 못 부른 것을 가른다.
if (!body.trim()) {
  console.error('CLI 가 출력을 안 냈습니다. 인증과 판을 확인하십시오. 이 회차는 표본이 아닙니다.');
  console.error(r.stderr.trim().slice(0, 400));
  process.exit(2);
}

ok('폴더 신뢰가 MCP 를 끄지 않는다', !disabled);
ok('모델이 내장 서버의 도구를 불렀다', called);

if (fails > 0) {
  console.log('');
  console.log('둘 중 하나라도 FAIL 이면 사용자 수준 설정을 보십시오:');
  console.log('  ~/.gemini/settings.json 의 security.folderTrust.enabled 가 false 인가');
  console.log('  (프로젝트 수준 설정은 신뢰되지 않은 폴더에서 안 먹습니다 — M2-PLAN.md §12.2)');
}
process.exit(fails === 0 ? 0 : 1);
