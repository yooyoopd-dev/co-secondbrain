import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint, summarize } from '../src/core/lint/index.ts';
import { findDuplicates, passesGate, normalizeLabel, jaroWinkler, SIMILARITY_THRESHOLD } from '../src/core/lint/dedup.ts';
import { detect } from '../src/core/lint/korean.ts';
import { emptyPage, type Claim, type Page } from '../src/core/page.ts';

const page = (id: string, title: string, opts: { body?: string; claims?: Claim[]; type?: Page['front']['type']; aliases?: string[] } = {}): Page => {
  const p = emptyPage(id, opts.type ?? 'entity', title);
  if (opts.body !== undefined) p.body = opts.body;
  if (opts.claims) p.front.claims = opts.claims;
  if (opts.aliases) p.front.aliases = opts.aliases;
  return p;
};

const ANCHORS = new Map([['src-kickoff', new Set(['slide-12'])]]);

const check = (r: ReturnType<typeof lint>, n: number) => r.findings.filter((f) => f.check === n);

/* ---------- #7 출처 없는 주장 ---------- */

test('#7 — 출처 없는 주장을 잡는다', () => {
  const r = lint([page('ent-a', '가', {
    claims: [{ text: '계약이 갱신됐다', source: null, confidence: 'INFERRED', score: 0.85 }],
  })], ANCHORS);
  assert.equal(check(r, 7).length, 1);
});

test('#7 — AMBIGUOUS 는 출처를 요구하지 않고 #10 으로 간다', () => {
  const r = lint([page('ent-a', '가', {
    claims: [{ text: '갱신일이 불분명하다', source: null, confidence: 'AMBIGUOUS' }],
  })], ANCHORS);
  assert.equal(check(r, 7).length, 0);
  assert.equal(check(r, 10).length, 1);
});

/* ---------- #8 깨진 앵커 ---------- */

test('#8 — 원본은 있는데 앵커 번호가 밀린 인용을 잡는다', () => {
  const r = lint([page('ent-a', '가', { body: '\n확정됐다. [^src-kickoff#slide-99]\n' })], ANCHORS);
  assert.equal(check(r, 8).length, 1);
  assert.match(check(r, 8)[0]!.message, /slide-99/);
});

test('#8 — 없는 원본 인용도 잡는다', () => {
  const r = lint([page('ent-a', '가', { body: '\n[^src-없음#p-1]\n' })], ANCHORS);
  assert.match(check(r, 8)[0]!.message, /없는 원본/);
});

test('#8 — claim.source 도 본문과 같이 검사한다', () => {
  const r = lint([page('ent-a', '가', {
    claims: [{ text: 'x', source: 'src-kickoff#slide-77', confidence: 'EXTRACTED' }],
  })], ANCHORS);
  assert.equal(check(r, 8).length, 1);
});

test('#8 — 실재하는 앵커는 지적하지 않는다', () => {
  const r = lint([page('ent-a', '가', {
    body: '\n확정됐다. [^src-kickoff#slide-12]\n',
    claims: [{ text: 'x', source: 'src-kickoff#slide-12', confidence: 'EXTRACTED' }],
  })], ANCHORS);
  assert.equal(check(r, 8).length, 0);
});

/* ---------- #9 엔티티 중복 (M0 §4 테스트 세트) ---------- */

/* 병합돼야 하는 쌍. spikes/similarity/run.mjs 와 같은 목록이다. */
const SAME: [string, string][] = [
  ['에이콤(주)', '에이콤'],
  ['에이콤(주)', '주식회사 에이콤'],
  ['에이콤', '에이콤이'],
  ['에이콤', '에이콤은'],
  ['에이콤', '에이콤에서'],
  ['에이콤 주식회사', '에이콤주식회사'],
  ['Acme Corp', 'ACME Corp.'],
  ['홍길동 과장', '홍길동과장'],
  ['클라우드 마이그레이션', '클라우드마이그레이션'],
];

/* 절대 병합되면 안 되는 쌍. 위키에서 오병합은 복구가 어렵다 — 오탐 0 이 절대 조건이다. */
const DIFFERENT: [string, string][] = [
  ['에이콤', '에이스콤'],
  ['김철수', '김영수'],
  ['구매팀', '구매팀장'],
  ['개발1팀', '개발2팀'],
  ['에이콤', '베이콤'],
  ['계약 갱신', '계약 해지'],
  ['2026년 계획', '2027년 계획'],
  ['서울지사', '서울지점'],
];

const pair = (a: string, b: string) =>
  findDuplicates([{ id: 'x', label: a }, { id: 'y', label: b }]);

test('#9 — 오병합 0건 (절대 조건)', () => {
  const merged = DIFFERENT.filter(([a, b]) => pair(a, b).length > 0);
  assert.deepEqual(merged, [], `오병합: ${merged.map((m) => m.join(' | ')).join(', ')}`);
});

test('#9 — 같은 대상 쌍을 찾아낸다', () => {
  const missed = SAME.filter(([a, b]) => pair(a, b).length === 0);
  assert.deepEqual(missed, [], `놓침: ${missed.map((m) => m.join(' | ')).join(', ')}`);
});

