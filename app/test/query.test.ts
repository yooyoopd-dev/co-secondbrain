import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SCHEMA, parseAnswer, questionPrompt, synthesisPath, toChangeSet, type Answer } from '../src/core/query.ts';
import { PAGE_PATH_RE, validateAnchors, validateShape } from '../src/core/changeset.ts';
import { SUMMARY_MAX, parsePage } from '../src/core/page.ts';

const NOW = '2026-09-06T00:00:00.000Z';
const Q = '에이콤의 계약 갱신일은 언제인가';
const A: Answer = {
  answer: '2027-03-14 이고 베타테크가 보증한다.',
  claims: [
    { text: '에이콤의 계약 갱신일은 2027-03-14 이다.', source: 'src-kickoff#slide-7' },
    { text: '베타테크의 보증 한도는 4억 2천만원이다.', source: 'src-contract#page-2' },
  ],
  pages: ['wiki/entities/acme.md', 'wiki/entities/beta.md'],
};
const ANCHORS = new Map<string, ReadonlySet<string>>([
  ['src-kickoff', new Set(['slide-7'])],
  ['src-contract', new Set(['page-2'])],
]);

/* ---------------- 프롬프트 ---------------- */

test('프롬프트가 도구로 확인하라고 못박는다', () => {
  const p = questionPrompt(Q);
  assert.ok(p.includes(Q));
  for (const t of ['search', 'get_page', 'neighbors']) assert.ok(p.includes(t), t);
  assert.match(p, /지어내지 않는다/);
  assert.match(p, /확인하지 못했습니다/); // 근거를 못 찾았을 때의 출구
});

test('후보 페이지를 프롬프트에 밀어 넣지 않는다 — 에이전트가 당겨 간다', () => {
  assert.equal(questionPrompt(Q).includes('wiki/entities/'), false);
});

/* ---------------- 응답 검사 ---------------- */

test('제대로 된 응답을 통과시킨다', () => {
  const r = parseAnswer(A);
  assert.equal(r.reason, null);
  assert.deepEqual(r.answer, A);
});

test('pages 는 없어도 된다', () => {
  const r = parseAnswer({ answer: 'x', claims: A.claims });
  assert.equal(r.reason, null);
  assert.deepEqual(r.answer!.pages, []);
});

test('답변이 비었거나 근거가 없으면 막는다', () => {
  assert.match(parseAnswer({ answer: '  ', claims: A.claims }).reason ?? '', /답변이 비었/);
  assert.match(parseAnswer({ answer: 'x', claims: [] }).reason ?? '', /근거가 없/);
  assert.match(parseAnswer(null).reason ?? '', /답변이 비었/);
});

test('앵커 형식이 아니면 막는다 — 보관 단계에서 어차피 거부된다', () => {
  for (const bad of ['wiki/entities/acme.md', 'src-kickoff', '', 'slide-7']) {
    const r = parseAnswer({ answer: 'x', claims: [{ text: 't', source: bad }] });
    assert.match(r.reason ?? '', /앵커 형식/, bad);
  }
});

test('스키마가 answer 와 claims 를 필수로 잡는다', () => {
  assert.deepEqual([...ANSWER_SCHEMA.required], ['answer', 'claims']);
  assert.equal(ANSWER_SCHEMA.properties.claims.minItems, 1);
  assert.equal(ANSWER_SCHEMA.additionalProperties, false);
});

/* ---------------- 보관 ---------------- */

test('보관 경로가 관문 2 를 통과한다', () => {
  const p = synthesisPath(Q);
  assert.ok(p.startsWith('wiki/synthesis/'));
  assert.ok(PAGE_PATH_RE.test(p), p);
  assert.ok(PAGE_PATH_RE.test(synthesisPath('계약 갱신일 · 보증 한도?')), synthesisPath('계약 갱신일 · 보증 한도?'));
  assert.ok(PAGE_PATH_RE.test(synthesisPath('***')));
});

test('보관 ChangeSet 이 관문 7개를 통과한다 — 질의도 관문 8 을 거친다', () => {
  const cs = toChangeSet(Q, A, NOW);
  assert.deepEqual([...validateShape(cs), ...validateAnchors(cs, ANCHORS)], []);
  assert.equal(cs.ops[0]!.op, 'create');
  assert.equal(cs.ops[0]!.baseHash, null);
});

test('보관 페이지가 근거를 앵커 인용으로 갖는다', () => {
  const page = parsePage(toChangeSet(Q, A, NOW).ops[0]!.content!);
  assert.equal(page.front.type, 'synthesis');
  assert.equal(page.front.title, Q);
  assert.deepEqual(page.front.claims.map((c) => c.source), ['src-kickoff#slide-7', 'src-contract#page-2']);
  assert.ok(page.front.claims.every((c) => c.confidence === 'EXTRACTED'));
  assert.match(page.body, /\[\^src-kickoff#slide-7\]/);
  assert.match(page.body, /\[\^src-contract#page-2\]/);
  assert.equal(page.front.updated, NOW);
});

test('참고한 페이지가 wikilink 로 남는다 — 그래프에서 이어진다', () => {
  const body = parsePage(toChangeSet(Q, A, NOW).ops[0]!.content!).body;
  assert.match(body, /\[\[entities\/acme\]\]/);
  assert.match(body, /\[\[entities\/beta\]\]/);
  assert.equal(parsePage(toChangeSet(Q, { ...A, pages: [] }, NOW).ops[0]!.content!).body.includes('참고한 페이지'), false);
});

test('없는 앵커를 지어내면 보관에서 막힌다', () => {
  const bad: Answer = { ...A, claims: [{ text: 't', source: 'src-kickoff#slide-99' }] };
  const v = validateAnchors(toChangeSet(Q, bad, NOW), ANCHORS);
  // 본문 인용과 claims.source 양쪽에서 잡히므로 같은 앵커가 두 번 나온다
  assert.ok(v.length >= 1);
  assert.ok(v.every((x) => x.gate === 5));
  assert.match(v[0]!.reason, /slide-99/);
});

test('긴 답변도 요약 상한을 넘지 않는다', () => {
  const long: Answer = { ...A, answer: '가'.repeat(500) };
  const page = parsePage(toChangeSet(Q, long, NOW).ops[0]!.content!);
  assert.ok(page.front.summary.length <= SUMMARY_MAX);
  assert.deepEqual(validateShape(toChangeSet(Q, long, NOW)), []);
});
