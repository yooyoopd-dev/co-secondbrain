import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { CHANGESET_SCHEMA, schemaWithoutPattern } from '../src/core/agent/schema.ts';
import { prepareWorkdir, disposeWorkdir } from '../src/core/agent/workdir.ts';
import { BLOCKED_TOOLS, buildArgv, createClaudeCode, parseResult } from '../src/core/agent/claude-code.ts';
import { addUsage, ZERO_USAGE, type Exec } from '../src/core/agent/types.ts';
import { OVERVIEW_PATH, PAGE_PATH_RE, validateAnchors, validateShape, type ChangeSet } from '../src/core/changeset.ts';

/** 2026-09-05 실호출을 그대로 저장한 것. 테스트는 네트워크를 타지 않는다 (M2-PLAN.md §3.1) */
const FIXTURE = await fs.readFile(new URL('./fixtures/claude-code-ok.json', import.meta.url), 'utf8');

const exec = (stdout: string, stderr = '', code = 0): Exec => async () => ({ stdout, stderr, code });
const job = { workdir: '/tmp/x', prompt: 'p' };

/* ---------------- 녹화 재생 — 실호출 응답이 관문을 통과한다 ---------------- */

test('녹화된 실호출 응답이 관문 7개를 통과한다', () => {
  const r = parseResult(FIXTURE);
  assert.equal(r.ok, true, r.error);
  const cs = r.data as ChangeSet;
  const known = new Map([['src-kickoff', new Set(['slide-3', 'slide-12'])]]);
  assert.deepEqual([...validateShape(cs), ...validateAnchors(cs, known)], []);
});

test('녹화된 응답에서 과금 내역을 뽑는다 — 지출 계량기의 입력', () => {
  const { usage, sessionId } = parseResult(FIXTURE);
  assert.equal(usage.costUsd, 0.130616);
  assert.equal(usage.cacheCreationTokens, 28888);
  assert.equal(usage.cacheReadTokens, 0);
  assert.ok(usage.outputTokens > 0);
  // 세션 id 가 없으면 배치 재개가 불가능하고 문서당 비용이 2.6배가 된다
  assert.match(sessionId ?? '', /^[0-9a-f-]{36}$/);
});

/* ---------------- parseResult — 실패 경로 ---------------- */

test('is_error 응답은 실패로 처리하고 과금은 그대로 센다', () => {
  const raw = JSON.stringify({ is_error: true, subtype: 'error_max_turns', result: '턴 상한', session_id: 's1', total_cost_usd: 0.02 });
  const r = parseResult(raw);
  assert.equal(r.ok, false);
  assert.equal(r.error, '턴 상한');
  assert.equal(r.usage.costUsd, 0.02); // 실패해도 돈은 나갔다
  assert.equal(r.sessionId, 's1');
});

