import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.ts';

const FIX = path.resolve(import.meta.dirname, '../../spikes/fixtures/files');
const f = (n: string) => path.join(FIX, n);
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sb-store-'));

async function opened() {
  const root = await tmp();
  const s = new Store();
  await s.open(root, { id: 'personal', title: '개인 Vault' });
  return { s, root };
}

test('Vault 를 만들고 원본을 인제스트한다', async () => {
  const { s, root } = await opened();
  const r = await s.ingest([f('kickoff.docx'), f('cost.xlsx'), f('kickoff.pptx'), f('meeting.vtt')]);
  assert.deepEqual(r.failed, [], `실패: ${JSON.stringify(r.failed)}`);
  assert.equal(r.ok.length, 4);
  assert.ok(r.relations > 0, '구조 관계가 하나도 없다');

  // 원본이 Vault 에 복사됐는가 (원본은 이후 절대 수정하지 않는다)
  assert.ok((await fs.stat(path.join(root, '01_SOURCES/kickoff.docx'))).isFile());
  // 추출 결과가 디스크에 남는가 (디스크가 진실이다)
  assert.ok((await fs.stat(path.join(root, '.sb/extracted/src-kickoff.json'))).isFile());
  s.close();
});

test('스캔본은 경고로 보고하고 실패시키지 않는다', async () => {
  const { s } = await opened();
  const r = await s.ingest([f('scanned.pdf')]);
  assert.deepEqual(r.failed, []);
  assert.ok(r.warnings.some((w) => w.warning.includes('스캔본')), JSON.stringify(r.warnings));
  s.close();
});

test('지원하지 않는 파일은 실패로 보고하고 나머지는 계속한다', async () => {
  const { s, root } = await opened();
  await fs.writeFile(path.join(root, 'x.zip'), 'dummy');
  const r = await s.ingest([path.join(root, 'x.zip'), f('meeting.vtt')]);
  assert.equal(r.ok.length, 1, '정상 파일이 처리되지 않았다');
  assert.equal(r.failed.length, 1);
  assert.ok(r.failed[0]?.reason.includes('지원하지 않는'));
  s.close();
});

test('인제스트한 내용이 한국어로 검색된다', async () => {
  const { s } = await opened();
  await s.ingest([f('kickoff.docx'), f('meeting.vtt')]);
  // 조사가 붙은 어절 — 기본 토크나이저면 못 잡는다
  const hits = s.search('협력사');
  assert.ok(hits.length > 0, '"협력사"가 안 걸린다');
  assert.ok(hits[0]?.locator, '앵커가 없다');
  // 2음절 어절 중간
  assert.ok(s.search('갱신').length > 0 || s.search('계약').length > 0);
  // 1자 질의는 거부
  assert.deepEqual(s.search('이'), []);
  s.close();
});

test('이메일 여러 통을 넣으면 스레드가 복원된다', async () => {
  const { s, root } = await opened();
  const r = await s.ingest([f('mail-3.eml'), f('mail-1.eml'), f('mail-2.eml')]);
  assert.deepEqual(r.failed, []);
  const rels = JSON.parse(
    await fs.readFile(path.join(root, '.sb/extracted/__threads__.relations.json'), 'utf8'),
  ) as { kind: string }[];
  assert.equal(rels.length, 2, `답장 관계 2건이어야 하는데 ${rels.length}건`);
  assert.ok(rels.every((x) => x.kind === 'replies-to'));
  s.close();
});

test('닫았다 다시 열면 색인이 재생성된다 (색인은 캐시다)', async () => {
  const { s, root } = await opened();
  await s.ingest([f('kickoff.docx')]);
  assert.ok(s.search('협력사').length > 0);
  s.close();

  // 색인 파일을 지워도 .sb/extracted/ 에서 복구돼야 한다
  await fs.rm(path.join(root, '.sb/catalog.sqlite'), { force: true });
  const s2 = new Store();
  await s2.open(root);
  assert.ok(s2.search('협력사').length > 0, '재색인 실패');
  assert.equal((await s2.listSources()).length, 1);
  s2.close();
});

test('Vault 없이 부르면 던진다', async () => {
  const s = new Store();
  await assert.rejects(() => s.ingest([f('meeting.vtt')]), /Vault 가 열려 있지 않습니다/);
  assert.deepEqual(s.search('아무거나'), []);
});

test('원본 전문을 앵커째로 되읽을 수 있다 (원문 뷰어용)', async () => {
  const { s } = await opened();
  await s.ingest([f('kickoff.pptx')]);
  const e = await s.readSource('src-kickoff');
  assert.ok(e, '읽지 못했다');
  assert.equal(e.chunks.length, 2);
  assert.equal(e.chunks[0]?.anchor.locator, 'slide-1');
  assert.equal(await s.readSource('src-없는것'), null);
  s.close();
});

/* ---------------- 설정 · 내 맥락 ---------------- */

test('설정은 Vault 경로와 판을 준다. 안 열었으면 null 이다', async () => {
  const s = new Store();
  const before = await s.settings('9.9.9');
  assert.equal(before.version, '9.9.9');
  assert.equal(before.vaultRoot, null);
  assert.equal(before.personal, null);

  const root = await tmp();
  await s.open(root, { id: 'personal', title: '개인 Vault' });
  const after = await s.settings('9.9.9');
  assert.equal(after.vaultRoot, root);
  assert.equal(after.vaultTitle, '개인 Vault');
  assert.equal(after.personal, true);
  assert.deepEqual(after.providers.map((p) => p.id), ['claude-code', 'gemini', 'codex']);
});

