import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVault } from '../src/core/vault.ts';
import { applyChangeSet, validateShape, validateAnchors, currentHash, type ChangeSet } from '../src/core/changeset.ts';
import { snapshot, restore, listSnapshots } from '../src/core/history.ts';
import { pageHash, parsePage, serializePage, emptyPage } from '../src/core/page.ts';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sb-cs-'));
const vault = async () => createVault(await tmp(), { id: 'p', title: 'P', hub: null });

const KNOWN = new Map([['src-kickoff', new Set(['slide-12', 'slide-2'])]]);

const goodPage = (id = 'ent-acme', title = '에이콤') => serializePage({
  front: {
    id, type: 'entity', title,
    summary: '킥오프의 주 협력사.',
    aliases: [], tags: [], openQuestions: [],
    claims: [{ text: '주 협력사로 확정됨', source: 'src-kickoff#slide-12', confidence: 'EXTRACTED' }],
    classification: 'internal', docGenre: null,
    derivedFrom: null, generatedBy: 'claude-code/2.1.260',
    updated: '2026-09-04T00:00:00.000Z', updatedBy: 'hong@corp',
  },
  body: '\n# 에이콤\n\n주 협력사로 확정됐다. [^src-kickoff#slide-12]\n',
});

const cs = (ops: ChangeSet['ops']): ChangeSet => ({ summary: '테스트', ops });

/* ---------- 관문 2: path 정규식 ---------- */
test('관문2 — M0에서 모델이 실제로 낸 잘못된 경로를 막는다', () => {
  // 실측: 모델이 wiki/ 접두사를 무시하고 괄호가 든 파일명을 냈다
  const v = validateShape(cs([{ op: 'create', path: 'entities/에이콤(주).md', baseHash: null, content: goodPage() }]));
  assert.ok(v.some((x) => x.gate === 2), JSON.stringify(v));
});

test('관문2 — 다른 디렉터리로 쓰려는 시도를 막는다', () => {
  for (const p of ['schema/AGENTS.md', 'sources/x.md', '../outside.md', 'wiki/../../etc/passwd.md']) {
    const v = validateShape(cs([{ op: 'create', path: p, baseHash: null, content: goodPage() }]));
    assert.ok(v.some((x) => x.gate === 2), `${p} 가 통과했다`);
  }
});

test('관문2 — 정상 경로 4종은 통과한다', () => {
  for (const d of ['sources', 'entities', 'concepts', 'synthesis']) {
    const v = validateShape(cs([{ op: 'create', path: `wiki/${d}/acme-corp.md`, baseHash: null, content: goodPage() }]));
    assert.deepEqual(v, [], `wiki/${d}/ 가 막혔다`);
  }
});

/* ---------- 관문 3: 파일명 안전성 ---------- */
test('관문3 — 소문자 Windows 예약어를 막는다', () => {
  // 대문자 CON 은 경로 정규식(관문2)이 먼저 잡는다. 모델이 낼 법한 것은 소문자 슬러그다.
  const v = validateShape(cs([{ op: 'create', path: 'wiki/entities/con.md', baseHash: null, content: goodPage() }]));
  assert.ok(v.some((x) => x.gate === 3), `소문자 예약어가 통과했다: ${JSON.stringify(v)}`);

  for (const name of ['aux', 'nul', 'com1', 'lpt9']) {
    const r = validateShape(cs([{ op: 'create', path: `wiki/entities/${name}.md`, baseHash: null, content: goodPage() }]));
    assert.ok(r.some((x) => x.gate === 3), `${name} 이 통과했다`);
  }
  // 어느 관문이든 막히기만 하면 된다
  assert.ok(validateShape(cs([{ op: 'create', path: 'wiki/entities/CON.md', baseHash: null, content: goodPage() }])).length > 0);
});

