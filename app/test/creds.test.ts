// 허브 토큰 보관. **평문이 디스크에 닿지 않는다**는 것이 이 파일의 요점이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { credStore, type Cipher } from '../src/main/creds.ts';

/** 진짜 암호화가 아니다. 파일 형식과 잠금 규칙만 검증한다 */
function fakeCipher(available = true): Cipher {
  return {
    available: () => available,
    encrypt: (plain) => Buffer.from([...Buffer.from(plain, 'utf8')].map((b) => b ^ 0x5a)),
    decrypt: (enc) => Buffer.from([...enc].map((b) => b ^ 0x5a)).toString('utf8'),
  };
}

const tmpFile = async () => path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-creds-')), 'hub-creds.json');

test('토큰을 넣고 뺀다', async () => {
  const file = await tmpFile();
  const s = credStore(file, fakeCipher());
  assert.equal(await s.get('ACME'), null);

  await s.set('ACME', 'tok-123');
  assert.equal(await s.get('ACME'), 'tok-123');

  await s.remove('ACME');
  assert.equal(await s.get('ACME'), null);
});

test('평문 토큰은 파일에 없다', async () => {
  const file = await tmpFile();
  await credStore(file, fakeCipher()).set('ACME', 'tok-비밀-123');
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes('tok-비밀-123'), raw);
  assert.ok(raw.includes('ACME'), '어느 공간의 토큰인지는 남는다');
});

test('공간별로 따로 담는다', async () => {
  const file = await tmpFile();
  const s = credStore(file, fakeCipher());
  await s.set('ACME', 'a');
  await s.set('BETA', 'b');
  assert.equal(await s.get('ACME'), 'a');
  assert.equal(await s.get('BETA'), 'b');
  await s.remove('ACME');
  assert.equal(await s.get('BETA'), 'b', '한쪽을 지워도 다른 쪽은 남는다');
});

test('암호화가 안 되는 시스템에서는 저장을 거절한다', async () => {
  const file = await tmpFile();
  const s = credStore(file, fakeCipher(false));
  assert.equal(s.available(), false);
  await assert.rejects(() => s.set('ACME', 'tok'), /안전하게 보관할 수 없습니다/);
  await assert.rejects(() => fs.stat(file), '거절했으면 파일도 만들지 않는다');
  assert.equal(await s.get('ACME'), null);
});

test('못 푸는 암호문은 없는 것으로 본다', async () => {
  const file = await tmpFile();
  await credStore(file, fakeCipher()).set('ACME', 'tok');
  const other: Cipher = {
    available: () => true,
    decrypt: () => {
      throw new Error('다른 기기에서 만든 암호문');
    },
    encrypt: () => Buffer.alloc(0),
  };
  assert.equal(await credStore(file, other).get('ACME'), null);
});

test('깨진 파일은 빈 것으로 본다', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{ 깨짐', 'utf8');
  const s = credStore(file, fakeCipher());
  assert.equal(await s.get('ACME'), null);
  await s.set('ACME', 'tok');
  assert.equal(await s.get('ACME'), 'tok', '깨진 파일 위에 다시 쓸 수 있다');
});
