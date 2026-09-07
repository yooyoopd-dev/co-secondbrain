// CLI 서브프로세스 실행. 어댑터가 공유한다.
//
// **프롬프트는 stdin 으로 넘긴다.** 사내 PC 는 Windows 이고 `.cmd` 를 띄우려면 shell 을
// 거쳐야 해서 argv 인용부호가 위험해진다. 2026-09-05 실측에서 `claude` 는 `-p` 를 인자
// 없이 두고, `gemini` 는 `-p` 를 아예 빼면 stdin 을 읽는다.
import { spawn, spawnSync } from 'node:child_process';
import type { Exec } from './types.ts';

export const TIMEOUT_MS = 5 * 60_000;

/**
 * `where` 가 준 줄 중에서 실제로 띄울 수 있는 것을 고른다.
 *
 * **npm 전역 설치는 확장자 없는 껍데기를 같이 깐다.** `gemini` · `gemini.cmd` ·
 * `gemini.ps1` 이 한 폴더에 있고 `where` 는 확장자 없는 것을 먼저 준다. 그것은 sh
 * 스크립트라 CreateProcess 가 못 읽고 `spawn ... ENOENT` 로 죽는다.
 * 2026-09-07 사내 PC 실측에서 Gemini 가 이것 때문에 열 번 다 안 떴다 (ROADMAP §8).
 *
 * `.exe` 를 먼저 쓴다. `.cmd` 는 cmd.exe 를 거쳐야 하고 거기서 인용부호가 깨진다.
 */
export function pickWindowsBin(bin: string, whereOut: string): { path: string; shell: boolean } {
  const found = whereOut
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /\.(exe|com|cmd|bat)$/i.test(s));
  const pick = found.find((f) => /\.(exe|com)$/i.test(f)) ?? found[0] ?? bin;
  return { path: pick, shell: /\.(cmd|bat)$/i.test(pick) };
}

/**
 * cmd.exe 를 거칠 때 Node 의 인용 처리가 지켜 주지 못하는 글자들. claude-code 는
 * 스키마 JSON 을 argv 로 넘기므로 조용히 깨지면 모델이 못 맞춘 것처럼 보인다.
 * 그런 결과를 받느니 안 도는 편이 낫다 (설정 화면의 공급자 고정과 같은 원칙).
 */
const CMD_UNSAFE = /["^&|<>%\r\n]/;

const resolvedBins = new Map<string, { path: string; shell: boolean }>();

/** 실행 파일 자리를 찾는다. Windows 밖에서는 아무것도 하지 않는다. */
function resolveBin(bin: string): { path: string; shell: boolean } {
  if (process.platform !== 'win32') return { path: bin, shell: false };
  const cached = resolvedBins.get(bin);
  if (cached) return cached;
  const r = spawnSync('where', [bin], { encoding: 'utf8' });
  const out = pickWindowsBin(bin, r.stdout ?? '');
  resolvedBins.set(bin, out);
  return out;
}

export const realExec: Exec = (bin, argv, opts) =>
  new Promise((resolve, reject) => {
    const target = resolveBin(bin);
    if (target.shell && argv.some((a) => CMD_UNSAFE.test(a))) {
      reject(new Error(`${bin} 은 cmd 껍데기(${target.path})로만 있습니다. 인자가 깨지므로 띄우지 않습니다`));
      return;
    }
    if (opts.signal?.aborted) {
      resolve({ stdout: '', stderr: '사람이 취소했습니다', code: -2 });
      return;
    }
    const p = spawn(target.path, argv as string[], {
      cwd: opts.cwd,
      env: opts.env,
      shell: target.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (r: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };

    // 취소는 실패가 아니다. 부르는 쪽이 signal.aborted 로 사유를 구분한다.
    const onAbort = () => {
      p.kill('SIGKILL');
      done({ stdout, stderr: `${stderr}\n사람이 취소했습니다`, code: -2 });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // 죽이는 것과 포기하는 것을 나눈다. SIGKILL 을 보내도 close 가 안 오는 경우를 봤다.
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      p.stdout.destroy();
      p.stderr.destroy();
      done({ stdout, stderr: `${stderr}\n${TIMEOUT_MS / 1000}초 안에 응답이 없어 포기했습니다`, code: -1 });
    }, TIMEOUT_MS);

    p.stdout.on('data', (c: Buffer) => {
      stdout += c;
      opts.onOutput?.(String(c), 'stdout');
    });
    p.stderr.on('data', (c: Buffer) => {
      stderr += c;
      opts.onOutput?.(String(c), 'stderr');
    });
    p.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    p.on('close', (code) => done({ stdout, stderr, code: code ?? -1 }));

    // CLI 가 stdin 을 안 읽고 끝나면 EPIPE 가 난다. 그건 실패가 아니다.
    p.stdin.on('error', () => {});
    if (opts.stdin !== undefined) p.stdin.write(opts.stdin);
    p.stdin.end();
  });