test('Vault 를 닫으면 설정에서도 사라진다', async () => {
  const { s } = await opened();
  s.close();
  const st = await s.settings('9.9.9');
  assert.equal(st.vaultRoot, null);
  await assert.rejects(() => s.listSources(), /열려 있지 않습니다/);
});

test('공급자 선택은 파일에 남고 다시 읽힌다', async () => {
  const dir = await tmp();
  const prefsFile = path.join(dir, 'prefs.json');
  const a = new Store({ prefsFile });
  await a.setProvider('gemini');
  assert.equal((await a.settings('0')).provider, 'gemini');

  const b = new Store({ prefsFile });
  await b.loadPrefs();
  assert.equal((await b.settings('0')).provider, 'gemini');

  await b.setProvider(null);
  const c = new Store({ prefsFile });
  await c.loadPrefs();
  assert.equal((await c.settings('0')).provider, null);
});

test('설정 파일이 깨져 있으면 자동으로 돌아간다', async () => {
  const dir = await tmp();
  const prefsFile = path.join(dir, 'prefs.json');
  await fs.writeFile(prefsFile, '{ 이건 JSON 이 아니다', 'utf8');
  const s = new Store({ prefsFile });
  await s.loadPrefs();
  assert.equal((await s.settings('0')).provider, null);
});

test('내 맥락은 안 적었으면 빈 것이고, 적으면 Vault 안 파일이 된다', async () => {
  const { s, root } = await opened();
  assert.deepEqual(await s.coreContext(), { who: '', why: '', output: '' });

  await s.setCoreContext({ who: '구매팀 대리.', why: '', output: '근거 딸린 한 문단.' });
  const md = await fs.readFile(path.join(root, '09_TEMPLATES/me.md'), 'utf8');
  assert.match(md, /구매팀 대리\./);
  assert.deepEqual(await s.coreContext(), { who: '구매팀 대리.', why: '', output: '근거 딸린 한 문단.' });
});

/* ---------- 전체 보류 (검토 화면) ---------- */

/** CLI 를 안 부르고 검토 대기를 만든다. archiveAnswer 가 답변을 그대로 ChangeSet 으로 만든다 */
async function withPending() {
  const { s, root } = await opened();
  await s.ingest([f('kickoff.docx')]);
  const review = await s.archiveAnswer('킥오프 일정은?', {
    answer: '3월 착수로 확정했습니다.',
    claims: [{ text: '3월 착수로 확정', source: 'src-kickoff#2026 ACME 프로젝트' }],
    pages: [],
  });
  return { s, root, review };
}

test('전체 보류하면 파일로 남고 다시 열린다', async () => {
  const { s, root, review } = await withPending();
  const p = review.ops[0]!.op.path;

  await s.holdReview([p]);
  // 보류는 `.sb/` 아래다. 위키에도 동기화 대상에도 안 들어간다.
  assert.ok((await fs.stat(path.join(root, '.sb/held-review.json'))).isFile());
  // 보류했으면 지금 검토 중인 것은 없다
  await assert.rejects(() => s.editOp(p, '아무거나'), /검토 중인 변경안이 없습니다/);

  const info = await s.heldReviewInfo();
  assert.equal(info?.ops, 1);

  const back = await s.resumeReview();
  assert.deepEqual(back?.approved, [p]);
  assert.equal(back?.review.ops.length, 1);
  s.close();
});

test('보류한 것은 적용해도 버려도 사라진다', async () => {
  const { s, root, review } = await withPending();
  const p = review.ops[0]!.op.path;
  const held = path.join(root, '.sb/held-review.json');

  await s.holdReview([p]);
  await s.discardReview();
  assert.equal(await s.heldReviewInfo(), null);
  await assert.rejects(() => fs.stat(held));

  // 적용 쪽도 같다 — 적용했는데 다음에 또 뜨면 안 된다
  const again = await s.archiveAnswer('킥오프 일정은?', {
    answer: '3월 착수로 확정했습니다.',
    claims: [{ text: '3월 착수로 확정', source: 'src-kickoff#2026 ACME 프로젝트' }],
    pages: [],
  });
  await s.holdReview([again.ops[0]!.op.path]);
  await s.resumeReview();
  const res = await s.applyReview([again.ops[0]!.op.path]);
  assert.equal(res.applied.length, 1, JSON.stringify(res));
  await assert.rejects(() => fs.stat(held));
  s.close();
});

test('보류 파일이 깨져 있으면 없는 것으로 본다', async () => {
  const { s, root } = await opened();
  await fs.writeFile(path.join(root, '.sb/held-review.json'), '{ JSON 아님', 'utf8');
  assert.equal(await s.heldReviewInfo(), null);
  assert.equal(await s.resumeReview(), null);
  s.close();
});

test('도는 것이 없으면 취소는 false 다', async () => {
  const { s } = await opened();
  assert.equal(s.cancelAgent(), false);
  s.close();
});

test('작업별 공급자를 미리 알려 준다', async () => {
  const { s } = await opened();
  const t = await s.taskProviders();
  // 설치 여부는 이 기계에 달렸다. 모양만 본다 — 거절이면 사유가 있어야 한다.
  for (const p of [t.query, t.ingest]) {
    assert.ok(p.ok ? p.provider.length > 0 : p.reason.length > 0, JSON.stringify(p));
  }
  s.close();
});
