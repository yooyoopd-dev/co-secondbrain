import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pathMod from 'node:path';
import { diffLines, diffStat, MAX_LINES } from '../src/core/diff.ts';
import { buildReview, canApply, selectOps, GLOBAL_PATH } from '../src/core/review.ts';
import { applyChangeSet, type ChangeSet } from '../src/core/changeset.ts';
import { pageHash, serializePage } from '../src/core/page.ts';
import { createVault } from '../src/core/vault.ts';

const vault = async () => createVault(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-rv-')), { id: 'p', title: 'P', hub: null });

const ANCHORS = new Map<string, ReadonlySet<string>>([['src-kickoff', new Set(['slide-3', 'slide-12'])]]);

function md(title: string, claims: { text: string; source: string | null; confidence: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' }[], body: string) {
  return serializePage({
    front: {
      id: `ent-${title}`, type: 'entity', title, summary: '요약.', aliases: [], tags: [],
      classification: 'internal', docGenre: null,
      claims, openQuestions: [], derivedFrom: null, generatedBy: 'claude-code',
      updated: '2026-09-05T00:00:00.000Z', updatedBy: 'app',
    },
    body: `\n# ${title}\n\n${body}\n`,
  });
}

const OK_PAGE = md('에이콤', [{ text: '주 협력사다.', source: 'src-kickoff#slide-3', confidence: 'EXTRACTED' }], '주 협력사다.[^src-kickoff#slide-3]');

/* ---------------- diff ---------------- */

test('diff — 같은 내용은 전부 same 이고 통계가 0 이다', () => {
  const d = diffLines('가\n나\n다\n', '가\n나\n다\n');
  assert.deepEqual(d.map((l) => l.kind), ['same', 'same', 'same']);
  assert.deepEqual(diffStat(d), { added: 0, deleted: 0 });
});

test('diff — 새 페이지는 전부 add 다', () => {
  const d = diffLines('', '가\n나\n');
  assert.deepEqual(d, [{ kind: 'add', text: '가' }, { kind: 'add', text: '나' }]);
});

test('diff — 삭제는 전부 del 이고 빈 문자열끼리는 아무것도 없다', () => {
  assert.deepEqual(diffLines('가\n', '').map((l) => l.kind), ['del']);
  assert.deepEqual(diffLines('', ''), []);
});

test('diff — 가운데 한 줄만 바뀌면 나머지는 same 으로 남는다', () => {
  const d = diffLines('가\n나\n다\n', '가\n라\n다\n');
  assert.deepEqual(d, [
    { kind: 'same', text: '가' },
    { kind: 'del', text: '나' },
    { kind: 'add', text: '라' },
    { kind: 'same', text: '다' },
  ]);
});

test('diff — 한 줄 삽입은 삽입 하나로 잡힌다 (LCS 가 도는지)', () => {
  const d = diffLines('가\n다\n', '가\n나\n다\n');
  assert.deepEqual(diffStat(d), { added: 1, deleted: 0 });
  assert.deepEqual(d.map((l) => l.text), ['가', '나', '다']);
});

test('diff — 끝 줄바꿈 하나는 줄로 세지 않는다. 안 그러면 모든 diff 에 빈 줄이 붙는다', () => {
  assert.deepEqual(diffLines('가\n', '가'), [{ kind: 'same', text: '가' }]);
  assert.equal(diffLines('가\n\n', '가\n').length, 2); // 진짜 빈 줄은 남는다
});

test('diff — 너무 길면 LCS 를 포기하고 전면 교체로 보여준다', () => {
  const big = Array.from({ length: MAX_LINES + 1 }, (_, i) => `줄${i}`).join('\n');
  const d = diffLines(big, big);
  assert.equal(d.filter((l) => l.kind === 'same').length, 0);
  assert.deepEqual(diffStat(d), { added: MAX_LINES + 1, deleted: MAX_LINES + 1 });
});

/* ---------------- buildReview ---------------- */

test('검토 — 새 페이지는 before 가 null 이고 전부 추가로 보인다', async () => {
  const v = await vault();
  const cs: ChangeSet = { summary: '에이콤 생성', ops: [{ op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null, content: OK_PAGE }] };
  const r = await buildReview(v, cs, ANCHORS);
  const o = r.ops[0]!;
  assert.equal(o.before, null);
  assert.equal(o.title, '에이콤');
  assert.equal(o.deleted, 0);
  assert.ok(o.added > 0);
  assert.deepEqual(o.violations, []);
  assert.equal(o.conflict, null);
  assert.equal(r.discussion, null);
});

test('검토 — 인용이 원본에 없으면 칩에 표시할 ok=false 가 붙는다', async () => {
  const v = await vault();
  const page = md('에이콤', [{ text: '주장.', source: 'src-kickoff#slide-99', confidence: 'EXTRACTED' }], '주장.[^src-kickoff#slide-99]');
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null, content: page }] };
  const r = await buildReview(v, cs, ANCHORS);
  assert.deepEqual(r.ops[0]!.citations, [{ sourceId: 'src-kickoff', locator: 'slide-99', ok: false }]);
  assert.ok(r.ops[0]!.violations.some((x) => x.gate === 5));
});

