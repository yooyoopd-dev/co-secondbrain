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
  await s.open(root, { id: 'personal', title: '개인 금고' });
  return { s, root };
}

test('Vault 를 만들고 원본을 인제스트한다', async () => {
  const { s, root } = await opened();
  const r = await s.ingest([f('kickoff.docx'), f('cost.xlsx'), f('kickoff.pptx'), f('meeting.vtt')]);
  assert.deepEqual(r.failed, [], `실패: ${JSON.stringify(r.failed)}`);
  assert.equal(r.ok.length, 4);
  assert.ok(r.relations > 0, '구조 관계가 하나도 없다');

  // 원본이 Vault 에 복사됐는가 (원본은 이후 절대 수정하지 않는다)
  assert.ok((await fs.stat(path.join(root, 'sources/kickoff.docx'))).isFile());
  // 추출 결과가 디스크에 남는가 (디스크가 진실이다)
  assert.ok((await fs.stat(path.join(root, 'extracted/src-kickoff.json'))).isFile());
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
    await fs.readFile(path.join(root, 'extracted/__threads__.relations.json'), 'utf8'),
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

  // 색인 파일을 지워도 extracted/ 에서 복구돼야 한다
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
