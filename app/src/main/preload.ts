// contextBridge — 렌더러가 볼 수 있는 표면은 이 목록이 전부다.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc.ts';

contextBridge.exposeInMainWorld('sb', {
  pickVault: (mode: 'open' | 'create') => ipcRenderer.invoke(IPC.pickVault, mode),
  currentVault: () => ipcRenderer.invoke(IPC.currentVault),
  pickAndIngest: (classification: string) => ipcRenderer.invoke(IPC.pickAndIngest, classification),
  inbox: () => ipcRenderer.invoke(IPC.inbox),
  ingestInbox: (classification: string) => ipcRenderer.invoke(IPC.ingestInbox, classification),
  listSources: () => ipcRenderer.invoke(IPC.listSources),
  search: (q: string) => ipcRenderer.invoke(IPC.search, q),
  readSource: (id: string) => ipcRenderer.invoke(IPC.readSource, id),
  propose: (id: string) => ipcRenderer.invoke(IPC.propose, id),
  applyReview: (approved: string[]) => ipcRenderer.invoke(IPC.applyReview, approved),
  discardReview: () => ipcRenderer.invoke(IPC.discardReview),
  editOp: (path: string, content: string) => ipcRenderer.invoke(IPC.editOp, path, content),
  spendStatus: () => ipcRenderer.invoke(IPC.spendStatus),
  plan: () => ipcRenderer.invoke(IPC.plan),
  ask: (q: string) => ipcRenderer.invoke(IPC.ask, q),
  archiveAnswer: (q: string, a: unknown) => ipcRenderer.invoke(IPC.archiveAnswer, q, a),
  estimateJudgment: () => ipcRenderer.invoke(IPC.estimateJudgment),
  lintJudgment: () => ipcRenderer.invoke(IPC.lintJudgment),
  exportDeck: () => ipcRenderer.invoke(IPC.exportDeck),
  hubStatus: () => ipcRenderer.invoke(IPC.hubStatus),
  connectHub: (url: string, token: string) => ipcRenderer.invoke(IPC.connectHub, url, token),
  disconnectHub: () => ipcRenderer.invoke(IPC.disconnectHub),
  syncNow: () => ipcRenderer.invoke(IPC.syncNow),
  conflicts: () => ipcRenderer.invoke(IPC.conflicts),
  resolveConflict: (pageId: string, merged: string) => ipcRenderer.invoke(IPC.resolveConflict, pageId, merged),
  logs: () => ipcRenderer.invoke(IPC.logs),
  copyLogs: () => ipcRenderer.invoke(IPC.copyLogs),
  saveLogs: () => ipcRenderer.invoke(IPC.saveLogs),
  clearLogs: () => ipcRenderer.invoke(IPC.clearLogs),
  reportError: (scope: string, message: string, detail?: string) =>
    ipcRenderer.invoke(IPC.reportError, scope, message, detail),
});
