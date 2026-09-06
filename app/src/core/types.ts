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
  /** 넣을 때 사람이 고른 열람 등급. 예전 파일에는 없어 읽을 때 기본값을 채운다 */
  classification?: Classification;
}

export type SourceKind = 'docx' | 'xlsx' | 'csv' | 'pptx' | 'pdf' | 'eml' | 'msg' | 'vtt' | 'srt' | 'txt' | 'md';

/**
 * 열람 등급. **느슨한 것부터 엄한 것 순서다** — 관문 9 가 이 순서로 비교한다.
 *
 * 2단계(공개/기밀)로는 실무에서 곧 전부 기밀이 된다. 애매하면 높은 쪽을 고르기
 * 때문이고, 그러면 필드가 정보를 담지 않는다. 그래서 네 단계다.
 *
 * **이 필드는 표시이지 강제가 아니다.** 개인 금고와 CO 공간을 물리적으로 가르는 것이
 * 유출을 막는 장치이고(PLAN.md §3), 이 등급은 CO 공간 안에서 열람 범위를 나눈다.
 */
export const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** 넣을 때 고르지 않으면 이것이다. 공개를 기본으로 두면 실수가 유출이 된다 */
export const DEFAULT_CLASSIFICATION: Classification = 'internal';

export const CLASSIFICATION_LABEL: Record<Classification, string> = {
  public: '공개',
  internal: '사내',
  confidential: '기밀',
  restricted: '제한',
};

/** 엄한 정도. 클수록 엄하다 */
export function classificationRank(c: Classification): number {
  return CLASSIFICATIONS.indexOf(c);
}

/**
 * 문서 장르. 페이지 종류(`type`)와는 다른 축이다 —
 * `type` 은 이 앱이 페이지를 어디에 두는가이고, 이것은 원래 문서가 무엇인가다.
 *
 * 열거형을 늘리면 이전 문서가 낡는다. 그래서 여기 없는 것은 `tags` 로 둔다.
 */
export const DOC_GENRES = ['guideline', 'factsheet', 'report', 'intelligence', 'meeting'] as const;
export type DocGenre = (typeof DOC_GENRES)[number];

export const DOC_GENRE_LABEL: Record<DocGenre, string> = {
  guideline: '지침',
  factsheet: '요약 자료',
  report: '보고서',
  intelligence: '동향',
  meeting: '회의록',
};

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
