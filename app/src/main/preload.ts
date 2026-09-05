// contextBridge — 렌더러가 볼 수 있는 표면은 이 목록이 전부다.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from './ipc.ts';

contextBridge.exposeInMainWorld('sb', {
  pickVault: (mode: 'open' | 'create') => ipcRenderer.invoke(IPC.pickVault, mode),
  currentVault: () => ipcRenderer.invoke(IPC.currentVault),
  pickAndIngest: () => ipcRenderer.invoke(IPC.pickAndIngest),
  listSources: () => ipcRenderer.invoke(IPC.listSources),
  search: (q: string) => ipcRenderer.invoke(IPC.search, q),
  readSource: (id: string) => ipcRenderer.invoke(IPC.readSource, id),
  propose: (id: string) => ipcRenderer.invoke(IPC.propose, id),
  applyReview: (approved: string[]) => ipcRenderer.invoke(IPC.applyReview, approved),
  discardReview: () => ipcRenderer.invoke(IPC.discardReview),
});
