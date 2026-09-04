import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  citations, emptyPage, outboundLinks, pageHash, parsePage, PageParseError, serializePage, SUMMARY_MAX,
} from '../src/core/page.ts';

test('직렬화하고 다시 읽으면 같다', () => {
  const p = emptyPage('ent-acme', 'entity', '에이콤');
  p.front.summary = '주 협력사.';
  p.front.aliases = ['Acme', 'ACME'];
  p.front.claims = [
    { text: '주 협력사로 확정', source: 'src-kickoff#slide-12', confidence: 'EXTRACTED' },
    { text: '갱신일은 3월로 보인다', source: 'src-계약#p-2', confidence: 'INFERRED', score: 0.85 },
    { text: '담당자가 불분명', source: null, confidence: 'AMBIGUOUS' },
  ];
  const back = parsePage(serializePage(p));
  assert.deepEqual(back.front, p.front);
  assert.equal(back.body, p.body);
});

test('디스크에서 읽어 그대로 쓰면 바이트가 같다 — diff 잡음을 막는다', () => {
  const md = [
    '---',
    'id: ent-acme',
    'type: entity',
    'title: 에이콤',
    'summary: 주 협력사.',
    'aliases: []',
    'tags: []',
    'claims: []',
    'open_questions: []',
    'derived_from: null',
    'generated_by: null',
    'updated: 2026-09-04T00:00:00.000Z',
    'updated_by: hong@corp',
    '---',
    '',
    '# 에이콤',
    '',
  ].join('\n');
  assert.equal(serializePage(parsePage(md)), md);
});

test('front-matter 가 없으면 던진다', () => {
  assert.throws(() => parsePage('# 제목\n본문\n'), PageParseError);
});

test('알 수 없는 type 을 막는다', () => {
  assert.throws(() => parsePage('---\nid: a\ntype: 메모\ntitle: 가\n---\n'), PageParseError);
});

test('summary 는 상한에서 잘린다 — index.md 조립용이라 길면 카탈로그가 무너진다', () => {
  const p = emptyPage('ent-a', 'entity', '가');
  p.front.summary = '가'.repeat(SUMMARY_MAX + 50);
  assert.equal(parsePage(serializePage(p)).front.summary.length, SUMMARY_MAX);
});

test('앵커 인용을 뽑는다. 각주 정의는 인용이 아니다', () => {
  const found = citations('확정됐다. [^src-kickoff#slide-12]\n\n[^src-kickoff#slide-12]: 각주 정의\n');
  assert.deepEqual(found, [{ sourceId: 'src-kickoff', locator: 'slide-12' }]);
});

test('한글 원본 id 와 콜론이 든 locator 를 받는다', () => {
  assert.deepEqual(citations('[^src-회의록#00:12:30]'), [{ sourceId: 'src-회의록', locator: '00:12:30' }]);
});

test('wikilink 와 상대 마크다운 링크를 같이 뽑는다', () => {
  const links = outboundLinks('[[entities/acme-corp|에이콤]] 과 [계약](concepts/contract.md) 그리고 [[ent-b]]');
  assert.deepEqual(links.sort(), ['ent-b', 'concepts/contract', 'entities/acme-corp'].sort());
});

test('같은 링크가 두 번 나와도 한 번만 센다', () => {
  assert.deepEqual(outboundLinks('[[ent-a]] [[ent-a|다른 표시]]'), ['ent-a']);
});

test('해시는 파일 전문 기준이라 한 글자만 달라도 바뀐다', () => {
  const a = serializePage(emptyPage('ent-a', 'entity', '가'));
  assert.equal(pageHash(a), pageHash(a));
  assert.notEqual(pageHash(a), pageHash(`${a} `));
  assert.match(pageHash(a), /^sha256:[0-9a-f]{64}$/);
});
