import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
// 사내 PC 에서 도는 회수 스크립트. 의존성이 없어야 해서 app 코드를 import 하지 못한다.
// 그래서 값이 복사돼 있고, 어긋나면 여기서 잡는다.
import { CASES, CLIS, CONVENTION, PAGE_TEMPLATE, SCHEMA, check, geminiTokens, promptFor, stripFence, unwrapGemini } from '../../spikes/cli/record.mjs';
import { CHANGESET_SCHEMA } from '../src/core/agent/schema.ts';
import { buildArgv as gBuildArgv, usageFromStats } from '../src/core/agent/gemini.ts';
import { PAGE_TEMPLATE as APP_TEMPLATE } from '../src/core/agent/ingest.ts';

test('회수 스크립트의 스키마가 app 의 것과 같다', () => {
  assert.deepEqual(SCHEMA, JSON.parse(JSON.stringify(CHANGESET_SCHEMA)));
});

test('회수 스크립트가 앱과 같은 인자로 gemini 를 부른다', () => {
  // 어긋나면 회수본이 앱 경로의 증거가 아니게 된다. 실제로 어긋난 적이 있다 —
  // 스파이크만 프롬프트를 argv 로 넘겨서 사내 왕복 한 번을 버렸다 (ROADMAP.md §8.4).
  assert.deepEqual(CLIS.find((c) => c.id === 'gemini')!.args('/tmp/wd'), gBuildArgv());
});

test('회수 스크립트와 앱이 토큰을 같은 셈으로 센다', () => {
  // 2026-09-07 사내 실측 봉투. candidates 만 더하면 181 이 빈다.
  const env = { stats: { models: { 'gemini-3.1-pro-preview': { tokens: { input: 9178, prompt: 9178, candidates: 2, total: 9361, cached: 0 } } } } };
  const app = usageFromStats(env);
  assert.deepEqual(geminiTokens(JSON.stringify(env)), { input: app.inputTokens, output: app.outputTokens });
  assert.equal(app.outputTokens, 183);
  assert.equal(geminiTokens('{"summary":"s"}'), null, 'stats 가 없으면 null');
});

test('봉투는 열고 벌거벗은 ChangeSet 은 그대로 둔다', () => {
  const bare = JSON.stringify({ summary: 's', ops: [] });
  assert.equal(unwrapGemini(bare), bare);
  assert.equal(unwrapGemini(JSON.stringify({ session_id: 'x', response: bare })), bare);
  assert.throws(() => unwrapGemini(JSON.stringify({ error: { message: '쿼터', code: 41 } })), /쿼터/);
});

test('회수 스크립트의 페이지 표본이 app 의 것과 같다', () => {
  assert.equal(PAGE_TEMPLATE, APP_TEMPLATE);
});

test('규약 파일에 페이지 표본이 그대로 들어간다', () => {
  assert.ok(CONVENTION.includes(PAGE_TEMPLATE));
  assert.equal(CONVENTION.includes('이모지'), true);
});

/* ---------------- check() — 종료 코드의 근거 ---------------- */

const KICKOFF = CASES[0]!;
const good = {
  summary: '에이콤 생성',
  ops: [{
    op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null,
    content: '---\nid: ent-acme\n---\n# 에이콤\n\n선정됐다.[^src-kickoff#slide-3]\n',
  }],
};

test('check — 정답 앵커만 인용하면 PASS 다', () => {
  assert.deepEqual(check(good, KICKOFF), { ok: true, fatal: false, reasons: [] });
});

test('check — 없는 앵커를 인용하면 치명(종료 코드 1)이다', () => {
  const bad = structuredClone(good);
  bad.ops[0]!.content = bad.ops[0]!.content.replace('slide-3', 'slide-99');
  const r = check(bad, KICKOFF);
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true, '오탐 0 검사가 종료 코드로 강제되지 않습니다');
  assert.match(r.reasons.join(' '), /없는 앵커/);
});

test('check — 경로 형식 위반은 잡되 치명은 아니다', () => {
  const bad = structuredClone(good);
  bad.ops[0]!.path = 'entities/에이콤(주).md'; // M0 §1.4 에서 모델이 실제로 낸 형태
  const r = check(bad, KICKOFF);
  assert.equal(r.ok, false);
  assert.equal(r.fatal, false);
});

test('check — front-matter 없이 시작하면 잡는다', () => {
  const bad = structuredClone(good);
  bad.ops[0]!.content = '# 에이콤\n';
  assert.equal(check(bad, KICKOFF).ok, false);
});

test('check — summary 가 비거나 ops 가 없으면 잡는다', () => {
  assert.equal(check({ summary: ' ', ops: [] }, KICKOFF).ok, false);
  assert.equal(check(null, KICKOFF).ok, false);
});

