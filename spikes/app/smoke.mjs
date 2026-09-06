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
  // Windows 의 실제 파일은 npm.cmd 다. shell 없이 spawn 하면 ENOENT 로 죽는다.
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true });
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

// 설정 — 금고를 안 열어도 열려야 한다. 못 여는 것 자체가 설정 문제일 때가 있다.
const st = await win.evaluate(() => window.sb.settings());
ok('금고 없이도 설정이 열린다', st.vaultRoot === null && /^\d+\.\d+\.\d+/.test(st.version), st);
ok('설정이 공급자 셋을 준다', st.providers.length === 3 && st.providers.every((p) => typeof p.installed === 'boolean'), st.providers);

// 공급자 고정이 왕복하는가. 끝나고 자동으로 되돌린다.
const fixed = await win.evaluate(async () => {
  await window.sb.setProvider('gemini');
  const a = (await window.sb.settings()).provider;
  await window.sb.setProvider(null);
  return { a, b: (await window.sb.settings()).provider };
});
ok('공급자 고정이 왕복한다', fixed.a === 'gemini' && fixed.b === null, fixed);

// 허브 토큰은 OS 자격 증명 저장소에 넣는다. **여기서 재는 것은 어떤 백엔드가 잡히는가**이고
// 리눅스 컨테이너에는 키링이 없어 값 자체는 사내·Windows 와 다르다.
// Windows 에서는 available=true 여야 한다 (DPAPI). 아니면 앱이 연결을 거절한다.
const cred = await app.evaluate(({ safeStorage }) => ({
  platform: process.platform,
  available: safeStorage.isEncryptionAvailable(),
  backend: process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null,
}));
ok('safeStorage 를 물어도 앱이 죽지 않는다', typeof cred.available === 'boolean', cred);
console.log(`      자격 증명 저장소: ${JSON.stringify(cred)}`);

// 첫 화면에 300ms 진입 애니메이션이 있다. 끝나기 전에 찍으면 전부 흐리게 나온다.
await win.waitForTimeout(700);

// 3-pane 셸이 창을 넘치면 안 된다. 넘치면 스크롤바가 생겨 폭이 밀린다.
const overflow = await win.evaluate(() => ({
  v: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  h: document.documentElement.scrollWidth - document.documentElement.clientWidth,
}));
ok('창을 넘치지 않는다', overflow.v <= 0 && overflow.h <= 0, overflow);

// 기본 버튼은 accent 채움에 흰 글자다 (DESIGN-SYSTEM.md §3)
const btn = await win.evaluate(() => {
  const el = document.querySelector('button.primary');
  if (!el) return null;
  const c = getComputedStyle(el);
  return { bg: c.backgroundColor, fg: c.color, radius: c.borderRadius, body: getComputedStyle(document.body).backgroundColor };
});
ok('기본 버튼이 accent 배경에 흰 글자다', btn?.bg === 'rgb(29, 78, 216)' && btn?.fg === 'rgb(255, 255, 255)', btn);
ok('바탕이 크림이다', btn?.body === 'rgb(247, 244, 237)', btn?.body);
ok('버튼이 알약 모양이다', btn?.radius === '9999px', btn?.radius);

// 아이콘이 실제로 붙었는가. 경로가 어긋나면 창 아이콘도 같이 깨진다.
const mark = await win.evaluate(() => {
  const i = document.querySelector('img');
  return i ? { src: i.getAttribute('src'), w: i.naturalWidth } : null;
});
ok('앱 아이콘이 그려진다', mark?.w > 0, mark);

// 오류 기록 — 렌더러에서 난 것이 main 버퍼로 가고, 복사본에 파일 이름이 없어야 한다.
// 이 두 줄이 무너지면 사내 문서 이름이 클립보드로 나간다.
await win.evaluate(() => window.sb.reportError('smoke', 'C:\\docs\\킥오프 발표.pptx 를 열지 못했습니다'));
const snap = await win.evaluate(() => window.sb.logs());
ok('렌더러 오류가 main 버퍼로 간다', snap.errors >= 1, snap.errors);
ok('버퍼에 파일 이름이 없다', !JSON.stringify(snap.entries).includes('킥오프'), snap.entries.at(-1));

const copied = await win.evaluate(() => window.sb.copyLogs());
const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
ok('복사본이 클립보드로 들어간다', copied >= 1 && clip.includes('co-secondbrain 오류 기록'), { copied, head: clip.slice(0, 48) });
ok('복사본에도 파일 이름이 없다', !clip.includes('킥오프'), clip.slice(0, 200));

await win.screenshot({ path: path.join(APP, '..', 'spikes', 'out', 'app.png') }).catch(() => {});
await app.close();

console.log(fails.length === 0 ? '\n전부 통과' : `\n실패 ${fails.length}건: ${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);
