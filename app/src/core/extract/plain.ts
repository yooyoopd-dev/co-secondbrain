// txt / md / csv — 마크다운은 제목 트리와 링크를 뽑는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Chunk, Extraction, Relation, SourceKind } from '../types.ts';

export async function extractPlain(file: string, sourceId: string): Promise<Extraction> {
  const raw = await fs.readFile(file, 'utf8');
  const ext = path.extname(file).toLowerCase();
  const kind: SourceKind = ext === '.md' ? 'md' : ext === '.csv' ? 'csv' : 'txt';
  const chunks: Chunk[] = [];
  const relations: Relation[] = [];

  if (kind !== 'md') {
    const text = raw.trim();
    if (text) chunks.push({ anchor: { sourceId, locator: 'body', label: '본문' }, text });
    return { sourceId, filename: path.basename(file), kind, chunks, relations, warnings: text ? [] : ['빈 파일입니다'] };
  }

  // 마크다운: 제목 경로를 앵커로 쓰고 wikilink·상대 링크를 references 로 뽑는다
  const stack: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    const locator = stack.join(' > ') || '본문';
    chunks.push({ anchor: { sourceId, locator, label: locator }, text });
  };

  for (const line of raw.split(/\r?\n/)) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      const level = h[1]!.length;
      while (stack.length >= level) stack.pop();
      stack.push(h[2]!.trim());
      continue;
    }
    buf.push(line);
  }
  flush();

  const from = `${sourceId}#본문`;
  for (const m of raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^)]+\.md)\)/g)) {
    const target = (m[1] ?? m[2] ?? '').trim();
    if (target) relations.push({ from, to: target, kind: 'references', confidence: 'EXTRACTED' });
  }

  return { sourceId, filename: path.basename(file), kind, chunks, relations, warnings: chunks.length ? [] : ['빈 파일입니다'] };
}