test('검토 — 본문과 주장에 같은 인용이 있어도 칩은 하나다', async () => {
  const v = await vault();
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null, content: OK_PAGE }] };
  const r = await buildReview(v, cs, ANCHORS);
  assert.deepEqual(r.ops[0]!.citations, [{ sourceId: 'src-kickoff', locator: 'slide-3', ok: true }]);
});

test('검토 — 신뢰도를 배지로 띄우게 주장을 그대로 넘긴다', async () => {
  const v = await vault();
  const page = md('에이콤', [
    { text: '명시.', source: 'src-kickoff#slide-3', confidence: 'EXTRACTED' },
    { text: '불확실.', source: null, confidence: 'AMBIGUOUS' },
  ], '명시.[^src-kickoff#slide-3]');
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null, content: page }] };
  const r = await buildReview(v, cs, ANCHORS);
  assert.deepEqual(r.ops[0]!.claims.map((c) => c.confidence), ['EXTRACTED', 'AMBIGUOUS']);
});

test('검토 — 파싱이 안 되는 제안도 카드로 보여준다. 위반과 함께', async () => {
  const v = await vault();
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null, content: '앞머리가 없다' }] };
  const r = await buildReview(v, cs, ANCHORS);
  assert.equal(r.ops[0]!.title, 'acme'); // 경로에서 만든 제목
  assert.ok(r.ops[0]!.violations.length > 0);
});

test('검토 — ChangeSet 전체 수준 위반은 카드가 아니라 따로 모인다', async () => {
  const v = await vault();
  const r = await buildReview(v, { summary: '', ops: [{ op: 'create', path: '02_NOTES/entities/a.md', baseHash: null, content: OK_PAGE }] }, ANCHORS);
  assert.ok(r.globalViolations.some((x) => x.path === GLOBAL_PATH));
  assert.deepEqual(r.ops[0]!.violations, []);
});

/* ---------------- 관문 7 미리보기 ---------------- */

test('검토 — 이미 있는 페이지를 create 하면 승인 전에 충돌을 알려준다', async () => {
  const v = await vault();
  await fs.writeFile(path.join(v.root, '02_NOTES/entities/acme.md'), OK_PAGE, 'utf8');
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null, content: OK_PAGE }] };
  const r = await buildReview(v, cs, ANCHORS);
  assert.match(r.ops[0]!.conflict ?? '', /이미 있는/);
  assert.equal(canApply(r, ['02_NOTES/entities/acme.md']), false);
});