/* ---------- 관문 4: 출처 ---------- */
test('관문4 — 출처 없는 주장을 막는다', () => {
  const p = serializePage({
    ...parsePage(goodPage()),
    front: { ...parsePage(goodPage()).front, claims: [{ text: '근거 없는 말', source: null, confidence: 'EXTRACTED' }] },
  });
  const v = validateShape(cs([{ op: 'create', path: 'wiki/entities/x.md', baseHash: null, content: p }]));
  assert.ok(v.some((x) => x.gate === 4), JSON.stringify(v));
});

test('관문4 — AMBIGUOUS 는 출처를 요구하지 않는다', () => {
  const base = parsePage(goodPage());
  const p = serializePage({ ...base, front: { ...base.front, claims: [{ text: '확실치 않음', source: null, confidence: 'AMBIGUOUS' }] } });
  assert.deepEqual(validateShape(cs([{ op: 'create', path: 'wiki/entities/x.md', baseHash: null, content: p }])), []);
});

test('INFERRED 점수는 다섯 개 중 하나여야 한다', () => {
  const base = parsePage(goodPage());
  const mk = (score: number) => serializePage({
    ...base,
    front: { ...base.front, claims: [{ text: 't', source: 'src-kickoff#slide-12', confidence: 'INFERRED', score: score as never }] },
  });
  assert.deepEqual(validateShape(cs([{ op: 'create', path: 'wiki/entities/x.md', baseHash: null, content: mk(0.75) }])), []);
  const bad = validateShape(cs([{ op: 'create', path: 'wiki/entities/x.md', baseHash: null, content: mk(0.7) }]));
  assert.ok(bad.length > 0, '0.7 이 통과했다 — 루브릭 밖의 값');
});

/* ---------- 관문 5: 앵커 실재 ---------- */
test('관문5 — 없는 앵커 인용을 막는다 (환각 방어)', () => {
  const base = parsePage(goodPage());
  const p = serializePage({
    ...base,
    front: { ...base.front, claims: [{ text: 't', source: 'src-kickoff#slide-99', confidence: 'EXTRACTED' }] },
    body: '\n본문 [^src-kickoff#slide-99]\n',
  });
  const v = validateAnchors(cs([{ op: 'create', path: 'wiki/entities/x.md', baseHash: null, content: p }]), KNOWN);
  assert.ok(v.some((x) => x.gate === 5 && x.reason.includes('slide-99')), JSON.stringify(v));
});

test('관문5 — 없는 원본 인용을 막는다', () => {
  const base = parsePage(goodPage());
  const p = serializePage({ ...base, body: '\n[^src-지어낸것#page-1]\n' });
  const v = validateAnchors(cs([{ op: 'create', path: 'wiki/entities/x.md', baseHash: null, content: p }]), KNOWN);
  assert.ok(v.some((x) => x.gate === 5), JSON.stringify(v));
});

/* ---------- 관문 7: 낙관적 동시성 ---------- */
test('관문7 — baseHash 가 어긋나면 적용하지 않는다', async () => {
  const v = await vault();
  await applyChangeSet(v, cs([{ op: 'create', path: 'wiki/entities/a.md', baseHash: null, content: goodPage() }]), KNOWN);

  // 다른 사람이 먼저 고친 상황
  await fs.writeFile(path.join(v.root, 'wiki/entities/a.md'), goodPage('ent-acme', '다른 사람이 고침'), 'utf8');

  const r = await applyChangeSet(
    v,
    cs([{ op: 'update', path: 'wiki/entities/a.md', baseHash: pageHash(goodPage()), content: goodPage('ent-acme', '내 수정') }]),
    KNOWN,
  );
  assert.equal(r.applied.length, 0);
  assert.equal(r.conflicts.length, 1);
  const kept = await fs.readFile(path.join(v.root, 'wiki/entities/a.md'), 'utf8');
  assert.ok(kept.includes('다른 사람이 고침'), '조용히 덮어썼다');
});

test('관문7 — 이미 있는 파일에 create 하면 충돌', async () => {
  const v = await vault();
  const op = { op: 'create' as const, path: 'wiki/entities/a.md', baseHash: null, content: goodPage() };
  await applyChangeSet(v, cs([op]), KNOWN);
  const r = await applyChangeSet(v, cs([op]), KNOWN);
  assert.equal(r.conflicts.length, 1);
});

