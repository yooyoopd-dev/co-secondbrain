// Store 의 동기화 배선. **진짜 허브를 띄워** 돈다 — 가짜 클라이언트로는
// 토큰 검증과 권한 거절을 볼 수 없기 때문이다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../src/main/store.ts';
import { emptyPage, serializePage } from '../src/core/page.ts';
import type { TokenStore } from '../src/main/creds.ts';

const HUB = new URL('../../hub/src/', import.meta.url);
const ADMIN = 'test-admin-key';
const REL = 'wiki/entities/acme-corp.md';

let server: Server;
let base: string;
let dir: string;
const token: Record<string, string> = {};

/** 메모리 토큰 보관소. 파일 형식은 creds.test.ts 가 따로 본다 */
function memTokens(available = true): TokenStore & { saved: Record<string, string> } {
  const saved: Record<string, string> = {};
  return {
    saved,
    available: () => available,
    get: async (k) => saved[k] ?? null,
    set: async (k, t) => {
      if (!available) throw new Error('이 시스템에서는 토큰을 안전하게 보관할 수 없습니다');
      saved[k] = t;
    },
    remove: async (k) => {
      delete saved[k];
    },
  };
}

before(async () => {
  const { openDb } = await import(new URL('db.ts', HUB).href);
  const { createHub } = await import(new URL('server.ts', HUB).href);
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-syncstore-'));
  server = createHub({ db: openDb(path.join(dir, 'hub.sqlite')), blobDir: path.join(dir, 'blobs'), adminKey: ADMIN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const admin = (p: string, body: unknown) =>
    fetch(base + p, {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);

  await admin('/v1/admin/spaces', { id: 'ACME', title: 'ACME' });
  for (const [user, role] of [['hong@corp', 'writer'], ['kim@corp', 'writer'], ['lee@corp', 'reader']] as const) {
    await admin('/v1/admin/members', { spaceId: 'ACME', userId: user, role });
    token[user] = (await admin('/v1/admin/tokens', { userId: user })).token as string;
  }
});

after(() => server.close());

async function opened(id = 'ACME', tokens = memTokens()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-vault-'));
  const s = new Store({ tokens });
  await s.open(root, { id, title: id });
  return { s, root, tokens };
}

/** 위키 페이지 한 장을 디스크에 쓴다. 동기화는 디스크를 진실로 본다 */
async function writePage(root: string, body: string): Promise<void> {
  const page = emptyPage('acme-corp', 'entity', '에이콤(주)');
  page.front.updated = '2026-09-06T00:00:00.000Z';
  page.body = body;
  await fs.writeFile(path.join(root, REL), serializePage(page), 'utf8');
}

const read = (root: string) => fs.readFile(path.join(root, REL), 'utf8');

test('개인 금고는 허브에 붙지 않는다', async () => {
  const { s } = await opened('personal');
  const st = await s.hubStatus();
  assert.equal(st.personal, true);
  assert.equal(st.hub, null);

  const c = await s.connectHub(base, token['hong@corp']!);
  assert.equal(c.ok, false);
  assert.equal((await s.syncNow()).ok, false);
  s.close();
});

test('토큰이 틀리면 저장하지 않는다', async () => {
  const { s, tokens } = await opened();
  const c = await s.connectHub(base, '틀린-토큰');
  assert.equal(c.ok, false);
  assert.deepEqual(tokens.saved, {}, '검증 전에는 아무것도 보관하지 않는다');
  assert.equal((await s.hubStatus()).hub, null, '설정도 그대로다');
  s.close();
});

test('허브가 안 떠 있으면 오프라인으로 알린다', async () => {
  const { s, tokens } = await opened();
  const c = await s.connectHub('http://127.0.0.1:1', token['hong@corp']!);
  assert.equal(c.ok, false);
  assert.match(c.ok === false ? c.error : '', /닿지 못했습니다/);
  assert.deepEqual(tokens.saved, {});
  s.close();
});

test('읽기 권한만 있으면 연결을 거절한다', async () => {
  const { s, tokens } = await opened();
  const c = await s.connectHub(base, token['lee@corp']!);
  assert.equal(c.ok, false);
  assert.match(c.ok === false ? c.error : '', /읽기 권한/);
  assert.deepEqual(tokens.saved, {});
  s.close();
});

test('토큰을 보관할 수 없는 시스템에서는 연결하지 않는다', async () => {
  const { s } = await opened('ACME', memTokens(false));
  const c = await s.connectHub(base, token['hong@corp']!);
  assert.equal(c.ok, false);
  assert.match(c.ok === false ? c.error : '', /안전하게 보관할 수 없습니다/);
  s.close();
});

test('연결하고 올리고 받는다', async () => {
  const A = await opened();
  const okc = await A.s.connectHub(base, token['hong@corp']!);
  assert.equal(okc.ok, true);
  assert.equal(A.tokens.saved['ACME'], token['hong@corp']);
  assert.equal((await A.s.hubStatus()).hub, base, '허브 주소가 설정에 남는다');

  // 토큰은 금고 폴더 어디에도 없어야 한다
  const cfg = await fs.readFile(path.join(A.root, '.sb/config.json'), 'utf8');
  assert.ok(!cfg.includes(token['hong@corp']!), cfg);

  await writePage(A.root, '\n한 줄\n두 줄\n세 줄\n');
  assert.equal((await A.s.hubStatus()).pending, 1);

  const up = await A.s.syncNow();
  assert.equal(up.ok, true);
  assert.equal(up.ok === true ? up.report.pushed.length : -1, 1);
  assert.equal((await A.s.hubStatus()).pending, 0, '올린 뒤에는 보낼 것이 없다');

  const B = await opened();
  await B.s.connectHub(base, token['kim@corp']!);
  const down = await B.s.syncNow();
  assert.equal(down.ok === true ? down.report.pulled.length : -1, 1);
  assert.equal(await read(B.root), await read(A.root), '두 금고의 내용이 같다');
  A.s.close();
  B.s.close();
});

test('같은 줄 충돌은 병합 화면으로 넘어가고 디스크는 그대로다', async () => {
  const A = await opened();
  const B = await opened();
  await A.s.connectHub(base, token['hong@corp']!);
  await B.s.connectHub(base, token['kim@corp']!);
  await A.s.syncNow();
  await B.s.syncNow();

  await fs.writeFile(path.join(A.root, REL), (await read(A.root)).replace('두 줄', '두 줄 — A'), 'utf8');
  await A.s.syncNow();
  await fs.writeFile(path.join(B.root, REL), (await read(B.root)).replace('두 줄', '두 줄 — B'), 'utf8');

  const r = await B.s.syncNow();
  assert.equal(r.ok === true ? r.report.conflicts.length : -1, 1);
  assert.equal(B.s.conflicts().length, 1);
  assert.equal((await B.s.hubStatus()).conflicts, 1);
  assert.ok((await read(B.root)).includes('두 줄 — B'), '충돌 동안 디스크를 건드리지 않았다');

  const c = B.s.conflicts()[0]!;
  assert.equal(c.merged.clean, false, '같은 줄이라 자동으로 고르지 않는다');

  const bad = await B.s.resolveConflict(c.pageId, c.merged.text);
  assert.equal(bad.ok, false, '충돌 표시가 남은 채로는 못 올린다');
  assert.equal(B.s.conflicts().length, 1, '거절해도 충돌은 목록에 남는다');

  const picked = c.mine.replace('두 줄 — B', '두 줄 — 합의');
  const good = await B.s.resolveConflict(c.pageId, picked);
  assert.equal(good.ok, true);
  assert.equal(B.s.conflicts().length, 0, '올린 충돌은 목록에서 빠진다');
  assert.ok((await read(B.root)).includes('두 줄 — 합의'));

  const back = await A.s.syncNow();
  assert.equal(back.ok === true ? back.report.pulled.length : -1, 1);
  assert.equal(await read(A.root), await read(B.root));
  A.s.close();
  B.s.close();
});

test('연결을 끊으면 토큰만 사라지고 페이지는 남는다', async () => {
  const { s, root, tokens } = await opened();
  await s.connectHub(base, token['hong@corp']!);
  await s.syncNow();
  assert.ok((await read(root)).length > 0);

  await s.disconnectHub();
  assert.deepEqual(tokens.saved, {});
  const st = await s.hubStatus();
  assert.equal(st.hub, null);
  assert.equal(st.hasToken, false);
  assert.ok((await read(root)).length > 0, '받아 둔 페이지는 그대로 남는다');
  assert.equal((await s.syncNow()).ok, false);
  s.close();
});
