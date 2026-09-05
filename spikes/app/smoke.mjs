#!/usr/bin/env node
// 앱이 실제로 뜨는가. docs/ROADMAP.md 2번의 완료 기준.
//
// 창을 띄워 놓고 렌더러에서 `window.sb` 를 직접 불러 본다. 이게 되면 세 가지가 동시에
// 확인된다 — preload 가 sandbox 를 켠 채로 실행됐고, contextBridge 표면이 붙었고,
// ipcMain 핸들러가 등록됐다.
//
// **개발 컨테이너 전용 검사다.** playwright 를 전역에서 빌려 쓰고, 컨테이너가 root 라
// `--no-sandbox` 를 붙인다. 사내 PC 는 이 스크립트를 돌리지 않는다.
//
//   xvfb-run -a node spikes/app/smoke.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');

// ESM 은 NODE_PATH 를 보지 않는다. 전역 설치 위치를 npm 에게 직접 물어 절대 경로로 연다.
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    /* 지역 설치 없음 */
  }
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' });
  const root = r.stdout?.trim();
  if (!root) return null;
  try {
    return await import(pathToFileURL(path.join(root, 'playwright', 'index.mjs')).href);
  } catch {
    return null;
  }
}

const pw = await loadPlaywright();
if (!pw) {
  console.error('playwright 를 찾지 못했습니다. `npm i -g playwright` 후 다시 돌리십시오.');
  process.exit(2);
}
const { _electron } = pw;

const fails = [];
const ok = (name, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${JSON.stringify(got)}`}`);
  if (!cond) fails.push(name);
};

// 컨테이너가 root 라 크로미움 OS 샌드박스를 끈다. 렌더러의 webPreferences.sandbox 와 무관하다.
// 전역 playwright 는 자기 node_modules 에서 electron 을 찾는다. 앱 쪽 것을 직접 가리킨다.
const exeName = fs.readFileSync(path.join(APP, 'node_modules/electron/path.txt'), 'utf8').trim();
const executablePath = path.join(APP, 'node_modules/electron/dist', exeName);

const app = await _electron.launch({ args: ['.', '--no-sandbox'], cwd: APP, executablePath });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');

ok('창 제목', (await win.title()) === 'co-secondbrain', await win.title());
ok('첫 화면이 그려진다', (await win.locator('text=새 Vault 만들기').count()) === 1);

// contextBridge 표면 — ipc.ts 에 적힌 것이 전부여야 한다.
// 기대 목록을 손으로 적으면 채널이 늘 때마다 낡는다. 실제로 한 번 낡았다.
const ipcSrc = fs.readFileSync(path.join(APP, 'src/main/ipc.ts'), 'utf8');
const block = ipcSrc.slice(ipcSrc.indexOf('export const IPC'));
const expected = [...block.slice(0, block.indexOf('} as const')).matchAll(/^\s{2}(\w+):\s*'sb:/gm)].map((m) => m[1]).sort();
const surface = await win.evaluate(() => Object.keys(window.sb ?? {}).sort());
ok('window.sb 표면이 ipc.ts 와 같다', expected.length > 5 && JSON.stringify(surface) === JSON.stringify(expected), { surface, expected });
ok('노출된 것 말고는 없다', await win.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'));

// IPC 왕복 — Vault 를 안 열었으니 null 과 빈 배열이 정답이다
ok('IPC currentVault', (await win.evaluate(() => window.sb.currentVault())) === null);
ok('IPC search', JSON.stringify(await win.evaluate(() => window.sb.search('없는말'))) === '[]');

// 첫 화면에 420ms 진입 애니메이션이 있다. 끝나기 전에 찍으면 전부 흐리게 나온다.
await win.waitForTimeout(700);

// 3-pane 셸이 창을 넘치면 안 된다. 넘치면 스크롤바가 생겨 폭이 밀린다.
const overflow = await win.evaluate(() => ({
  v: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
ok('창을 넘치지 않는다', overflow.v <= 0 && overflow.h <= 0, overflow);

// 기본 버튼은 흰 배경에 검은 글자다 (DESIGN-SYSTEM.md)
const btn = await win.evaluate(() => {
  const el = document.querySelector('button.primary');
  if (!el) return null;
  const c = getComputedStyle(el);
  return { bg: c.backgroundColor, fg: c.color };
});
ok('기본 버튼이 흰 배경에 검은 글자다', btn?.bg === 'rgb(255, 255, 255)' && btn?.fg === 'rgb(0, 0, 0)', btn);

await win.screenshot({ path: path.join(APP, '..', 'spikes', 'out', 'app.png') }).catch(() => {});
await app.close();

console.log(fails.length === 0 ? '\n전부 통과' : `\n실패 ${fails.length}건: ${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);