/* ---------- 전부 아니면 아무것도 ---------- */
test('하나라도 막히면 아무것도 적용하지 않는다', async () => {
  const v = await vault();
  const r = await applyChangeSet(v, cs([
    { op: 'create', path: 'wiki/entities/ok.md', baseHash: null, content: goodPage() },
    { op: 'create', path: 'entities/나쁨.md', baseHash: null, content: goodPage() }, // 관문2 위반
  ]), KNOWN);
  assert.equal(r.applied.length, 0);
  assert.ok(r.violations.length > 0);
  await assert.rejects(() => fs.access(path.join(v.root, 'wiki/entities/ok.md')), '부분 적용됐다');
});

test('정상 ChangeSet 은 적용되고 되읽힌다', async () => {
  const v = await vault();
  const r = await applyChangeSet(v, cs([{ op: 'create', path: 'wiki/entities/acme.md', baseHash: null, content: goodPage() }]), KNOWN);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.applied, ['wiki/entities/acme.md']);

  const page = parsePage(await fs.readFile(path.join(v.root, 'wiki/entities/acme.md'), 'utf8'));
  assert.equal(page.front.title, '에이콤');
  assert.equal(page.front.claims[0]?.confidence, 'EXTRACTED');
  assert.equal(page.front.generatedBy, 'claude-code/2.1.260');
  assert.equal(await currentHash(v, 'wiki/entities/acme.md'), pageHash(goodPage()));
});

/* ---------- 스냅샷 · 되돌리기 ---------- */
test('적용 전 스냅샷으로 되돌릴 수 있다', async () => {
  const v = await vault();
  const p = 'wiki/entities/acme.md';
  await applyChangeSet(v, cs([{ op: 'create', path: p, baseHash: null, content: goodPage() }]), KNOWN,
    (paths) => snapshot(v, paths, '1차').then(() => undefined));

  // 두 번째 적용 — 스냅샷을 남긴다
  const before = await fs.readFile(path.join(v.root, p), 'utf8');
  await applyChangeSet(v, cs([{ op: 'update', path: p, baseHash: pageHash(before), content: goodPage('ent-acme', '바뀐 제목') }]), KNOWN,
    (paths) => snapshot(v, paths, '2차').then(() => undefined));
  assert.ok((await fs.readFile(path.join(v.root, p), 'utf8')).includes('바뀐 제목'));

  const snaps = await listSnapshots(v);
  assert.equal(snaps.length, 2);
  await restore(v, snaps[0]!.id);   // 2차 적용 직전으로
  assert.ok((await fs.readFile(path.join(v.root, p), 'utf8')).includes('에이콤'), '되돌아가지 않았다');
});

test('없던 파일을 만든 뒤 되돌리면 삭제된다', async () => {
  const v = await vault();
  const p = 'wiki/entities/new.md';
  const snap = await snapshot(v, [p], '생성 전');
  await applyChangeSet(v, cs([{ op: 'create', path: p, baseHash: null, content: goodPage() }]), KNOWN);
  await fs.access(path.join(v.root, p));
  await restore(v, snap.id);
  await assert.rejects(() => fs.access(path.join(v.root, p)), '삭제되지 않았다');
});

test('같은 내용은 blob 을 한 번만 저장한다', async () => {
  const v = await vault();
  await fs.writeFile(path.join(v.root, 'wiki/entities/a.md'), goodPage(), 'utf8');
  await fs.writeFile(path.join(v.root, 'wiki/entities/b.md'), goodPage(), 'utf8');
  await snapshot(v, ['wiki/entities/a.md', 'wiki/entities/b.md'], '동일 내용');
  const blobs = await fs.readdir(path.join(v.root, '.sb/history/blobs'));
  assert.equal(blobs.length, 1, `콘텐츠 주소가 아니다: ${blobs.length}개`);
});