test('structured_output 이 없으면 실패다 — 스크래핑으로 되돌아가지 않는다', () => {
  const r = parseResult(JSON.stringify({ subtype: 'success', result: '```json\n{"summary":"x"}\n```' }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /structured_output/);
});

test('JSON 이 아닌 stdout 은 실패다', () => {
  const r = parseResult('claude: command failed');
  assert.equal(r.ok, false);
  assert.deepEqual(r.usage, ZERO_USAGE);
  assert.equal(r.raw, 'claude: command failed');
});

test('usage 가 없는 응답도 0 으로 읽는다', () => {
  const r = parseResult(JSON.stringify({ subtype: 'success', structured_output: {}, session_id: 's' }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.usage, ZERO_USAGE);
});

/* ---------------- buildArgv ---------------- */

test('새 세션은 --session-id, 재개는 --resume 이다', () => {
  const fresh = buildArgv(job, {}, 'uuid-1');
  assert.ok(fresh.includes('--session-id'));
  assert.equal(fresh[fresh.indexOf('--session-id') + 1], 'uuid-1');
  assert.ok(!fresh.includes('--resume'));

  const resumed = buildArgv({ ...job, resumeSessionId: 'sess-9' }, {}, 'uuid-1');
  assert.ok(resumed.includes('--resume'));
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'sess-9');
  assert.ok(!resumed.includes('--session-id'));
});

test('도구를 전부 막는다 — M0 실측 8턴 $0.176 → 2턴 $0.130', () => {
  const argv = buildArgv(job, {}, 'u');
  const i = argv.indexOf('--disallowedTools');
  assert.ok(i > 0);
  for (const t of BLOCKED_TOOLS) assert.ok(argv.includes(t), `안 막힌 도구: ${t}`);
  assert.ok(argv.includes('--strict-mcp-config'));
});

test('스키마는 JSON 문자열로 넘어간다', () => {
  const argv = buildArgv(job, CHANGESET_SCHEMA, 'u');
  const s = argv[argv.indexOf('--json-schema') + 1]!;
  assert.deepEqual(JSON.parse(s), JSON.parse(JSON.stringify(CHANGESET_SCHEMA)));
});

/* ---------------- run() — 격리와 실패 처리 ---------------- */

test('부모 Claude Code 세션 정체를 물려주지 않는다 — --resume 이 부모와 충돌한다', async () => {
  process.env['CLAUDE_CODE_SESSION_ID'] = '부모세션';
  let seen: NodeJS.ProcessEnv = {};
  let cwd = '';
  const cli = createClaudeCode(async (_b, _a, o) => {
    seen = o.env;
    cwd = o.cwd;
    return { stdout: FIXTURE, stderr: '', code: 0 };
  });
  await cli.run({ workdir: '/tmp/wd', prompt: 'p' }, {});
  delete process.env['CLAUDE_CODE_SESSION_ID'];
  assert.equal(seen['CLAUDE_CODE_SESSION_ID'], undefined);
  assert.equal(cwd, '/tmp/wd'); // 격리 디렉터리에서 돈다
});

test('출력 없이 죽으면 stderr 를 담아 실패로 돌려준다 — 던지지 않는다', async () => {
  const cli = createClaudeCode(exec('', 'not logged in', 1));
  const r = await cli.run(job, {});
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /not logged in/);
});

test('CLI 를 못 띄워도 던지지 않는다 — 배치 하나가 배치 전체를 죽이면 안 된다', async () => {
  const cli = createClaudeCode(async () => {
    throw new Error('ENOENT');
  });
  const r = await cli.run(job, {});
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /ENOENT/);
});

test('detect 는 버전을 읽고, 실패하면 found=false 다', async () => {
  assert.deepEqual(await createClaudeCode(exec('2.1.261 (Claude Code)\n')).detect(), { found: true, version: '2.1.261' });
  assert.deepEqual(await createClaudeCode(exec('', '', 127)).detect(), { found: false });
  assert.deepEqual(
    await createClaudeCode(async () => {
      throw new Error('x');
    }).detect(),
    { found: false },
  );
});

/* ---------------- schema ---------------- */

test('스키마의 path 패턴은 관문 2 와 같은 것을 받고 같은 것을 막는다', () => {
  const re = new RegExp(CHANGESET_SCHEMA.properties.ops.items.properties.path.pattern);
  const ok = ['wiki/entities/acme-corp.md', 'wiki/concepts/계약-갱신.md', 'wiki/synthesis/a.md', OVERVIEW_PATH];
  const bad = ['entities/acme.md', 'wiki/entities/에이콤(주).md', '../../etc/passwd', 'wiki/other/a.md', 'wiki/entities/a.txt'];
  for (const p of ok) {
    assert.ok(re.test(p), `스키마가 막았다: ${p}`);
    assert.ok(p === OVERVIEW_PATH || PAGE_PATH_RE.test(p), `관문 2 가 막았다: ${p}`);
  }
  for (const p of bad) {
    assert.ok(!re.test(p), `스키마가 통과시켰다: ${p}`);
    assert.ok(p === OVERVIEW_PATH || !PAGE_PATH_RE.test(p), `관문 2 가 통과시켰다: ${p}`);
  }
});

test('schemaWithoutPattern 은 pattern 만 지우고 원본을 건드리지 않는다', () => {
  const s = schemaWithoutPattern() as typeof CHANGESET_SCHEMA;
  assert.equal(s.properties.ops.items.properties.path.pattern, undefined);
  assert.equal(s.properties.ops.items.properties.path.type, 'string');
  assert.ok(CHANGESET_SCHEMA.properties.ops.items.properties.path.pattern.length > 0);
});

/* ---------------- workdir ---------------- */

