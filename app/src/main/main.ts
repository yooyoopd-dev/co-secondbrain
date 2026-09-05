// Electron 진입점. 창을 띄우고 IPC 핸들러를 등록한다. PLAN.md §11
//
// 렌더러는 파일시스템에 직접 닿지 않는다. `ipc.ts` 의 SbApi 에 적힌 것이 표면의 전부이고
// 그 밖의 것은 부를 수 없다. 그래서 여기서 sandbox 를 켜고 항해를 막는다 —
// **이 앱이 브라우저가 되면 안 된다.** 사내 문서를 다루는 도구라 그게 곧 유출 경로다.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IPC } from './ipc.ts';
import { Store } from './store.ts';
import { SOURCE_KIND_BY_EXT } from '../core/types.ts';
import type { Answer } from '../core/query.ts';

// 지출은 Vault 가 아니라 계정 단위로 쌓는다. Vault 별로 세면 상한을 두 배로 쓴다.
const store = new Store({
  spendFile: path.join(app.getPath('userData'), 'spend.json'),
  // CLI 가 MCP 서버를 서브프로세스로 띄운다. 패키징본에는 node 가 없으므로
  // Electron 자신을 ELECTRON_RUN_AS_NODE 로 돌린다 (PLAN.md §7.2).
  mcpLaunch: (vaultRoot) => ({
    command: process.execPath,
    args: [path.join(import.meta.dirname, 'mcp-entry.js'), vaultRoot],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }),
});

/** 개발 중에는 vite 서버를, 배포본에서는 빌드된 파일을 연다. */
const DEV_URL = process.env['SB_DEV_URL'] ?? null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    backgroundColor: '#000000', // DESIGN-SYSTEM.md --bg-canvas. 흰 깜빡임을 막는다
    show: false,
    webPreferences: {
      // preload 는 CommonJS 다. sandbox 를 켜면 ESM preload 를 못 쓴다 —
      // 샌드박스를 끄는 것보다 preload 만 CJS 로 내보내는 편이 낫다.
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 항해 차단 — 렌더러가 외부 주소로 넘어가지 못하게 한다.
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });
  // 새 창은 열지 않는다. 외부 링크는 기본 브라우저로 넘긴다.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

/* ------------------------------------------------------------------ *
 * IPC — ipc.ts 의 SbApi 와 1:1 이다. 여기 없는 것은 렌더러가 못 부른다.
 * ------------------------------------------------------------------ */

const EXTENSIONS = Object.keys(SOURCE_KIND_BY_EXT).map((e) => e.slice(1));

function registerIpc(): void {
  ipcMain.handle(IPC.pickVault, async (_e, mode: 'open' | 'create') => {
    const r = await dialog.showOpenDialog({
      title: mode === 'create' ? '새 Vault 를 만들 빈 폴더' : '기존 Vault 폴더',
      properties: mode === 'create' ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    });
    const root = r.filePaths[0];
    if (r.canceled || !root) return null;
    const title = path.basename(root);
    const v = await store.open(root, mode === 'create' ? { id: title, title } : undefined);
    return v.config;
  });

  ipcMain.handle(IPC.currentVault, () => store.vault?.config ?? null);

  ipcMain.handle(IPC.pickAndIngest, async () => {
    const r = await dialog.showOpenDialog({
      title: '문서 추가',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '문서', extensions: EXTENSIONS }],
    });
    if (r.canceled) return { ok: [], failed: [], warnings: [], relations: 0 };
    return store.ingest(r.filePaths);
  });

  ipcMain.handle(IPC.listSources, () => store.listSources());
  ipcMain.handle(IPC.search, (_e, q: string) => store.search(q));
  ipcMain.handle(IPC.readSource, (_e, id: string) => store.readSource(id));

  // 관문 8 — 제안은 디스크를 건드리지 않는다. 적용만 쓴다.
  ipcMain.handle(IPC.propose, (_e, id: string) => store.propose(id));
  ipcMain.handle(IPC.applyReview, (_e, approved: string[]) => store.applyReview(approved));
  ipcMain.handle(IPC.discardReview, () => store.discardReview());
  ipcMain.handle(IPC.editOp, (_e, path: string, content: string) => store.editOp(path, content));
  ipcMain.handle(IPC.spendStatus, () => store.spendStatus());
  ipcMain.handle(IPC.plan, () => store.plan());
  ipcMain.handle(IPC.ask, (_e, q: string) => store.ask(q));
  ipcMain.handle(IPC.archiveAnswer, (_e, q: string, a: Answer) => store.archiveAnswer(q, a));
  ipcMain.handle(IPC.estimateJudgment, () => store.estimateJudgment());
  ipcMain.handle(IPC.lintJudgment, () => store.lintJudgment());

  // 덱은 core 가 문자열로 만들고 파일로 쓰는 것은 여기서 한다.
  ipcMain.handle(IPC.exportDeck, async () => {
    const vault = store.vault;
    if (!vault) return null;
    const r = await dialog.showSaveDialog({
      title: '슬라이드 내보내기',
      defaultPath: `${vault.config.title}.md`,
      filters: [{ name: 'Marp 마크다운', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, await store.exportDeck(vault.config.title), 'utf8');
    return r.filePath;
  });
}

/* ------------------------------------------------------------------ */

// 창을 두 개 띄우면 같은 Vault 를 두 Store 가 잡는다. 하나만 돈다.
if (!app.requestSingleInstanceLock()) app.quit();

void app.whenReady().then(() => {
  registerIpc();
  const win = createWindow();
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  store.close();
  if (process.platform !== 'darwin') app.quit();
});