test('check — overview 경로는 허용한다', () => {
  const ok = structuredClone(good);
  ok.ops[0]!.path = '02_NOTES/overview.md';
  assert.equal(check(ok, KICKOFF).ok, true);
});

/* ---------------- 프롬프트 ---------------- */

test('프롬프트에 그 사례의 앵커가 전부 들어간다', () => {
  for (const c of CASES) {
    const p = promptFor(c, false);
    for (const [loc] of c.chunks) assert.ok(p.includes(`${c.sourceId}#${loc}`), `${c.id}: ${loc} 누락`);
  }
});

test('스키마는 B등급(Gemini)에서만 프롬프트에 붙는다', () => {
  assert.equal(promptFor(CASES[0]!, false).includes('JSON Schema'), false);
  assert.ok(promptFor(CASES[0]!, true).includes('JSON Schema'));
});

test('사례의 앵커 좌표가 서로 겹치지 않는다 — 검사가 사례를 헷갈리면 안 된다', () => {
  const all = CASES.flatMap((c) => c.chunks.map(([loc]) => `${c.sourceId}#${loc}`));
  assert.equal(new Set(all).size, all.length);
});

/* ---------------- 펜스 처리 ---------------- */

test('펜스가 있어도 없어도 같은 JSON 을 뽑는다', () => {
  const bare = '{"summary":"s","ops":[]}';
  assert.equal(stripFence(bare), bare);
  assert.equal(stripFence('```json\n' + bare + '\n```'), bare);
  assert.equal(stripFence('앞말\n```\n' + bare + '\n```\n뒷말'), bare);
});

test('녹화된 Gemini 실응답이 회수 스크립트의 검사도 통과한다', async () => {
  const raw = await fs.readFile(new URL('./fixtures/gemini-ok.txt', import.meta.url), 'utf8');
  const r = check(JSON.parse(stripFence(raw)), KICKOFF);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
});

/* ---------------- 회수된 실응답이 진짜 관문을 통과하는가 ---------------- */

import { validateAnchors, validateShape, type ChangeSet } from '../src/core/changeset.ts';

/** record.mjs 의 검사는 의존성 0 이라 가볍다. 여기서 app 의 관문으로 다시 본다. */
const RECORDED: { file: string; caseId: string; extract: (s: string) => unknown }[] = [
  ...CASES.map((c) => ({ file: `claude-code-${c.id}.txt`, caseId: c.id, extract: (s: string) => JSON.parse(s).structured_output })),
  // 옛 녹화본은 평문이고 새 녹화본은 `-o json` 봉투다. 같은 검사가 둘 다 읽어야 한다.
  ...CASES.map((c) => ({ file: `gemini-${c.id}.txt`, caseId: c.id, extract: (s: string) => JSON.parse(stripFence(unwrapGemini(s))) })),
];

/**
 * 회수는 폴더에 번호를 붙이기 전에 했고, 그때 규약이 알려 준 접두는 `wiki/` 였다.
 * **녹화 파일은 증거라 고치지 않는다.** 접두만 지금 이름으로 옮겨 관문에 넣는다 —
 * 이 검사가 보는 것은 접두의 철자가 아니라 모델이 형식과 앵커를 맞췄는가다.
 */
function retarget(cs: ChangeSet): ChangeSet {
  return { ...cs, ops: cs.ops.map((o) => ({ ...o, path: o.path.replace(/^wiki\//, '02_NOTES/') })) };
}

for (const r of RECORDED) {
  test(`회수 응답 ${r.file} 이 관문 7개를 통과한다`, async () => {
    const raw = await fs.readFile(new URL(`../../spikes/fixtures/cli/${r.file}`, import.meta.url), 'utf8');
    const cs = retarget(r.extract(raw) as ChangeSet);
    const c = CASES.find((x) => x.id === r.caseId)!;
    const anchors = new Map<string, ReadonlySet<string>>([
      [c.sourceId, new Set(c.chunks.map(([loc]) => loc))],
    ]);
    assert.deepEqual([...validateShape(cs), ...validateAnchors(cs, anchors)], []);
  });
}

test('Gemini 실응답 3건이 전부 펜스 없는 순수 JSON 이다 (n=3)', async () => {
  for (const c of CASES) {
    const raw = await fs.readFile(new URL(`../../spikes/fixtures/cli/gemini-${c.id}.txt`, import.meta.url), 'utf8');
    assert.equal(raw.includes('```'), false, `${c.id} 에 펜스가 있습니다`);
    assert.equal(raw.trim().startsWith('{'), true, `${c.id} 가 { 로 시작하지 않습니다`);
  }
});