test('검토 — 제안이 만들어진 뒤 페이지가 바뀌면 충돌로 잡는다', async () => {
  const v = await vault();
  const p = '02_NOTES/entities/acme.md';
  await fs.writeFile(path.join(v.root, p), OK_PAGE, 'utf8');
  const stale = pageHash('다른 내용');
  const r = await buildReview(v, { summary: 's', ops: [{ op: 'update', path: p, baseHash: stale, content: OK_PAGE }] }, ANCHORS);
  assert.match(r.ops[0]!.conflict ?? '', /바뀌었습니다/);
});

test('검토 — baseHash 가 맞으면 update 는 충돌이 없다', async () => {
  const v = await vault();
  const p = '02_NOTES/entities/acme.md';
  await fs.writeFile(path.join(v.root, p), OK_PAGE, 'utf8');
  const next = md('에이콤', [{ text: '주 협력사다.', source: 'src-kickoff#slide-3', confidence: 'EXTRACTED' }], '주 협력사다.[^src-kickoff#slide-3]\n\n갱신됨.');
  const r = await buildReview(v, { summary: 's', ops: [{ op: 'update', path: p, baseHash: pageHash(OK_PAGE), content: next }] }, ANCHORS);
  assert.equal(r.ops[0]!.conflict, null);
  assert.equal(canApply(r, [p]), true);
});

/* ---------------- 부분 승인 ---------------- */

test('승인 — 거부한 op 의 위반은 승인을 막지 않는다', async () => {
  const v = await vault();
  const good = { op: 'create' as const, path: '02_NOTES/entities/a.md', baseHash: null, content: OK_PAGE };
  const bad = { op: 'create' as const, path: '02_NOTES/entities/b.md', baseHash: null, content: '깨진 페이지' };
  const r = await buildReview(v, { summary: 's', ops: [good, bad] }, ANCHORS);
  assert.equal(canApply(r, [good.path, bad.path]), false);
  assert.equal(canApply(r, [good.path]), true);
});

test('승인 — 전부 거부하면 승인할 것이 없다', async () => {
  const v = await vault();
  const r = await buildReview(v, { summary: 's', ops: [{ op: 'create', path: '02_NOTES/entities/a.md', baseHash: null, content: OK_PAGE }] }, ANCHORS);
  assert.equal(canApply(r, []), false);
});

test('승인 — 전체 수준 위반이 있으면 어느 것도 승인할 수 없다', async () => {
  const v = await vault();
  const r = await buildReview(v, { summary: '', ops: [{ op: 'create', path: '02_NOTES/entities/a.md', baseHash: null, content: OK_PAGE }] }, ANCHORS);
  assert.equal(canApply(r, ['02_NOTES/entities/a.md']), false);
});

test('선택 — 승인한 op 만 남기고 summary·discussion 은 지킨다', () => {
  const cs: ChangeSet = {
    summary: 's', discussion: '물어볼 것',
    ops: [
      { op: 'create', path: '02_NOTES/entities/a.md', baseHash: null, content: 'x' },
      { op: 'create', path: '02_NOTES/entities/b.md', baseHash: null, content: 'y' },
    ],
  };
  const picked = selectOps(cs, ['02_NOTES/entities/b.md']);
  assert.deepEqual(picked.ops.map((o) => o.path), ['02_NOTES/entities/b.md']);
  assert.equal(picked.summary, 's');
  assert.equal(picked.discussion, '물어볼 것');
  assert.equal(cs.ops.length, 2); // 원본을 건드리지 않는다
});

/* ---------------- 관문 8 — 승인 전에는 디스크가 안 바뀐다 ---------------- */

test('검토만 해서는 디스크가 바뀌지 않는다 — 관문 8 의 존재 이유', async () => {
  const v = await vault();
  const before = (await fs.readdir(path.join(v.root, '02_NOTES/entities'))).length;
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'create', path: '02_NOTES/entities/acme.md', baseHash: null, content: OK_PAGE }] };
  await buildReview(v, cs, ANCHORS);
  await buildReview(v, cs, ANCHORS);
  assert.equal((await fs.readdir(path.join(v.root, '02_NOTES/entities'))).length, before);
});

