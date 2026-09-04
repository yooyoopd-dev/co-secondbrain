// index.md 조립. PLAN.md §5
//
// 원문(karpathy)의 index.md 는 "질의 시 가장 먼저 읽는 파일"이다.
// **LLM 이 매번 다시 쓰지 않는다.** 앱이 각 페이지 front-matter 의 summary 에서 조립한다.
// 내용의 저자는 여전히 LLM 이고 조립만 결정론적이라, 본문과 어긋날 수 없다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from './security.ts';
import { citations, parsePage, type Page, type PageType } from './page.ts';
import type { Vault } from './vault.ts';

export interface WikiEntry {
  /** Vault 기준 상대 경로. `wiki/entities/acme-corp.md` */
  path: string;
  page: Page;
}

/** 위키 디렉터리 → 표제. overview 는 index.md 자신이 아니라 별도 페이지다. */
const SECTIONS: { type: PageType; dir: string; heading: string }[] = [
  { type: 'entity', dir: 'entities', heading: '엔티티' },
  { type: 'concept', dir: 'concepts', heading: '개념' },
  { type: 'synthesis', dir: 'synthesis', heading: '종합' },
  { type: 'source', dir: 'sources', heading: '원본' },
];

/** 위키 페이지를 전부 읽는다. 파싱에 실패한 파일은 건너뛰고 목록으로 돌려준다. */
export async function readWikiPages(vault: Vault): Promise<{ entries: WikiEntry[]; broken: { path: string; reason: string }[] }> {
  const entries: WikiEntry[] = [];
  const broken: { path: string; reason: string }[] = [];

  for (const s of SECTIONS) {
    const dir = safeJoin(vault.root, 'wiki', s.dir);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue;
      const rel = `wiki/${s.dir}/${name}`;
      try {
        entries.push({ path: rel, page: parsePage(await fs.readFile(path.join(dir, name), 'utf8')) });
      } catch (e) {
        broken.push({ path: rel, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { entries, broken };
}

/**
 * index.md 전문을 만든다.
 *
 * 형식은 원문의 "콘텐츠 지향 카탈로그" 를 따른다 — 제목만 나열하면 LLM 이
 * 무엇을 열어봐야 할지 알 수 없다. 한 줄 요약이 있어야 고를 수 있다.
 */
export function buildIndex(entries: readonly WikiEntry[]): string {
  const out: string[] = ['# 인덱스', ''];
  if (entries.length === 0) {
    out.push('_아직 페이지가 없습니다._', '');
    return out.join('\n');
  }

  for (const s of SECTIONS) {
    const rows = entries
      .filter((e) => e.page.front.type === s.type)
      .sort((a, b) => a.page.front.title.localeCompare(b.page.front.title, 'ko'));
    if (!rows.length) continue;

    out.push(`## ${s.heading}`, '');
    for (const e of rows) out.push(line(e));
    out.push('');
  }
  return out.join('\n');
}

/** `- [[entities/acme-corp|에이콤(주)]] — 요약. \`원본 4 · 2026-09-03\`` */
function line(e: WikiEntry): string {
  const f = e.page.front;
  const target = e.path.replace(/^wiki\//, '').replace(/\.md$/, '');
  const sources = new Set(citations(e.page.body).map((c) => c.sourceId));
  for (const c of f.claims) if (c.source?.includes('#')) sources.add(c.source.split('#')[0]!);

  const meta = [`원본 ${sources.size}`, f.updated.slice(0, 10)].join(' · ');
  const summary = f.summary.trim() || '_요약 없음_';
  return `- [[${target}|${f.title}]] — ${summary} \`${meta}\``;
}

/** index.md 를 다시 쓴다. 인제스트·Lint 적용 뒤에 부른다. */
export async function writeIndex(vault: Vault, entries: readonly WikiEntry[]): Promise<string> {
  const md = buildIndex(entries);
  await fs.writeFile(safeJoin(vault.root, 'index.md'), md, 'utf8');
  return md;
}
