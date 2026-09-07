// pdf — 페이지별 텍스트. 텍스트 레이어가 없는 스캔본을 감지해 경고한다.
import fs from 'node:fs/promises';
import type { Chunk, Extraction } from '../types.ts';

/** M0 §3.3 실측: 정상 55.0자/쪽 vs 스캔본 0.0자/쪽. 임계 10자/쪽으로 분리된다. */
export const SCAN_THRESHOLD_CHARS_PER_PAGE = 10;

export async function extractPdf(file: string, sourceId: string): Promise<Extraction> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(await fs.readFile(file));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;

  const chunks: Chunk[] = [];
  let total = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    const text = content.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim();
    total += text.length;
    if (text) chunks.push({ anchor: { sourceId, locator: `page-${i}`, label: `${i}쪽` }, text });
  }

  const perPage = doc.numPages > 0 ? total / doc.numPages : 0;
  const warnings: string[] = [];
  if (perPage < SCAN_THRESHOLD_CHARS_PER_PAGE) {
    warnings.push(
      `텍스트 레이어가 거의 없습니다 (${perPage.toFixed(1)}자/쪽). 스캔본으로 보이며 OCR 이 필요합니다.`,
    );
  }

  return { sourceId, filename: file.split(/[/\\]/).pop() ?? file, kind: 'pdf', chunks, relations: [], warnings };
}
