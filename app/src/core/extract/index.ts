// 추출기 디스패치. M0 §3 에서 7/7 실측한 스파이크 코드를 제품 모듈로 옮긴 것.
//
// 원칙: **LLM 을 쓰지 않는다.** 텍스트와 구조를 전부 로컬 라이브러리로 뽑는다.
// 구조 관계(이메일 스레드·xlsx 수식·docx 제목 트리)는 신뢰도가 항상 EXTRACTED 다.
import path from 'node:path';
import { SOURCE_KIND_BY_EXT, type Extraction, type SourceKind } from '../types.ts';
import { sourceIdFrom } from '../security.ts';
import { extractDocx } from './docx.ts';
import { extractXlsx } from './xlsx.ts';
import { extractPptx } from './pptx.ts';
import { extractPdf } from './pdf.ts';
import { extractEmail } from './email.ts';
import { extractTranscript } from './transcript.ts';
import { extractPlain } from './plain.ts';

export function kindOf(filename: string): SourceKind | null {
  return SOURCE_KIND_BY_EXT[path.extname(filename).toLowerCase()] ?? null;
}

export function isSupported(filename: string): boolean {
  return kindOf(filename) !== null;
}

const HANDLERS: Record<SourceKind, (file: string, id: string) => Promise<Extraction>> = {
  docx: extractDocx,
  xlsx: extractXlsx,
  csv: extractPlain,
  pptx: extractPptx,
  pdf: extractPdf,
  eml: extractEmail,
  msg: extractEmail,
  vtt: extractTranscript,
  srt: extractTranscript,
  txt: extractPlain,
  md: extractPlain,
};

/** 파일 하나를 추출한다. 지원하지 않는 확장자는 던진다. */
export async function extractFile(filePath: string): Promise<Extraction> {
  const filename = path.basename(filePath);
  const kind = kindOf(filename);
  if (!kind) throw new Error(`지원하지 않는 형식: ${filename}`);
  const handler = HANDLERS[kind];
  return handler(filePath, sourceIdFrom(filename));
}

/** 이메일 여러 통의 스레드를 복원한다. 개별 추출로는 못 만드는 관계라 별도로 돈다. */
export { buildThreads } from './email.ts';
