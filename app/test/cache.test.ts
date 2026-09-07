import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_MANIFEST, hashContent, markProposed, planWork, readManifest, recordSource, writeManifest,
  type Manifest, type SourceState,
} from '../src/core/cache.ts';
import { createVault } from '../src/core/vault.ts';

const vault = async () => createVault(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-mf-')), { id: 'p', title: 'P', hub: null });

const src = (name: string, content: string): SourceState => ({
  sourceId: `src-${name}`,
  filename: `${name}.pptx`,
  contentHash: hashContent(content),
});

const NOW = '2026-09-06T00:00:00.000Z';

test('해시는 내용만 본다. 이름이 달라도 같은 값이다', () => {
  assert.equal(src('a', '같은 내용').contentHash, src('b', '같은 내용').contentHash);
  assert.notEqual(src('a', '내용 1').contentHash, src('a', '내용 2').contentHash);
});

test('처음 보는 원본은 CLI 로 보낸다', () => {
  const a = src('kickoff', '킥오프');
  assert.deepEqual(planWork(EMPTY_MANIFEST, [a]), { fresh: [a], renamed: [], unchanged: [] });
});

test('인제스트만 하고 변경안을 안 만들었으면 건너뛰지 않는다', () => {
  // 여기서 건너뛰면 그 문서는 영영 위키에 안 들어간다
  const a = src('kickoff', '킥오프');
  const m = recordSource(EMPTY_MANIFEST, a);
  assert.deepEqual(planWork(m, [a]).fresh, [a]);
  assert.deepEqual(planWork(m, [a]).unchanged, []);
});

test('변경안을 만들었고 내용도 그대로면 CLI 를 안 부른다 — 문서당 $0.02~$0.13 을 아낀다', () => {
  const a = src('kickoff', '킥오프');
  const m = markProposed(recordSource(EMPTY_MANIFEST, a), a.contentHash, 'claude-code', NOW);
  const plan = planWork(m, [a]);
  assert.deepEqual(plan.unchanged, [a]);
  assert.deepEqual(plan.fresh, []);
});

test('이름만 바뀌면 경로만 갱신하고 다시 묻지 않는다 (PLAN.md §9.1)', () => {
  const before = src('kickoff', '킥오프');
  const m = markProposed(recordSource(EMPTY_MANIFEST, before), before.contentHash, 'gemini', NOW);
  const after: SourceState = { ...before, filename: '킥오프-최종.pptx', sourceId: 'src-킥오프-최종' };
  const plan = planWork(m, [after]);
  assert.deepEqual(plan.renamed, [{ from: 'kickoff.pptx', to: after }]);
  assert.deepEqual(plan.fresh, [], '이름만 바뀌었는데 다시 물었습니다');
});

test('내용이 바뀌면 다시 묻는다', () => {
  const before = src('kickoff', '킥오프 v1');
  const m = markProposed(recordSource(EMPTY_MANIFEST, before), before.contentHash, 'claude-code', NOW);
  const after = src('kickoff', '킥오프 v2');
  assert.deepEqual(planWork(m, [after]).fresh, [after]);
});

test('여러 건이 섞여도 각각 분류한다', () => {
  const done = src('a', 'A');
  const pending = src('b', 'B');
  let m = recordSource(EMPTY_MANIFEST, done);
  m = markProposed(m, done.contentHash, 'claude-code', NOW);
  m = recordSource(m, pending);
  const brand = src('c', 'C');
  const plan = planWork(m, [done, pending, brand]);
  assert.deepEqual(plan.unchanged.map((x) => x.sourceId), ['src-a']);
  assert.deepEqual(plan.fresh.map((x) => x.sourceId).sort(), ['src-b', 'src-c']);
});

test('recordSource 는 이미 만든 변경안 기록을 지우지 않는다', () => {
  const a = src('a', 'A');
  let m = markProposed(recordSource(EMPTY_MANIFEST, a), a.contentHash, 'gemini', NOW);
  m = recordSource(m, a); // 다시 인제스트
  assert.equal(m.entries[a.contentHash]!.proposedAt, NOW);
  assert.equal(m.entries[a.contentHash]!.provider, 'gemini');
});

test('모르는 해시에 markProposed 하면 아무 일도 안 한다', () => {
  assert.deepEqual(markProposed(EMPTY_MANIFEST, 'deadbeef', 'gemini', NOW), EMPTY_MANIFEST);
});

/* ---------------- 저장 ---------------- */

test('manifest 왕복', async () => {
  const v = await vault();
  const a = src('a', 'A');
  const m = markProposed(recordSource(EMPTY_MANIFEST, a), a.contentHash, 'claude-code', NOW);
  await writeManifest(v, m);
  assert.deepEqual(await readManifest(v), m);
});

test('manifest 가 없거나 깨졌으면 빈 것으로 시작한다 — 캐시는 재생성 가능하다', async () => {
  const v = await vault();
  assert.deepEqual(await readManifest(v), EMPTY_MANIFEST);
  await fs.writeFile(path.join(v.root, '.sb/manifest.json'), '{망가짐', 'utf8');
  assert.deepEqual(await readManifest(v), EMPTY_MANIFEST);
  await fs.writeFile(path.join(v.root, '.sb/manifest.json'), JSON.stringify({ version: 99, entries: {} }), 'utf8');
  assert.deepEqual(await readManifest(v), EMPTY_MANIFEST);
});

test('쓰는 도중 죽어도 반쪽짜리 파일이 안 남는다', async () => {
  const v = await vault();
  const big: Manifest = { version: 1, entries: {} };
  for (let i = 0; i < 200; i++) {
    const s = src(`f${i}`, `내용 ${i}`);
    big.entries[s.contentHash] = { ...s, proposedAt: NOW, provider: 'claude-code' };
  }
  await writeManifest(v, big);
  assert.deepEqual(await readManifest(v), big);
  const left = (await fs.readdir(path.join(v.root, '.sb'))).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(left, [], '임시 파일이 남았습니다');
});
