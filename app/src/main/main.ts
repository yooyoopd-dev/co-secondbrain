// Electron 진입점. 창을 띄우고 IPC 핸들러를 등록한다. PLAN.md §11
//
// 렌더러는 파일시스템에 직접 닿지 않는다. `ipc.ts` 의 SbApi 에 적힌 것이 표면의 전부이고
// 그 밖의 것은 부를 수 없다. 그래서 여기서 sandbox 를 켜고 항해를 막는다 —
// **이 앱이 브라우저가 되면 안 된다.** 사내 문서를 다루는 도구라 그게 곧 유출 경로다.
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IPC } from './ipc.ts';
import { Store } from './store.ts';
import { credStore, type Cipher } from './creds.ts';
import { SOURCE_KIND_BY_EXT, type Classification } from '../core/types.ts';
import { LogBuffer, formatLog } from '../core/log.ts';
import type { Answer } from '../core/query.ts';

/**
 * 오류 기록. **메모리에만 있다** — 디스크에 로그 파일을 남기지 않는다.
 * 적재 시점에 파일명과 토큰이 지워지므로(core/log.ts) 여기 담긴 것은 그대로 복사해도 된다.
 */
const log = new LogBuffer();

/**
 * OS 자격 증명 저장소. Windows 는 DPAPI, macOS 는 Keychain 이다.
 * Linux 에서 키링이 없으면 Electron 이 `basic_text` 로 떨어지는데 그건 난독화라
 * **불가로 본다.** 그 경우 앱은 토큰을 저장하지 않고 사유를 화면에 띄운다.
 */
const cipher: Cipher = {
  available: () => {
    if (!safeStorage.isEncryptionAvailable()) return false;
    if (process.platform !== 'linux') return true;
    return safeStorage.getSelectedStorageBackend() !== 'basic_text';
  },
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (enc) => safeStorage.decryptString(enc),
};

// 지출은 Vault 가 아니라 계정 단위로 쌓는다. Vault 별로 세면 상한을 두 배로 쓴다.
const store = new Store({
  // 토큰은 Vault 폴더가 아니라 사용자 데이터 폴더에 암호문으로 둔다 (creds.ts)
  tokens: credStore(path.join(app.getPath('userData'), 'hub-creds.json'), cipher),
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
    backgroundColor: '#f7f4ed', // DESIGN-SYSTEM.md --bg-canvas. 첫 프레임 깜빡임을 막는다
    icon: path.join(import.meta.dirname, '../renderer/icon-256.png'),
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

  // 렌더러가 죽거나 preload 가 안 뜨면 화면에는 아무것도 안 나온다. 그때도 기록은 남는다.
  win.webContents.on('render-process-gone', (_e, d) => log.add('error', 'renderer', `렌더러가 죽었습니다 (${d.reason})`));
  win.webContents.on('preload-error', (_e, p, err) => log.fail(`preload:${path.basename(p)}`, err));
  win.webContents.on('unresponsive', () => log.add('warn', 'renderer', '창이 응답하지 않습니다'));
  // 렌더러 콘솔의 오류만 가져온다. 나머지는 소음이다.
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') log.add('error', 'console', e.message);
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'));
  return win;
}

/* ------------------------------------------------------------------ *
 * IPC — ipc.ts 의 SbApi 와 1:1 이다. 여기 없는 것은 렌더러가 못 부른다.
 * ------------------------------------------------------------------ */

const EXTENSIONS = Object.keys(SOURCE_KIND_BY_EXT).map((e) => e.slice(1));

/**
 * 모든 IPC 가 이걸 거친다. 던져진 것은 기록하고 **그대로 다시 던진다** —
 * 화면 동작은 전과 같고 기록만 남는다. 삼키면 실패가 조용해져서 더 나빠진다.
 */
function handle(channel: string, fn: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return await fn(e, ...args);
    } catch (err) {
      log.fail(channel, err);
      throw err;
    }
  });
}

