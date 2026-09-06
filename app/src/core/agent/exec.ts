// CLI 서브프로세스 실행. 어댑터가 공유한다.
//
// **프롬프트는 stdin 으로 넘긴다.** 사내 PC 는 Windows 이고 `.cmd` 를 띄우려면 shell 을
// 거쳐야 해서 argv 인용부호가 위험해진다. 2026-09-05 실측에서 `claude` 는 `-p` 를 인자
// 없이 두고, `gemini` 는 `-p` 를 아예 빼면 stdin 을 읽는다.
import { spawn } from 'node:child_process';
import type { Exec } from './types.ts';

export const TIMEOUT_MS = 5 * 60_000;

export const realExec: Exec = (bin, argv, opts) =>
  new Promise((resolve, reject) => {
    const p = spawn(bin, argv as string[], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (r: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // 죽이는 것과 포기하는 것을 나눈다. SIGKILL 을 보내도 close 가 안 오는 경우를 봤다.
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      p.stdout.destroy();
      p.stderr.destroy();
      done({ stdout, stderr: `${stderr}\n${TIMEOUT_MS / 1000}초 안에 응답이 없어 포기했습니다`, code: -1 });
    }, TIMEOUT_MS);

    p.stdout.on('data', (c: Buffer) => (stdout += c));
    p.stderr.on('data', (c: Buffer) => (stderr += c));
    p.on('error', (e) => {
      clearTimeout(timer);
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
