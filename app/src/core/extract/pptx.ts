// pptx — 슬라이드별 제목·본문 + 발표자 노트. OOXML 을 직접 읽는다.
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import type { Chunk, Extraction, Relation } from '../types.ts';

const parser = new XMLParser({ ignoreAttributes: false });

function textNodes(obj: unknown): string[] {
  const out: string[] = [];
  (function walk(o: unknown): void {
    if (o == null) return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o === 'object') {
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k === 'a:t') out.push(String(v));
        else walk(v);
      }
    }
  })(obj);
  return out;
}

export async function extractPptx(file: string, sourceId: string): Promise<Extraction> {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const chunks: Chunk[] = [];
  const relations: Relation[] = [];

  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)![1]) - Number(b.match(/(\d+)/)![1]));

  let prev: string | null = null;
  for (const name of names) {
    const idx = Number(name.match(/slide(\d+)\.xml$/)![1]);
    const locator = `slide-${idx}`;
    const parts = textNodes(parser.parse(await zip.file(name)!.async('string')));
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${idx}.xml`);
    const notes = notesFile ? textNodes(parser.parse(await notesFile.async('string'))) : [];

    const body = [...parts, ...(notes.length ? [`[발표자 노트] ${notes.join(' ')}`] : [])].join('\n');
    chunks.push({ anchor: { sourceId, locator, label: `슬라이드 ${idx}` }, text: body });
    if (prev) relations.push({ from: `${sourceId}#${prev}`, to: `${sourceId}#${locator}`, kind: 'contains', confidence: 'EXTRACTED' });
    prev = locator;
  }

  return {
    sourceId, filename: file.split(/[/\\]/).pop() ?? file, kind: 'pptx',
    chunks, relations,
    warnings: chunks.length === 0 ? ['슬라이드를 찾지 못했습니다'] : [],
  };
}