function registerIpc(): void {
  handle(IPC.pickVault, async (_e, mode: 'open' | 'create') => {
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

  handle(IPC.currentVault, () => store.vault?.config ?? null);

  handle(IPC.pickAndIngest, async (_e, classification: Classification) => {
    const r = await dialog.showOpenDialog({
      title: '문서 추가',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '문서', extensions: EXTENSIONS }],
    });
    if (r.canceled) return { ok: [], failed: [], warnings: [], relations: 0 };
    return store.ingest(r.filePaths, classification);
  });

  handle(IPC.inbox, () => store.inbox());
  handle(IPC.ingestInbox, (_e, classification: Classification) => store.ingestInbox(classification));

  handle(IPC.listSources, () => store.listSources());
  handle(IPC.search, (_e, q: string) => store.search(q));
  handle(IPC.readSource, (_e, id: string) => store.readSource(id));

  // 관문 8 — 제안은 디스크를 건드리지 않는다. 적용만 쓴다.
  handle(IPC.propose, (_e, id: string) => store.propose(id));
  handle(IPC.applyReview, (_e, approved: string[]) => store.applyReview(approved));
  handle(IPC.discardReview, () => store.discardReview());
  handle(IPC.editOp, (_e, path: string, content: string) => store.editOp(path, content));
  handle(IPC.spendStatus, () => store.spendStatus());
  handle(IPC.plan, () => store.plan());
  handle(IPC.ask, (_e, q: string) => store.ask(q));
  handle(IPC.archiveAnswer, (_e, q: string, a: Answer) => store.archiveAnswer(q, a));
  handle(IPC.estimateJudgment, () => store.estimateJudgment());
  handle(IPC.lintJudgment, () => store.lintJudgment());

  // 동기화 — 충돌은 디스크를 안 건드린다. 병합 결과만 다시 올라간다 (HUB.md §5)
  handle(IPC.hubStatus, () => store.hubStatus());
  handle(IPC.connectHub, (_e, url: string, token: string) => store.connectHub(url, token));
  handle(IPC.disconnectHub, () => store.disconnectHub());
  handle(IPC.syncNow, () => store.syncNow());
  handle(IPC.conflicts, () => store.conflicts());
  handle(IPC.resolveConflict, (_e, pageId: string, merged: string) => store.resolveConflict(pageId, merged));

  // 덱은 core 가 문자열로 만들고 파일로 쓰는 것은 여기서 한다.
  handle(IPC.exportDeck, async () => {
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

  /* 오류 기록 — 무엇이 실패했는지 사람이 통째로 옮길 수 있어야 한다 */

  handle(IPC.logs, () => ({ entries: log.entries(), errors: log.errorCount() }));
  handle(IPC.clearLogs, () => log.clear());
  handle(IPC.reportError, (_e, scope: string, message: string, detail?: string) => {
    log.add('error', `renderer:${scope}`, message, detail);
  });
  handle(IPC.copyLogs, () => {
    const entries = log.entries();
    clipboard.writeText(formatLog(entries, environment()));
    return entries.length;
  });
  handle(IPC.saveLogs, async () => {
    const r = await dialog.showSaveDialog({
      title: '오류 기록 저장',
      defaultPath: `co-secondbrain-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: '텍스트', extensions: ['log', 'txt'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, formatLog(log.entries(), environment()), 'utf8');
    return r.filePath;
  });
}

/** 기록 머리말. 금고 경로와 이름은 넣지 않는다 — 열렸는지만 적는다 */
function environment(): Record<string, string> {
  return {
    앱: app.getVersion(),
    실행: `${process.platform} ${process.arch} · Electron ${process.versions['electron']} · Chromium ${process.versions['chrome']}`,
    금고: store.vault ? '열림' : '닫힘',
  };
}

/* ------------------------------------------------------------------ */

// 크래시 리포터를 안 두기로 했으므로(README) 프로세스가 죽기 전에 여기서 붙잡는다.
// 앱은 계속 돌고, 사람이 [오류] 패널에서 사유를 복사해 갈 수 있다.
process.on('uncaughtException', (err) => log.fail('main:uncaught', err));
process.on('unhandledRejection', (err) => log.fail('main:rejection', err));

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
