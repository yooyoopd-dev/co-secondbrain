// docx — 본문 + 제목 트리. 앵커는 제목 경로("2026 ACME > 계약 조건 > 리스크").
import mammoth from 'mammoth';
import type { Chunk, Extraction, Relation } from '../types.ts';

export async function extractDocx(file: string, sourceId: string): Promise<Extraction> {
  const { value: html } = await mammoth.convertToHtml({ path: file });
  const stack: string[] = [];
  const chunks: Chunk[] = [];
  const relations: Relation[] = [];

  for (const m of html.matchAll(/<h([1-6])>(.*?)<\/h\1>|<p>(.*?)<\/p>/g)) {
    const strip = (s: string) => s.replace(/<[^>]+>/g, '').trim();
    if (m[1]) {
      const level = Number(m[1]);
      const parent = stack.slice(0, level - 1).join(' > ');
      while (stack.length >= level) stack.pop();
      stack.push(strip(m[2] ?? ''));
      const locator = stack.join(' > ');
      chunks.push({ anchor: { sourceId, locator, label: stack[stack.length - 1] ?? locator }, text: stack[stack.length - 1] ?? '' });
      if (parent) relations.push({ from: `${sourceId}#${parent}`, to: `${sourceId}#${locator}`, kind: 'contains', confidence: 'EXTRACTED' });
    } else if (m[3]) {
      const text = strip(m[3]);
      if (!text) continue;
      const locator = stack.join(' > ') || '본문';
      chunks.push({ anchor: { sourceId, locator, label: locator }, text });
    }
  }

  return {
    sourceId, filename: file.split(/[/\\]/).pop() ?? file, kind: 'docx',
    chunks, relations,
    warnings: chunks.length === 0 ? ['본문을 찾지 못했습니다'] : [],
  };
}
