// Windows 에서 실행 파일 자리를 찾는다. `app/src/core/agent/exec.ts` 의 `pickWindowsBin`
// 과 같은 규칙이다.
//
// **npm 전역 설치는 확장자 없는 껍데기를 같이 깐다.** `gemini` · `gemini.cmd` ·
// `gemini.ps1` 이 한 폴더에 있고 `where` 는 확장자 없는 것을 먼저 준다. 그것은 sh
// 스크립트라 CreateProcess 가 못 읽고 `spawn ... ENOENT` 로 죽는다.
// 2026-09-07 사내 PC 1회차가 이것 때문에 전부 넘어졌다 (ROADMAP.md §8).
//
// `record.mjs` 는 사내에서 파일 하나만 옮겨 돌릴 수 있어야 해서 같은 규칙을 자기 안에
// 복사해 갖고 있다. 규칙을 고치면 그쪽도 같이 고친다.
import { spawnSync } from 'node:child_process';

/** `.exe` 를 먼저 쓴다. `.cmd` 는 cmd.exe 를 거쳐야 하고 거기서 인용부호가 깨진다. */
export function resolveBin(bin) {
  if (process.platform !== 'win32') return { path: bin, shell: false };
  const out = spawnSync('where', [bin], { encoding: 'utf8' }).stdout ?? '';
  const found = out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => /\.(exe|com|cmd|bat)$/i.test(s));
  const pick = found.find((f) => /\.(exe|com)$/i.test(f)) ?? found[0] ?? null;
  return pick === null ? null : { path: pick, shell: /\.(cmd|bat)$/i.test(pick) };
}
