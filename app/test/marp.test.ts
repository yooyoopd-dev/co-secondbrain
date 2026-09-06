import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inlineCitations, neutralizeSeparators, toMarp } from '../src/core/marp.ts';
import type { WikiEntry } from '../src/core/wiki.ts';
import type { Claim } from '../src/core/page.ts';

const entry = (title: string, summary: string, claims: Claim[] = [], openQuestions: string[] = []): WikiEntry => ({
  path: `wiki/entities/${title}.md`,
  page: {
    front: {
      id: `ent-${title}`, type: 'entity', title, summary, aliases: [], tags: [],
      classification: 'internal', docGenre: null,
      claims, openQuestions, derivedFrom: null, generatedBy: 'claude-code',
      updated: '2026-09-06T00:00:00.000Z', updatedBy: 'app',
    },
    body: '\n# 본문\n\n슬라이드에 안 들어간다.\n',
  },
});

const ex = (text: string, source: string | null = 'src-kickoff#slide-3'): Claim => ({ text, source, confidence: 'EXTRACTED' });

test('덱이 Marp front-matter 로 시작한다', () => {
  const d = toMarp([entry('에이콤', '주 협력사.')], { title: '2026 ACME' });
  assert.ok(d.startsWith('---\nmarp: true\n'));
  assert.match(d, /paginate: true/);
  assert.match(d, /# 2026 ACME/);
});

test('페이지마다 슬라이드가 하나씩 생긴다', () => {
  const d = toMarp([entry('에이콤', 'A.'), entry('베타테크', 'B.')], { title: 'T' });
  // 표지 + 2장이므로 구분자는 head 하나와 사이 둘
  assert.equal(d.split('\n---\n\n').length, 3);
  assert.match(d, /## 에이콤/);
  assert.match(d, /## 베타테크/);
});

test('본문 산문은 안 들어간다 — 슬라이드가 넘친다', () => {
  assert.equal(toMarp([entry('에이콤', 'A.')], { title: 'T' }).includes('슬라이드에 안 들어간다'), false);
});

test('인용을 살린다 — 슬라이드로 뽑았다고 근거가 사라지면 쓸 이유가 없다', () => {
  const d = toMarp([entry('에이콤', '주 협력사.', [ex('2026년 선정됐다.')])], { title: 'T' });
  assert.match(d, /- 2026년 선정됐다\. `src-kickoff#slide-3`/);
});

test('출처 없는 주장은 인용 없이 나온다', () => {
  const d = toMarp([entry('에이콤', 'A.', [{ text: '불확실하다.', source: null, confidence: 'AMBIGUOUS' }])], { title: 'T' });
  assert.match(d, /- 불확실하다\. _\(불확실\)_/);
});

test('신뢰도 배지 — EXTRACTED 는 안 붙고 INFERRED 는 점수까지 붙는다', () => {
  const d = toMarp([entry('E', 'x.', [ex('명시.', 'src-a#p-1'), { text: '추론.', source: 'src-a#p-1', confidence: 'INFERRED', score: 0.85 }])], { title: 'T' });
  assert.match(d, /- 명시\. `src-a#p-1`\n/);
  assert.match(d, /- 추론\. `src-a#p-1` _\(추론 0\.85\)_/);
});

test('주장이 많으면 잘라 내고 몇 건 더 있는지 알린다', () => {
  const claims = Array.from({ length: 9 }, (_, i) => ex(`주장 ${i}.`));
  const d = toMarp([entry('E', 'x.', claims)], { title: 'T', maxClaims: 3 });
  assert.match(d, /주장 2\./);
  assert.equal(d.includes('주장 3.'), false);
  assert.match(d, /_주장 6건 더 있음_/);
});

test('남은 질문도 슬라이드에 올린다', () => {
  const d = toMarp([entry('E', 'x.', [], ['계약 주체가 누구인가'])], { title: 'T' });
  assert.match(d, /\*\*남은 질문\*\*/);
  assert.match(d, /- 계약 주체가 누구인가/);
});

/* ---------------- 구분자 충돌 ---------------- */

test('본문의 --- 가 덱을 쪼개지 않는다', () => {
  assert.equal(neutralizeSeparators('앞\n---\n뒤'), '앞\n ---\n뒤');
  assert.equal(neutralizeSeparators('앞\n***\n뒤'), '앞\n ***\n뒤');
  assert.equal(neutralizeSeparators('앞\n  ___  \n뒤'), '앞\n ___\n뒤');
  assert.equal(neutralizeSeparators('a---b'), 'a---b'); // 줄 안의 것은 안 건드린다
});

test('요약에 --- 가 있어도 슬라이드 수가 그대로다', () => {
  const clean = toMarp([entry('A', '정상.'), entry('B', '정상.')], { title: 'T' });
  const dirty = toMarp([entry('A', '앞\n---\n뒤'), entry('B', '정상.')], { title: 'T' });
  assert.equal(dirty.split('\n---\n\n').length, clean.split('\n---\n\n').length);
});

test('앵커 인용은 각주가 아니라 코드로 나온다 — 정의가 없으면 깨져 보인다', () => {
  assert.equal(inlineCitations('선정됐다.[^src-kickoff#slide-3]'), '선정됐다. `src-kickoff#slide-3`');
  assert.equal(inlineCitations('[^src-계약#page-2] 앞'), ' `src-계약#page-2` 앞');
  assert.equal(inlineCitations('[^src-a#p]: 각주 정의'), '[^src-a#p]: 각주 정의'); // 정의는 안 건드린다
});

test('빈 목록도 표지만 있는 덱을 낸다', () => {
  const d = toMarp([], { title: '빈 덱', subtitle: '2026-09-06' });
  assert.match(d, /# 빈 덱/);
  assert.match(d, /2026-09-06/);
  assert.ok(d.endsWith('\n'));
});