test('지정한 파일만 만든다 — Vault 루트를 통째로 주지 않는 이유다', async () => {
  const wd = await prepareWorkdir({ 'CLAUDE.md': '규약', 'extracted/a.md': '내용' });
  assert.deepEqual(wd.files, ['CLAUDE.md', 'extracted/a.md']);
  assert.equal(await fs.readFile(`${wd.root}/extracted/a.md`, 'utf8'), '내용');
  assert.deepEqual((await fs.readdir(wd.root)).sort(), ['CLAUDE.md', 'extracted']);
  await disposeWorkdir(wd);
});

test('작업 디렉터리 밖으로 나가는 경로는 던진다', async () => {
  await assert.rejects(() => prepareWorkdir({ '../탈출.md': 'x' }), /경로 탈출/);
});

test('폐기하면 남지 않고, 두 번 폐기해도 던지지 않는다', async () => {
  const wd = await prepareWorkdir({ 'a.md': 'x' });
  await disposeWorkdir(wd);
  await assert.rejects(() => fs.access(wd.root));
  await disposeWorkdir(wd);
});

/* ---------------- usage 합산 ---------------- */

test('배치 누적 — 과금을 더한다', () => {
  const a = { costUsd: 0.13, inputTokens: 2, outputTokens: 1506, cacheCreationTokens: 28888, cacheReadTokens: 0 };
  const b = { costUsd: 0.049, inputTokens: 3, outputTokens: 900, cacheCreationTokens: 1713, cacheReadTokens: 28888 };
  assert.deepEqual(addUsage(a, b), {
    costUsd: 0.179, inputTokens: 5, outputTokens: 2406, cacheCreationTokens: 30601, cacheReadTokens: 28888,
  });
});

/* ================= 배치 러너 ================= */

import { COST, documentsAffordable, runBatch, type BatchItem } from '../src/core/agent/batch.ts';

/** 2026-09-05 실호출 5건 배치를 그대로 저장한 것 */
const BATCH5 = JSON.parse(
  await fs.readFile(new URL('./fixtures/claude-code-batch5.json', import.meta.url), 'utf8'),
) as Record<string, string>;

const BATCH5_ANCHORS = new Map<string, ReadonlySet<string>>([
  ['src-kickoff', new Set(['slide-3'])],
  ['src-contract', new Set(['page-2'])],
  ['src-mail', new Set(['msg-1'])],
  ['src-cost', new Set(['원가!D4'])],
  ['src-minutes', new Set(['t-00:12:30'])],
]);

/** 호출을 기록하는 가짜 CLI. 넘겨받은 resumeSessionId 를 그대로 남긴다. */
function fakeCli(replies: readonly { stdout: string; stderr: string; code: number }[]) {
  const calls: (string | null | undefined)[] = [];
  let i = 0;
  const cli = createClaudeCode(async () => replies[Math.min(i, replies.length - 1)]!);
  const wrapped = {
    ...cli,
    run: async (job: Parameters<typeof cli.run>[0], schema: object) => {
      calls.push(job.resumeSessionId);
      const r = await cli.run(job, schema);
      i++;
      return r;
    },
  };
  return { cli: wrapped, calls };
}

const reply = (sessionId: string | null, cost: number) => ({
  stderr: '',
  code: 0,
  stdout: JSON.stringify({
    subtype: 'success', structured_output: { summary: 's', ops: [] },
    ...(sessionId ? { session_id: sessionId } : {}),
    total_cost_usd: cost, usage: { output_tokens: 10 },
  }),
});

const items = (n: number): BatchItem[] => Array.from({ length: n }, (_, i) => ({ id: `d${i}`, prompt: `p${i}` }));

test('배치 — 첫 건만 콜드고 나머지는 세션을 이어 붙인다', async () => {
  const { cli, calls } = fakeCli([reply('s1', 0.13), reply('s1', 0.016), reply('s1', 0.016)]);
  const r = await runBatch(cli, items(3), {}, { workdir: '/tmp/wd' });
  assert.deepEqual(calls, [null, 's1', 's1']);
  assert.equal(r.coldRuns, 1);
  assert.equal(r.outcomes.length, 3);
  assert.equal(Number(r.usage.costUsd.toFixed(4)), 0.162);
  assert.deepEqual(r.remaining, []);
  assert.equal(r.stoppedBy, undefined);
});

test('배치 — 세션 id 를 못 받으면 다음도 콜드로 돈다', async () => {
  const { cli, calls } = fakeCli([reply(null, 0.13), reply('s2', 0.13)]);
  const r = await runBatch(cli, items(2), {}, { workdir: '/tmp/wd' });
  assert.deepEqual(calls, [null, null]);
  assert.equal(r.coldRuns, 2);
});

