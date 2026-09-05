import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COST, DEFAULT_MONTHLY_USD, EMPTY_LOG, add, monthTotal, remainingUsd, status, summarize,
  type Limits, type SpendLog,
} from '../src/core/spend.ts';
import { read, write } from '../src/core/spend-file.ts';
import type { Usage } from '../src/core/agent/types.ts';

const usage = (costUsd: number): Usage => ({ costUsd, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
const NOW = '2026-09-06T10:00:00.000Z';

test('호출마다 누적한다', () => {
  let log = add(EMPTY_LOG, 'claude-code', usage(0.13), NOW);
  log = add(log, 'claude-code', usage(0.02), NOW);
  const t = monthTotal(log, 'claude-code', NOW);
  assert.equal(t.calls, 2);
  // 부동소수점 합이라 정확히 0.15 가 아니다. $50 상한 앞에서 1e-16 은 문제가 안 된다.
  assert.ok(Math.abs(t.costUsd - 0.15) < 1e-9, `${t.costUsd}`);
});

test('공급자를 섞어 세지 않는다', () => {
  let log = add(EMPTY_LOG, 'claude-code', usage(0.13), NOW);
  log = add(log, 'gemini', usage(0), NOW); // Gemini 는 비용을 보고하지 않는다
  assert.equal(monthTotal(log, 'claude-code', NOW).costUsd, 0.13);
  assert.deepEqual(monthTotal(log, 'gemini', NOW), { costUsd: 0, calls: 1 });
});

test('달이 바뀌면 다시 0 부터다', () => {
  let log = add(EMPTY_LOG, 'claude-code', usage(10), '2026-08-31T23:00:00.000Z');
  log = add(log, 'claude-code', usage(1), '2026-09-01T01:00:00.000Z');
  assert.equal(monthTotal(log, 'claude-code', '2026-09-15T00:00:00.000Z').costUsd, 1);
  assert.equal(monthTotal(log, 'claude-code', '2026-08-15T00:00:00.000Z').costUsd, 10);
});

/* ---------------- 상한 판정 ---------------- */

const spent = (usd: number): SpendLog => add(EMPTY_LOG, 'claude-code', usage(usd), NOW);
const L: Limits = { 'claude-code': DEFAULT_MONTHLY_USD };

test('상한을 모르면 경고도 폴백도 하지 않는다 — 모르는 값으로 품질을 낮추지 않는다', () => {
  const s = status(spent(999), {}, 'claude-code', NOW);
  assert.equal(s.level, 'unknown');
  assert.equal(s.limitUsd, null);
  assert.equal(s.pct, null);
  assert.equal(s.documentsLeft, null);
  assert.equal(s.spentUsd, 999); // 소비량은 안다
});

test('80% 에서 경고, 100% 에서 상한 도달', () => {
  assert.equal(status(spent(39), L, 'claude-code', NOW).level, 'ok');
  assert.equal(status(spent(40), L, 'claude-code', NOW).level, 'warn'); // 정확히 80%
  assert.equal(status(spent(49.99), L, 'claude-code', NOW).level, 'warn');
  assert.equal(status(spent(50), L, 'claude-code', NOW).level, 'over');
  assert.equal(status(spent(60), L, 'claude-code', NOW).level, 'over');
});

test('남은 예산을 문서 수로 환산한다 — 화면에는 달러 대신 이걸 띄운다', () => {
  const s = status(spent(0), L, 'claude-code', NOW);
  assert.equal(s.documentsLeft, 1 + Math.floor((50 - COST.coldTypicalUsd) / COST.resumedTypicalUsd));
  assert.equal(status(spent(50), L, 'claude-code', NOW).documentsLeft, 0);
  assert.equal(status(spent(49.95), L, 'claude-code', NOW).documentsLeft, 0); // 콜드 한 건도 안 된다
});

test('한 줄 요약은 문서 수를 먼저 말한다', () => {
  assert.match(summarize(status(spent(0), L, 'claude-code', NOW)), /남은 문서 약 \d+건/);
  assert.match(summarize(status(spent(50), L, 'claude-code', NOW)), /상한 도달/);
  assert.match(summarize(status(spent(1), {}, 'claude-code', NOW)), /상한 미입력/);
});

test('배치에 넘길 남은 예산. 상한을 모르면 제한하지 않는다', () => {
  assert.equal(remainingUsd(spent(10), L, 'claude-code', NOW), 40);
  assert.equal(remainingUsd(spent(60), L, 'claude-code', NOW), 0);
  assert.equal(remainingUsd(spent(10), {}, 'claude-code', NOW), undefined);
});

/* ---------------- 저장 ---------------- */

test('지출 기록 왕복. 깨졌으면 빈 것으로 시작한다', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-sp-'));
  const file = path.join(dir, 'nested', 'spend.json');
  assert.deepEqual(await read(file), EMPTY_LOG);
  const log = add(EMPTY_LOG, 'claude-code', usage(0.13), NOW);
  await write(file, log); // 없는 디렉터리도 만든다
  assert.deepEqual(await read(file), log);
  await fs.writeFile(file, '{망가짐', 'utf8');
  assert.deepEqual(await read(file), EMPTY_LOG);
});

test('기본 상한은 사내 기업계정 실제 예산이다', () => {
  assert.equal(DEFAULT_MONTHLY_USD, 50);
});
