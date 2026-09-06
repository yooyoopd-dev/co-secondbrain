import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../src/core/vault.ts';
import { buildIndex, readWikiPages, writeIndex, type WikiEntry } from '../src/core/wiki.ts';
import { emptyPage, serializePage, type Page, type PageType } from '../src/core/page.ts';

const vault = async () =>
  createVault(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-wiki-')), { id: 'p', title: 'P', hub: null });

const entry = (dir: string, slug: string, type: PageType, title: string, summary: string, body = '\n'): WikiEntry => {
  const page: Page = emptyPage(`${type}-${slug}`, type, title);
  page.front.summary = summary;
  page.front.updated = '2026-09-03T10:00:00.000Z';
  page.body = body;
  return { path: `02_NOTES/${dir}/${slug}.md`, page };
};

test('빈 위키는 빈 인덱스를 만든다', () => {
  assert.match(buildIndex([]), /아직 페이지가 없습니다/);
});

test('PLAN §5 의 카탈로그 한 줄 형식을 그대로 만든다', () => {
  const md = buildIndex([
    entry('entities', 'acme-corp', 'entity', '에이콤(주)', '2026년 킥오프의 주 협력사.',
      '\n확정됐다. [^src-kickoff#slide-12] [^src-계약#p-2] [^src-kickoff#slide-3]\n'),
  ]);
  assert.match(md, /## 엔티티/);
  assert.match(md, /- \[\[entities\/acme-corp\|에이콤\(주\)\]\] — 2026년 킥오프의 주 협력사\. `원본 2 · 2026-09-03`/);
});

test('원본 수는 앵커의 원본 id 를 중복 없이 센다 (본문 + claim)', () => {
  const e = entry('entities', 'a', 'entity', '가', '요약.', '\n[^src-x#p-1] [^src-x#p-2]\n');
  e.page.front.claims = [{ text: 'x', source: 'src-y#p-1', confidence: 'EXTRACTED' }];
  assert.match(buildIndex([e]), /`원본 2 · /);
});

test('섹션 순서는 엔티티 · 개념 · 종합 · 원본 이고 빈 섹션은 나오지 않는다', () => {
  const md = buildIndex([
    entry('sources', 's', 'source', '킥오프 발표', '킥오프 슬라이드.'),
    entry('entities', 'a', 'entity', '에이콤', '주 협력사.'),
  ]);
  assert.ok(md.indexOf('## 엔티티') < md.indexOf('## 원본'));
  assert.ok(!md.includes('## 개념'));
});

test('같은 섹션 안에서는 제목 가나다순이다', () => {
  const md = buildIndex([
    entry('entities', 'c', 'entity', '하나은행', 'x.'),
    entry('entities', 'a', 'entity', '가나전자', 'y.'),
    entry('entities', 'b', 'entity', '나라물산', 'z.'),
  ]);
  const order = ['가나전자', '나라물산', '하나은행'].map((t) => md.indexOf(t));
  assert.deepEqual(order, [...order].sort((x, y) => x - y));
});

test('요약이 비면 표시로 대신한다 — 줄을 빠뜨리지 않는다', () => {
  assert.match(buildIndex([entry('entities', 'a', 'entity', '가', '')]), /_요약 없음_/);
});

test('디스크에서 읽어 조립하고 다시 쓴다', async () => {
  const v = await vault();
  const e = entry('entities', 'acme-corp', 'entity', '에이콤', '주 협력사.');
  await fs.writeFile(path.join(v.root, e.path), serializePage(e.page), 'utf8');

  const { entries, broken } = await readWikiPages(v);
  assert.equal(entries.length, 1);
  assert.deepEqual(broken, []);

  await writeIndex(v, entries);
  const md = await fs.readFile(path.join(v.root, 'index.md'), 'utf8');
  assert.match(md, /\[\[entities\/acme-corp\|에이콤\]\]/);
});

test('깨진 페이지는 인덱스를 막지 않고 따로 보고된다', async () => {
  const v = await vault();
  await fs.writeFile(path.join(v.root, '02_NOTES/entities/broken.md'), 'front-matter 가 없다\n', 'utf8');
  const good = entry('entities', 'ok', 'entity', '정상', '요약.');
  await fs.writeFile(path.join(v.root, good.path), serializePage(good.page), 'utf8');

  const { entries, broken } = await readWikiPages(v);
  assert.equal(entries.length, 1);
  assert.equal(broken.length, 1);
  assert.equal(broken[0]?.path, '02_NOTES/entities/broken.md');
});
