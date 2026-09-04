// 도메인 타입. Electron·UI 와 무관하다.

/** 원본 안의 위치. 클릭하면 여기로 점프한다. */
export interface Anchor {
  /** 원본 id — `src-2026-09-03-kickoff` */
  sourceId: string;
  /** 원본 안의 좌표 — `slide-12` `page-3` `원가!D4` `t-00:00:05` `2026 ACME > 계약 조건` */
  locator: string;
  /** 사람이 읽는 표기 — "슬라이드 12" */
  label: string;
}

/** 추출된 텍스트 한 조각. 앵커 하나에 대응한다. */
export interface Chunk {
  anchor: Anchor;
  text: string;
}

/** 구조 관계. LLM 없이 뽑히므로 신뢰도는 항상 EXTRACTED. */
export interface Relation {
  from: string;
  to: string;
  /** `replies-to` `feeds` `contains` `references` `speaks-after` */
  kind: RelationKind;
  confidence: 'EXTRACTED';
}

export type RelationKind = 'replies-to' | 'feeds' | 'contains' | 'references' | 'speaks-after';

/** 추출기 하나의 산출물. */
export interface Extraction {
  sourceId: string;
  /** 원본 파일명 */
  filename: string;
  /** `docx` `xlsx` `pptx` `pdf` `eml` `msg` `vtt` `srt` `txt` `md` */
  kind: SourceKind;
  chunks: Chunk[];
  relations: Relation[];
  /** 사람에게 보여줄 경고 — "텍스트 레이어가 없습니다 (스캔본)" */
  warnings: string[];
}

export type SourceKind = 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf' | 'eml' | 'msg' | 'vtt' | 'srt' | 'txt' | 'md';

/** 검색 결과 한 건. */
export interface SearchHit {
  sourceId: string;
  locator: string;
  label: string;
  /** 질의어 주변 발췌 */
  snippet: string;
}

export const SOURCE_KIND_BY_EXT: Readonly<Record<string, SourceKind>> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.csv': 'csv',
  '.pptx': 'pptx',
  '.pdf': 'pdf',
  '.eml': 'eml',
  '.msg': 'msg',
  '.vtt': 'vtt',
  '.srt': 'srt',
  '.txt': 'txt',
  '.md': 'md',
};
