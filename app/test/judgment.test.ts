import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JUDGMENT_IDS, JUDGMENT_NAMES, JUDGMENT_SCHEMA, judgmentPrompt, parseJudgment, summarizeJudgment,
} from '../src/core/lint/judgment.ts';
import type { WikiEntry } from '../src/core/wiki.ts';

const entry = (slug: string, title: string): WikiEntry => ({
  path: `wiki/entities/${slug}.md`,
  page: {
    front: {
      id: `ent-${slug}`, type: 'entity', title, summary: '요약.', aliases: [], tags: [], claims: [],
      openQuestions: [], derivedFrom: null, generatedBy: null, updated: '2026-09-06T00:00:00.000Z', updatedBy: 'app',
    },
    body: '\n# 본문\n\n아주 긴 본문이 여기 있다.\n',
  },
});
const ENTRIES = [entry('acme', '에이콤'), entry('beta', '베타테크')];
const KNOWN = new Set(ENTRIES.map((e) => e.path));

/* ---------------- 프롬프트 ---------------- */

test('네 가지만 본다 — 계산 검사는 여기 없다', () => {
  const p = judgmentPrompt(ENTRIES);
  for (const id of JUDGMENT_IDS) assert.ok(p.includes(JUDGMENT_NAMES[id]), String(id));
  for (const 계산 of ['고아 페이지', '깨진 앵커', '한국어 AI 티']) assert.equal(p.includes(계산), false, 계산);
});

test('페이지 목록만 준다. 본문은 에이전트가 당겨 간다', () => {
  const p = judgmentPrompt(ENTRIES);
  assert.ok(p.includes('wiki/entities/acme.md — 에이콤'));
  assert.equal(p.includes('아주 긴 본문'), false, '본문이 프롬프트에 실렸습니다');
  assert.ok(p.includes('get_page'));
});

test('오탐을 막는 지시가 들어 있다', () => {
  const p = judgmentPrompt(ENTRIES);
  assert.match(p, /확실한 것만/);
  assert.match(p, /억지로 채우지 않는다/);
});

test('스키마가 네 검사만 허용한다', () => {
  assert.deepEqual([...JUDGMENT_SCHEMA.properties.findings.items.properties.check.enum], [1, 2, 4, 6]);
  assert.equal(JUDGMENT_SCHEMA.additionalProperties, false);
});

/* ---------------- 응답 검사 ---------------- */

const finding = (over: Record<string, unknown> = {}) => ({
  check: 1, pages: ['wiki/entities/acme.md'], message: '두 페이지가 다르게 말한다.', fix: '원본을 다시 보라.', ...over,
});

test('제대로 된 지적을 통과시킨다', () => {
  const r = parseJudgment({ findings: [finding()] }, KNOWN);
  assert.equal(r.dropped, 0);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.check, 1);
});

test('없는 페이지를 가리키면 버린다 — 모델이 경로를 지어낸다', () => {
  const r = parseJudgment({ findings: [finding({ pages: ['wiki/entities/없음.md'] })] }, KNOWN);
  assert.deepEqual(r.findings, []);
  assert.equal(r.dropped, 1);
});

test('실재하는 경로만 남기고 지적은 살린다', () => {
  const r = parseJudgment({ findings: [finding({ pages: ['wiki/entities/acme.md', 'wiki/entities/없음.md'] })] }, KNOWN);
  assert.deepEqual(r.findings[0]!.pages, ['wiki/entities/acme.md']);
  assert.equal(r.dropped, 0);
});

test('4번은 페이지가 비어도 살린다 — 없는 페이지를 지적하는 검사다', () => {
  const r = parseJudgment({ findings: [finding({ check: 4, pages: [] })] }, KNOWN);
  assert.equal(r.findings.length, 1);
  assert.equal(r.dropped, 0);
});

test('모르는 검사 번호와 빈 문구는 버린다', () => {
  const bad = [finding({ check: 3 }), finding({ check: 99 }), finding({ message: '  ' }), finding({ fix: '' }), finding({ check: '1' })];
  const r = parseJudgment({ findings: bad }, KNOWN);
  assert.deepEqual(r.findings, []);
  assert.equal(r.dropped, 5);
});

test('findings 가 배열이 아니면 사유를 준다', () => {
  assert.match(parseJudgment({}, KNOWN).reason ?? '', /findings/);
  assert.match(parseJudgment(null, KNOWN).reason ?? '', /findings/);
});

test('빈 지적은 정상이다 — 억지로 채우지 않는다', () => {
  const r = parseJudgment({ findings: [] }, KNOWN);
  assert.deepEqual(r, { findings: [], dropped: 0, reason: null });
});

/* ---------------- 요약 ---------------- */

test('log.md 한 줄 — 검사별 건수', () => {
  const r = parseJudgment({ findings: [finding(), finding(), finding({ check: 6 })] }, KNOWN);
  assert.equal(summarizeJudgment(r), '페이지 간 모순 2건, 데이터 공백 1건');
});

test('버린 지적이 있으면 같이 알린다 — 사람이 모델을 못 믿을 근거가 된다', () => {
  const r = parseJudgment({ findings: [finding(), finding({ check: 99 })] }, KNOWN);
  assert.equal(summarizeJudgment(r), '페이지 간 모순 1건 (버린 지적 1건)');
  assert.equal(summarizeJudgment(parseJudgment({ findings: [] }, KNOWN)), '지적 없음');
  assert.equal(summarizeJudgment(parseJudgment({ findings: [finding({ check: 99 })] }, KNOWN)), '지적 없음 (버린 지적 1건)');
});