/* 커뮤니티 가중치를 넣었다가 뺀 이유를 코드가 아니라 수치로 남긴다. */
test('#9 — 같은 커뮤니티 가중치는 오병합을 만든다 (그래서 판정에 쓰지 않는다)', () => {
  const s = jaroWinkler(normalizeLabel('구매팀'), normalizeLabel('구매팀장'));
  assert.ok(s < SIMILARITY_THRESHOLD, `${s}`);
  assert.ok(s + 0.02 >= SIMILARITY_THRESHOLD, `가중치를 더하면 임계를 넘는다: ${s + 0.02}`);
});

test('#9 — 커뮤니티 일치는 표시만 한다', () => {
  const out = findDuplicates(
    [{ id: 'x', label: '에이콤(주)' }, { id: 'y', label: '에이콤' }],
    () => true,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.sameCommunity, true);
});

test('#9 — 짧고 모호한 이름은 게이트가 막는다', () => {
  for (const s of ['AI', 'DB', 'PM', 'QA', '팀']) {
    assert.equal(passesGate(s), false, `게이트를 통과하면 안 됩니다: ${s}`);
  }
});

test('#9 — 이미 aliases 로 연결된 쌍은 후보가 아니다', () => {
  const out = findDuplicates([
    { id: 'x', label: '에이콤(주)', aliases: ['에이콤'] },
    { id: 'y', label: '에이콤' },
  ]);
  assert.deepEqual(out, []);
});

test('#9 — source 페이지는 중복 검사 대상이 아니다', () => {
  const r = lint([
    page('src-a', '킥오프 발표', { type: 'source' }),
    page('src-b', '킥오프 발표', { type: 'source' }),
  ], ANCHORS);
  assert.equal(check(r, 9).length, 0);
});

/* ---------- #11 한국어 AI 티 ---------- */

test('#11 — 번역투와 이중 피동을 잡는다', () => {
  const r = detect('에이콤은 경쟁력을 가지고 있다. 계약은 갱신되어진다.');
  assert.deepEqual(r.hits.map((h) => h.id), ['A-7', 'A-8']);
  assert.equal(r.s1, 2);
  assert.equal(r.grade, 'C'); // S1 이 2건까지는 C, 3건부터 D
});

test('#11 — 보호 구역(코드·앵커·표)은 탐지하지 않는다', () => {
  const r = detect('```\n경쟁력을 가지고 있다\n```\n\n[^src-a#경쟁력을 가지고 있다]\n');
  assert.equal(r.s1, 0, JSON.stringify(r.hits));
});

test('#11 — 정상 한국어 문장에 오탐이 없다', () => {
  const r = detect('에이콤이 주 협력사로 확정됐다. 계약 갱신일은 2026년 3월 1일이다.');
  assert.equal(r.s1, 0, JSON.stringify(r.hits));
});

test('#11 — S2 는 1건이면 올리지 않는다 (밀집일 때만 신호)', () => {
  const one = lint([page('ent-a', '가', { body: '\n계약이 에이콤에 의해 갱신됐다.\n' })], ANCHORS);
  assert.equal(check(one, 11).length, 0);
  const two = lint([page('ent-a', '가', {
    body: '\n계약이 에이콤에 의해 갱신됐다. 일정이 팀에 의해 조정됐다.\n',
  })], ANCHORS);
  assert.equal(check(two, 11).length, 1);
});

/* ---------- 통합 ---------- */

test('#3 · #5 는 그래프 결과를 그대로 옮긴다', () => {
  const r = lint([
    page('ent-a', '가', { body: '\n[[ent-b]]\n' }),
    page('ent-b', '나', { body: '\n' }),
  ], ANCHORS);
  assert.deepEqual(check(r, 3).map((f) => f.page), ['ent-a']);
  assert.deepEqual(check(r, 5).map((f) => f.page), ['ent-b']);
});

test('깨끗한 위키는 지적이 없다', () => {
  const r = lint([
    page('ent-a', '가', { body: '\n에이콤이 주 협력사로 확정됐다. [^src-kickoff#slide-12] [[ent-b]]\n' }),
    page('ent-b', '나', { body: '\n계약 갱신일은 3월 1일이다. [^src-kickoff#slide-12] [[ent-a]]\n' }),
  ], ANCHORS);
  assert.deepEqual(r.findings, []);
  assert.equal(summarize(r), '지적 없음');
});

test('log.md 한 줄 요약을 만든다', () => {
  const r = lint([page('ent-a', '가', {
    claims: [{ text: '갱신일 불명', source: null, confidence: 'AMBIGUOUS' }],
  })], ANCHORS);
  assert.match(summarize(r), /고아 페이지 1건/);
  assert.match(summarize(r), /AMBIGUOUS 주장 1건/);
});

test('모든 지적에 사람이 할 일이 붙는다', () => {
  const r = lint([page('ent-a', '가', {
    body: '\n[^src-없음#p-1]\n',
    claims: [{ text: 'x', source: null, confidence: 'EXTRACTED' }],
  })], ANCHORS);
  assert.ok(r.findings.length > 0);
  for (const f of r.findings) assert.ok(f.fix.length > 0, JSON.stringify(f));
});