test('배치 — 한 건이 실패해도 나머지를 계속한다', async () => {
  const failure = { stderr: '', code: 0, stdout: JSON.stringify({ is_error: true, subtype: 'error', result: '터짐', session_id: 's1', total_cost_usd: 0.02 }) };
  let i = 0;
  const replies = [reply('s1', 0.13), failure, reply('s1', 0.016)];
  const cli = createClaudeCode(async () => replies[i++]!);
  const r = await runBatch(cli, items(3), {}, { workdir: '/tmp/wd' });
  assert.equal(r.outcomes.length, 3);
  assert.deepEqual(r.outcomes.map((o) => o.result.ok), [true, false, true]);
  assert.equal(Number(r.usage.costUsd.toFixed(4)), 0.166); // 실패한 건의 비용도 센다
});

test('배치 — 예산이 모자라면 호출하기 전에 멈추고 남은 것을 돌려준다', async () => {
  const { cli, calls } = fakeCli([reply('s1', 0.13), reply('s1', 0.016)]);
  // 콜드 0.13 + 재개 0.049 예상 = 0.179 > 0.15 이므로 2번째 호출 전에 멈춘다
  const r = await runBatch(cli, items(4), {}, { workdir: '/tmp/wd', budgetUsd: 0.15 });
  assert.equal(r.stoppedBy, 'budget');
  assert.equal(calls.length, 1);
  assert.equal(r.outcomes.length, 1);
  assert.deepEqual(r.remaining, ['d1', 'd2', 'd3']);
  assert.equal(r.outcomes[0]!.result.ok, true); // 이미 만든 ChangeSet 은 보존한다
});

test('배치 — 예산이 첫 건도 감당 못 하면 아무것도 호출하지 않는다', async () => {
  const { cli, calls } = fakeCli([reply('s1', 0.13)]);
  const r = await runBatch(cli, items(2), {}, { workdir: '/tmp/wd', budgetUsd: 0.01 });
  assert.equal(calls.length, 0);
  assert.deepEqual(r.remaining, ['d0', 'd1']);
  assert.equal(r.usage.costUsd, 0);
});

test('배치 — 빈 목록은 빈 보고서다', async () => {
  const { cli } = fakeCli([reply('s1', 0.13)]);
  const r = await runBatch(cli, [], {}, { workdir: '/tmp/wd' });
  assert.deepEqual(r, { outcomes: [], remaining: [], usage: ZERO_USAGE, coldRuns: 0 });
});

test('남은 예산을 문서 수로 환산한다 — 화면에 달러 대신 이걸 띄운다', () => {
  assert.equal(documentsAffordable(0), 0);
  assert.equal(documentsAffordable(COST.coldTypicalUsd - 0.001), 0);
  assert.equal(documentsAffordable(COST.coldTypicalUsd), 1);
  assert.equal(documentsAffordable(COST.coldTypicalUsd + COST.resumedTypicalUsd), 2);
  assert.equal(documentsAffordable(50), 1 + Math.floor((50 - COST.coldTypicalUsd) / COST.resumedTypicalUsd));
});

test('녹화된 5건 배치가 전부 관문을 통과한다', () => {
  const ids = Object.keys(BATCH5);
  assert.equal(ids.length, 5);
  for (const id of ids) {
    const r = parseResult(BATCH5[id]!);
    assert.equal(r.ok, true, `${id}: ${r.error}`);
    const cs = r.data as ChangeSet;
    assert.deepEqual([...validateShape(cs), ...validateAnchors(cs, BATCH5_ANCHORS)], [], id);
  }
});

test('녹화된 배치에서 첫 건만 콜드고 나머지는 cache 읽기가 생성보다 크다', () => {
  const us = Object.values(BATCH5).map((raw) => parseResult(raw).usage);
  for (const [i, u] of us.entries()) {
    assert.ok(u.cacheReadTokens > u.cacheCreationTokens, `${i + 1}번째가 재개되지 않았습니다`);
  }
  // 2번째부터는 첫 건보다 싸다 — 세션 재개가 실제로 먹혔다는 증거
  for (const u of us.slice(1)) assert.ok(u.costUsd < us[0]!.costUsd);
});
