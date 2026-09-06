import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVault, openVault, isVault, appendLog, setHub, VAULT_DIRS, PERSONAL_ID } from '../src/core/vault.ts';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sb-'));

test('Vault 를 만들면 구조가 전부 생긴다', async () => {
  const root = await tmp();
  const v = await createVault(root, { id: 'personal', title: '개인 금고', hub: null });
  for (const dir of VAULT_DIRS) {
    assert.ok((await fs.stat(path.join(root, dir))).isDirectory(), `${dir} 없음`);
  }
  for (const f of ['schema/AGENTS.md', 'schema/taxonomy.md', 'index.md', 'log.md', '.sbignore', '.sb/config.json']) {
    assert.ok((await fs.stat(path.join(root, f))).isFile(), `${f} 없음`);
  }
  assert.equal(v.config.id, 'personal');
  assert.ok(v.config.createdAt);
});

test('같은 곳에 두 번 만들 수 없다', async () => {
  const root = await tmp();
  await createVault(root, { id: 'a', title: 'A', hub: null });
  await assert.rejects(() => createVault(root, { id: 'a', title: 'A', hub: null }), /이미 Vault/);
});

test('Vault 가 아닌 곳을 열면 던진다', async () => {
  const root = await tmp();
  await assert.rejects(() => openVault(root), /Vault 가 아닙니다/);
  assert.equal(await isVault(root), false);
});

test('열면 설정이 그대로 돌아온다', async () => {
  const root = await tmp();
  await createVault(root, { id: 'ACME', title: 'ACME 프로젝트', hub: 'http://10.20.30.40:7777' });
  const v = await openVault(root);
  assert.equal(v.config.title, 'ACME 프로젝트');
  assert.equal(v.config.hub, 'http://10.20.30.40:7777');
});

test('AGENTS.md 에 위키 규약이 들어 있다', async () => {
  const root = await tmp();
  await createVault(root, { id: 'p', title: 'P', hub: null });
  const md = await fs.readFile(path.join(root, 'schema/AGENTS.md'), 'utf8');
  assert.ok(md.includes('EXTRACTED'), '신뢰도 3분류');
  assert.ok(md.includes('slide-12'), '앵커 인용 형식');
  assert.ok(md.includes('이모지 금지'), '한국어 작문 규칙');
});

test('log.md 는 grep 가능한 접두사 형식이다', async () => {
  const root = await tmp();
  const v = await createVault(root, { id: 'p', title: 'P', hub: null });
  await appendLog(v, 'ingest', '킥오프 발표.pptx');
  await appendLog(v, 'lint', '모순 2건');
  const log = await fs.readFile(path.join(root, 'log.md'), 'utf8');
  const entries = log.split('\n').filter((l) => /^## \[\d{4}-\d{2}-\d{2}\] /.test(l));
  assert.equal(entries.length, 2);
  assert.ok(entries[0]!.includes('ingest'));
});

test('허브 주소는 설정에 남고 개인 금고는 거절한다', async () => {
  const root = await tmp();
  const v = await createVault(root, { id: 'ACME', title: 'ACME', hub: null });
  const withHub = await setHub(v, 'http://co-hub:8080');
  assert.equal(withHub.config.hub, 'http://co-hub:8080');
  assert.equal((await openVault(root)).config.hub, 'http://co-hub:8080', '디스크에 남는다');
  assert.equal((await setHub(withHub, null)).config.hub, null);

  const personal = await createVault(await tmp(), { id: PERSONAL_ID, title: '개인 금고', hub: null });
  await assert.rejects(() => setHub(personal, 'http://co-hub:8080'), /개인 금고/);
});
