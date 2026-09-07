// 전사 — 화자 턴. 앵커는 타임코드.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Chunk, Extraction, Relation } from '../types.ts';

const VTT_CUE = /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*\n([\s\S]*?)(?=\n\s*\n|\n*$)/g;

export async function extractTranscript(file: string, sourceId: string): Promise<Extraction> {
  const raw = await fs.readFile(file, 'utf8');
  const chunks: Chunk[] = [];
  const relations: Relation[] = [];
  let prev: string | null = null;

  for (const m of raw.matchAll(VTT_CUE)) {
    const start = (m[1] ?? '').replace(',', '.');
    const body = (m[3] ?? '').trim();
    if (!body) continue;
    // <v 화자> 또는 "화자:" 두 형태를 받는다
    const tagged = body.match(/^<v\s+([^>]+)>([\s\S]*)$/);
    const colon = !tagged ? body.match(/^([^:\n]{1,20}):\s*([\s\S]*)$/) : null;
    const speaker = tagged?.[1]?.trim() ?? colon?.[1]?.trim() ?? null;
    const text = (tagged?.[2] ?? colon?.[2] ?? body).trim();

    const locator = `t-${start}`;
    chunks.push({
      anchor: { sourceId, locator, label: speaker ? `${start} ${speaker}` : start },
      text: speaker ? `${speaker}: ${text}` : text,
    });
    if (prev) relations.push({ from: `${sourceId}#${prev}`, to: `${sourceId}#${locator}`, kind: 'speaks-after', confidence: 'EXTRACTED' });
    prev = locator;
  }

  return {
    sourceId, filename: path.basename(file),
    kind: path.extname(file).toLowerCase() === '.srt' ? 'srt' : 'vtt',
    chunks, relations,
    warnings: chunks.length === 0 ? ['자막 큐를 찾지 못했습니다'] : [],
  };
}