test('거부한 op 은 승인해도 디스크에 안 쓰인다', async () => {
  const v = await vault();
  const a = { op: 'create' as const, path: '02_NOTES/entities/a.md', baseHash: null, content: OK_PAGE };
  const b = { op: 'create' as const, path: '02_NOTES/entities/b.md', baseHash: null, content: OK_PAGE };
  const cs: ChangeSet = { summary: 's', ops: [a, b] };
  const r = await buildReview(v, cs, ANCHORS);
  assert.equal(canApply(r, [a.path]), true);
  const res = await applyChangeSet(v, selectOps(cs, [a.path]), ANCHORS);
  assert.deepEqual(res.applied, [a.path]);
  assert.deepEqual((await fs.readdir(path.join(v.root, '02_NOTES/entities'))).sort(), ['a.md']);
});

/* ---------------- 두 열 짝짓기 ---------------- */

import { sideBySide } from '../src/core/diff.ts';

test('두 열 — 같은 줄은 양쪽에 놓는다', () => {
  assert.deepEqual(sideBySide(diffLines('가\n', '가\n')), [{ left: { kind: 'same', text: '가' }, right: { kind: 'same', text: '가' } }]);
});

test('두 열 — 한 줄 수정은 같은 행에서 마주 본다', () => {
  const rows = sideBySide(diffLines('가\n나\n다\n', '가\n라\n다\n'));
  assert.equal(rows.length, 3);
  assert.equal(rows[1]!.left!.text, '나');
  assert.equal(rows[1]!.right!.text, '라');
});

test('두 열 — 삭제가 더 많으면 남는 쪽은 빈칸이다', () => {
  const rows = sideBySide(diffLines('가\n나\n다\n', '라\n'));
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [['가', '라'], ['나', null], ['다', null]]);
});

test('두 열 — 새 페이지는 왼쪽이 전부 빈칸이다', () => {
  const rows = sideBySide(diffLines('', '가\n나\n'));
  assert.deepEqual(rows.map((r) => r.left), [null, null]);
  assert.deepEqual(rows.map((r) => r.right?.text), ['가', '나']);
});

test('두 열 — 행 수가 원래 diff 의 정보를 잃지 않는다', () => {
  const d = diffLines('가\n나\n다\n라\n', '가\n다\n마\n바\n');
  const rows = sideBySide(d);
  assert.equal(rows.flatMap((r) => [r.left, r.right]).filter((l) => l?.kind === 'del').length, d.filter((l) => l.kind === 'del').length);
  assert.equal(rows.flatMap((r) => [r.left, r.right]).filter((l) => l?.kind === 'add').length, d.filter((l) => l.kind === 'add').length);
});

/* ---------------- 렌더러 안전성 ---------------- */

test('렌더러가 끌고 오는 모듈에 Node 모듈이 없다', async () => {
  // 두 번 어겼다 — review.ts 로 node:crypto 가, spend.ts 로 node:fs 가 번들에 들어왔다.
  // 그래서 목록을 손으로 적지 않고 렌더러에서 시작해 실제 임포트를 따라간다.
  const rendererDir = new URL('../src/renderer/', import.meta.url);
  const seen = new Set<string>();
  const offenders: string[] = [];

  const valueImports = (src: string) =>
    [...src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);

  const walk = async (fileUrl: URL): Promise<void> => {
    if (seen.has(fileUrl.href)) return;
    seen.add(fileUrl.href);
    const src = await fs.readFile(fileUrl, 'utf8');
    for (const spec of valueImports(src)) {
      if (spec.startsWith('node:')) offenders.push(`${fileUrl.pathname.split('/').pop()} → ${spec}`);
      else if (spec.startsWith('.')) await walk(new URL(spec, fileUrl));
    }
  };

  for (const name of await fs.readdir(rendererDir)) {
    if (name.endsWith('.tsx') || name.endsWith('.ts')) await walk(new URL(name, rendererDir));
  }
  assert.ok(seen.size > 3, `렌더러 파일을 못 찾았습니다: ${seen.size}`);
  assert.deepEqual(offenders, []);
});

