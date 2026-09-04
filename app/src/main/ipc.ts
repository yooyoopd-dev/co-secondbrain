// 렌더러에 노출하는 IPC 계약. 렌더러는 파일시스템에 직접 접근하지 않는다.
import type { Extraction, SearchHit } from '../core/types.ts';
import type { VaultConfig } from '../core/vault.ts';

export interface IngestResult {
  ok: string[];
  failed: { filename: string; reason: string }[];
  warnings: { filename: string; warning: string }[];
  relations: number;
}

export interface SourceSummary {
  sourceId: string;
  filename: string;
  kind: string;
  chunks: number;
}

/** preload 가 window.sb 로 노출하는 표면. 이 목록 밖의 것은 렌더러가 못 부른다. */
export interface SbApi {
  pickVault(mode: 'open' | 'create'): Promise<VaultConfig | null>;
  currentVault(): Promise<VaultConfig | null>;
  pickAndIngest(): Promise<IngestResult>;
  listSources(): Promise<SourceSummary[]>;
  search(query: string): Promise<SearchHit[]>;
  readSource(sourceId: string): Promise<Extraction | null>;
}

export const IPC = {
  pickVault: 'sb:pickVault',
  currentVault: 'sb:currentVault',
  pickAndIngest: 'sb:pickAndIngest',
  listSources: 'sb:listSources',
  search: 'sb:search',
  readSource: 'sb:readSource',
} as const;
