import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyPage, parsePage, serializePage, PageParseError } from '../src/core/page.ts';
import { validateClassification } from '../src/core/changeset.ts';
import { CLASSIFICATIONS, classificationRank, DEFAULT_CLASSIFICATION } from '../src/core/types.ts';
import type { Classification } from '../src/core/types.ts';
import type { ChangeSet } from '../src/core/changeset.ts';

/* ---------- 등급 자체 ---------- */

test('등급은 느슨한 것부터 엄한 것 순서다 — 관문 9 가 이 순서로 비교한다', () => {
  assert.deepEqual([...CLASSIFICATIONS], ['public', 'internal', 'confidential', 'restricted']);
  assert.ok(classificationRank('public') < classificationRank('internal'));
  assert.ok(classificationRank('internal') < classificationRank('confidential'));
  assert.ok(classificationRank('confidential') < classificationRank('restricted'));
});

test('기본값은 사내다 — 공개를 기본으로 두면 빠뜨린 것이 유출이 된다', () => {
  assert.equal(DEFAULT_CLASSIFICATION, 'internal');
});

/* ---------- front-matter ---------- */

test('등급이 없으면 사내로 읽는다 — 예전 페이지가 그대로 열린다', () => {
  const md = ['---', 'id: ent-a', 'type: entity', 'title: 가', '---', '', '# 가', ''].join('\n');
  const p = parsePage(md);
  assert.equal(p.front.classification, 'internal');
  assert.equal(p.front.docGenre, null);
});

test('모르는 등급은 조용히 기본값으로 떨어뜨리지 않고 던진다', () => {
  const md = ['---', 'id: ent-a', 'type: entity', 'title: 가', 'classification: 대외비', '---', ''].join('\n');
  assert.throws(() => parsePage(md), PageParseError);
});

test('모르는 장르도 던진다', () => {
  const md = ['---', 'id: ent-a', 'type: entity', 'title: 가', 'doc_genre: memo', '---', ''].join('\n');
  assert.throws(() => parsePage(md), PageParseError);
});

test('등급과 장르가 왕복한다', () => {
  const p = emptyPage('src-a', 'source', '킥오프');
  p.front.classification = 'confidential';
  p.front.docGenre = 'meeting';
  const back = parsePage(serializePage(p));
  assert.equal(back.front.classification, 'confidential');
  assert.equal(back.front.docGenre, 'meeting');
});

test('YAML 키는 doc_genre 다 — Obsidian Dataview 가 읽는 이름', () => {
  const p = emptyPage('src-a', 'source', '킥오프');
  p.front.docGenre = 'report';
  const out = serializePage(p);
  assert.ok(out.includes('doc_genre: report'), out);
  assert.ok(out.includes('classification: internal'), out);
});

/* ---------- 관문 9 ---------- */

function pageWith(cls: Classification, source: string): string {
  const p = emptyPage('ent-a', 'entity', '가');
  p.front.classification = cls;
  p.front.claims = [{ text: '주장', source, confidence: 'EXTRACTED' }];
  return serializePage(p);
}

const cs = (content: string): ChangeSet => ({
  summary: '검사',
  ops: [{ op: 'create', path: 'wiki/entities/가.md', baseHash: null, content }],
});

test('기밀 원본을 인용한 공개 페이지는 막힌다', () => {
  const v = validateClassification(cs(pageWith('public', 'src-a#p-1')), new Map([['src-a', 'confidential']]));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.gate, 9);
  assert.match(v[0]!.reason, /기밀/);
});

test('인용이 등급을 끌어올린다 — 같은 등급이면 통과한다', () => {
  const known = new Map<string, Classification>([['src-a', 'confidential']]);
  assert.deepEqual(validateClassification(cs(pageWith('confidential', 'src-a#p-1')), known), []);
  assert.deepEqual(validateClassification(cs(pageWith('restricted', 'src-a#p-1')), known), []);
});

test('더 엄한 페이지는 막지 않는다 — 올리는 것은 자유다', () => {
  const v = validateClassification(cs(pageWith('restricted', 'src-a#p-1')), new Map([['src-a', 'public']]));
  assert.deepEqual(v, []);
});

test('여러 원본을 인용하면 가장 엄한 것을 따른다', () => {
  const p = emptyPage('ent-a', 'entity', '가');
  p.front.classification = 'internal';
  p.front.claims = [
    { text: '가', source: 'src-a#p-1', confidence: 'EXTRACTED' },
    { text: '나', source: 'src-b#p-1', confidence: 'EXTRACTED' },
  ];
  const known = new Map<string, Classification>([['src-a', 'public'], ['src-b', 'restricted']]);
  const v = validateClassification(cs(serializePage(p)), known);
  assert.equal(v.length, 1);
  assert.match(v[0]!.reason, /src-b/);
});

test('본문 각주 인용도 센다 — claims 에만 있는 것이 아니다', () => {
  const p = emptyPage('ent-a', 'entity', '가');
  p.front.classification = 'public';
  p.body = '\n# 가\n\n한 문장.[^src-a#p-1]\n';
  const v = validateClassification(cs(serializePage(p)), new Map([['src-a', 'confidential']]));
  assert.equal(v.length, 1);
});

test('모르는 원본은 관문 9 가 판단하지 않는다 — 관문 5 의 일이다', () => {
  assert.deepEqual(validateClassification(cs(pageWith('public', 'src-없음#p-1')), new Map()), []);
});

test('아무것도 인용하지 않으면 통과한다', () => {
  const p = emptyPage('con-a', 'concept', '개념');
  p.front.classification = 'public';
  assert.deepEqual(validateClassification(cs(serializePage(p)), new Map([['src-a', 'restricted']])), []);
});