/* ---------------- 편집 후 승인 (ROADMAP 14번) ---------------- */

import { editOp } from '../src/core/approve.ts';

const twoOps = (): ChangeSet => ({
  summary: 's',
  discussion: '물어볼 것',
  ops: [
    { op: 'create', path: '02_NOTES/entities/a.md', baseHash: null, content: OK_PAGE },
    { op: 'create', path: '02_NOTES/entities/b.md', baseHash: null, content: OK_PAGE },
  ],
});

test('편집 — 지정한 op 만 바뀌고 나머지는 그대로다', () => {
  const cs = twoOps();
  const out = editOp(cs, '02_NOTES/entities/b.md', '고친 내용');
  assert.equal(out.ops[0]!.content, OK_PAGE);
  assert.equal(out.ops[1]!.content, '고친 내용');
  assert.equal(out.summary, 's');
  assert.equal(out.discussion, '물어볼 것');
});

test('편집 — 원본 ChangeSet 을 건드리지 않는다', () => {
  const cs = twoOps();
  editOp(cs, '02_NOTES/entities/a.md', '고친 내용');
  assert.equal(cs.ops[0]!.content, OK_PAGE);
});

test('편집 — 없는 경로면 아무것도 안 바뀐다', () => {
  const cs = twoOps();
  assert.deepEqual(editOp(cs, '02_NOTES/entities/없음.md', 'x'), cs);
});

test('편집 — delete 는 내용이 없으므로 그대로 둔다', () => {
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'delete', path: '02_NOTES/entities/a.md', baseHash: 'h' }] };
  assert.deepEqual(editOp(cs, '02_NOTES/entities/a.md', 'x'), cs);
});

test('편집한 내용도 관문을 다시 통과해야 한다 — 편집이 관문 8 을 건너뛰는 문이 되면 안 된다', async () => {
  const v = await vault();
  const path = '02_NOTES/entities/a.md';
  const cs: ChangeSet = { summary: 's', ops: [{ op: 'create', path, baseHash: null, content: OK_PAGE }] };
  assert.equal(canApply(await buildReview(v, cs, ANCHORS), [path]), true);

  // 앞머리를 깨면 관문 1 이 잡는다
  const broken = await buildReview(v, editOp(cs, path, '# 제목만 있다'), ANCHORS);
  assert.ok(broken.ops[0]!.violations.length > 0);
  assert.equal(canApply(broken, [path]), false);

  // 없는 앵커를 넣으면 관문 5 가 잡는다
  const fake = await buildReview(v, editOp(cs, path, OK_PAGE.replace('slide-3', 'slide-99')), ANCHORS);
  assert.ok(fake.ops[0]!.violations.some((x) => x.gate === 5));
  assert.equal(canApply(fake, [path]), false);
});

test('편집으로 위반을 고치면 다시 승인할 수 있다', async () => {
  const v = await vault();
  const path = '02_NOTES/entities/a.md';
  const bad: ChangeSet = { summary: 's', ops: [{ op: 'create', path, baseHash: null, content: '깨진 페이지' }] };
  assert.equal(canApply(await buildReview(v, bad, ANCHORS), [path]), false);
  assert.equal(canApply(await buildReview(v, editOp(bad, path, OK_PAGE), ANCHORS), [path]), true);
});

test('편집한 내용이 승인 시 그대로 디스크에 간다', async () => {
  const v = await vault();
  const path = '02_NOTES/entities/a.md';
  const edited = OK_PAGE.replace('주 협력사다.', '사람이 고쳐 쓴 문장이다.');
  const cs = editOp({ summary: 's', ops: [{ op: 'create', path, baseHash: null, content: OK_PAGE }] }, path, edited);
  const res = await applyChangeSet(v, cs, ANCHORS);
  assert.deepEqual(res.applied, [path]);
  assert.equal(await fs.readFile(pathMod.join(v.root, path), 'utf8'), edited);
});
