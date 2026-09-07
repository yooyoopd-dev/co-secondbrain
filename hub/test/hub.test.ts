import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { openDb } from '../src/db.ts';
import { createHub } from '../src/server.ts';
import type { DatabaseSync } from 'node:sqlite';

// HTTP 헤더 값은 ASCII 만 받는다. 한글 열쇠는 클라이언트가 보내지도 못한다 (main.ts 가 막는다)
const ADMIN = 'admin-key-for-test';
let server: Server;
let base: string;
let db: DatabaseSync;
let dir: string;
const tok: Record<string, string> = {};

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-'));
  db = openDb(path.join(dir, 'hub.sqlite'));
  server = createHub({ db, blobDir: path.join(dir, 'blobs'), adminKey: ADMIN });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await admin('POST', '/v1/admin/spaces', { id: 'ACME', title: '2026 ACME' });
  for (const [user, role] of [['hong@corp', 'writer'], ['kim@corp', 'writer'], ['lee@corp', 'reader']] as const) {
    await admin('POST', '/v1/admin/members', { spaceId: 'ACME', userId: user, role });
    tok[user] = ((await admin('POST', '/v1/admin/tokens', { userId: user })).body as { token: string }).token;
  }
});

after(() => {
  server.close();
  db.close();
});

async function admin(method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

async function call(user: string | null, method: string, p: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(user ? { authorization: `Bearer ${tok[user]}` } : {}),
      'content-type': 'application/json',
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const put = (user: string, id: string, content: string, headers: Record<string, string>) =>
  call(user, 'PUT', `/v1/spaces/ACME/pages/${encodeURIComponent(id)}`, {
    body: { path: `wiki/entities/${id}.md`, content },
    headers,
  });

const NEW = { 'if-none-match': '*' };

/* ---------------- 인증 ---------------- */

test('토큰이 없으면 401', async () => {
  assert.equal((await call(null, 'GET', '/v1/spaces')).status, 401);
  assert.equal((await call(null, 'GET', '/v1/spaces/ACME/changes')).status, 401);
});

test('관리 열쇠가 틀리면 401 — 부트스트랩 경로를 열어 두지 않는다', async () => {
  const res = await fetch(`${base}/v1/admin/spaces`, {
    method: 'POST',
    headers: { 'x-admin-key': 'wrong-key-000000', 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'X', title: 'X' }),
  });
  assert.equal(res.status, 401);
});

test('평문 토큰을 저장하지 않는다', () => {
  const rows = db.prepare('SELECT token_hash FROM tokens').all() as unknown as { token_hash: string }[];
  assert.ok(rows.length >= 3);
  for (const r of rows) {
    assert.match(r.token_hash, /^[0-9a-f]{64}$/);
    assert.equal(Object.values(tok).includes(r.token_hash), false);
  }
});

test('reader 는 읽되 못 쓴다', async () => {
  assert.equal((await call('lee@corp', 'GET', '/v1/spaces/ACME/changes')).status, 200);
  assert.equal((await put('lee@corp', 'ro', '내용', NEW)).status, 403);
});

test('회원이 아니면 403', async () => {
  const t = ((await admin('POST', '/v1/admin/tokens', { userId: 'nobody@corp' })).body as { token: string }).token;
  const res = await fetch(`${base}/v1/spaces/ACME/changes`, { headers: { authorization: `Bearer ${t}` } });
  assert.equal(res.status, 403);
});

test('폐기한 토큰은 안 통한다', async () => {
  const t = ((await admin('POST', '/v1/admin/tokens', { userId: 'hong@corp' })).body as { token: string }).token;
  const h = { authorization: `Bearer ${t}` };
  assert.equal((await fetch(`${base}/v1/spaces/ACME/changes`, { headers: h })).status, 200);
  const { createHash } = await import('node:crypto');
  await admin('POST', `/v1/admin/tokens/${createHash('sha256').update(t).digest('hex')}/revoke`);
  assert.equal((await fetch(`${base}/v1/spaces/ACME/changes`, { headers: h })).status, 401);
});

/* ---------------- 페이지 ---------------- */

test('신규 생성은 v1 이고 다시 만들려 하면 409', async () => {
  const a = await put('hong@corp', 'acme', '# 에이콤 v1', NEW);
  assert.equal(a.status, 200);
  assert.equal(a.body['version'], 1);
  const b = await put('kim@corp', 'acme', '# 남이 먼저', NEW);
  assert.equal(b.status, 409);
  assert.equal(b.body['serverVersion'], 1);
  assert.equal(b.body['serverContent'], '# 에이콤 v1');
});

test('If-Match 가 맞으면 판본이 오른다', async () => {
  const r = await put('hong@corp', 'acme', '# 에이콤 v2', { 'if-match': '1' });
  assert.equal(r.status, 200);
  assert.equal(r.body['version'], 2);
});

test('조건 헤더가 없으면 428 — 조용히 덮어쓰지 않는다', async () => {
  const r = await put('hong@corp', 'acme', 'x', {});
  assert.equal(r.status, 428);
});

test('409 는 3-way 병합 재료 세 조각을 한 번에 준다', async () => {
  // 왕복을 줄이는 것이 이 설계의 요점이다 (HUB.md §4)
  const r = await put('kim@corp', 'acme', '# 김의 수정', { 'if-match': '1' });
  assert.equal(r.status, 409);
  assert.equal(r.body['serverVersion'], 2);
  assert.equal(r.body['serverContent'], '# 에이콤 v2');
  assert.equal(r.body['baseContent'], '# 에이콤 v1', 'base 가 없으면 병합을 못 한다');
});

test('과거 판본을 그대로 꺼낼 수 있다', async () => {
  const cur = await call('hong@corp', 'GET', '/v1/spaces/ACME/pages/acme');
  assert.equal(cur.body['version'], 2);
  const old = await call('hong@corp', 'GET', '/v1/spaces/ACME/pages/acme?version=1');
  assert.equal(old.body['content'], '# 에이콤 v1');
  assert.equal((await call('hong@corp', 'GET', '/v1/spaces/ACME/pages/acme?version=99')).status, 404);
});

test('삭제도 판본을 올리고 이후 읽기는 404 다', async () => {
  await put('hong@corp', 'tmp', '지울 것', NEW);
  const bad = await call('hong@corp', 'DELETE', '/v1/spaces/ACME/pages/tmp', { headers: { 'if-match': '9' } });
  assert.equal(bad.status, 409);
  const ok = await call('hong@corp', 'DELETE', '/v1/spaces/ACME/pages/tmp', { headers: { 'if-match': '1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body['version'], 2);
  assert.equal((await call('hong@corp', 'GET', '/v1/spaces/ACME/pages/tmp')).status, 404);
});

/* ---------------- 동시 쓰기 무손실 ---------------- */

test('같은 base 로 동시에 쓰면 하나만 성공한다', async () => {
  await put('hong@corp', 'race', 'v1', NEW);
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => put(i % 2 ? 'hong@corp' : 'kim@corp', 'race', `동시 ${i}`, { 'if-match': '1' })),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1, '둘 이상 성공하면 덮어쓰기가 일어난다');
  assert.equal(results.filter((r) => r.status === 409).length, 7);
  const cur = await call('hong@corp', 'GET', '/v1/spaces/ACME/pages/race');
  assert.equal(cur.body['version'], 2);
});

test('read-modify-write 를 반복해도 판본이 정확히 센 만큼 오른다', async () => {
  await put('hong@corp', 'loop', '0', NEW);
  let applied = 0;
  for (let i = 0; i < 20; i++) {
    const cur = await call('hong@corp', 'GET', '/v1/spaces/ACME/pages/loop');
    const r = await put(i % 2 ? 'kim@corp' : 'hong@corp', 'loop', String(i), { 'if-match': String(cur.body['version']) });
    if (r.status === 200) applied++;
  }
  const cur = await call('hong@corp', 'GET', '/v1/spaces/ACME/pages/loop');
  assert.equal(cur.body['version'], applied + 1);
  const versions = db.prepare('SELECT COUNT(*) n FROM page_versions WHERE page_id = ?').get('loop') as unknown as { n: number };
  assert.equal(versions.n, applied + 1, '판본 기록이 빠지면 3-way 병합의 base 를 잃는다');
});

/* ---------------- 변경 커서 ---------------- */

test('changes 는 since 뒤의 이벤트만 순서대로 준다', async () => {
  const all = await call('hong@corp', 'GET', '/v1/spaces/ACME/changes?since=0');
  const events = all.body['events'] as { seq: number; kind: string; page_id: string }[];
  assert.ok(events.length > 5);
  assert.ok(events.every((e) => e.kind === 'page'));
  assert.deepEqual([...events].sort((a, b) => a.seq - b.seq), events, '순서가 어긋나면 커서가 무의미하다');

  const half = events[2]!.seq;
  const rest = await call('hong@corp', 'GET', `/v1/spaces/ACME/changes?since=${half}`);
  assert.ok((rest.body['events'] as unknown[]).every((e) => (e as { seq: number }).seq > half));
});

test('limit 을 넘으면 hasMore 와 nextSeq 로 이어 받는다', async () => {
  const first = await call('hong@corp', 'GET', '/v1/spaces/ACME/changes?since=0&limit=2');
  assert.equal((first.body['events'] as unknown[]).length, 2);
  assert.equal(first.body['hasMore'], true);
  const next = await call('hong@corp', 'GET', `/v1/spaces/ACME/changes?since=${first.body['nextSeq']}&limit=2`);
  assert.ok((next.body['events'] as { seq: number }[])[0]!.seq > (first.body['nextSeq'] as number) - 1);
});

/* ---------------- blob ---------------- */

async function upload(user: string, name: string, data: string) {
  const res = await fetch(`${base}/v1/spaces/ACME/blobs?filename=${encodeURIComponent(name)}&mime=text/plain`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tok[user]}` },
    body: data,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test('같은 내용을 여러 명이 올려도 한 번만 저장한다', async () => {
  const a = await upload('hong@corp', '킥오프.pptx', '같은 내용');
  assert.equal(a.status, 200);
  assert.equal(a.body['dedup'], false);
  assert.match(a.body['sha256'] as string, /^[0-9a-f]{64}$/);
  const b = await upload('kim@corp', '킥오프-사본.pptx', '같은 내용');
  assert.equal(b.body['sha256'], a.body['sha256']);
  assert.equal(b.body['dedup'], true, '콘텐츠 주소인데 두 번 저장됐습니다');
});

test('blob 을 Range 로 나눠 받는다 — 200MB 를 통째로 다시 받지 않게 한다', async () => {
  const { body } = await upload('hong@corp', 'r.txt', '0123456789');
  const sha = body['sha256'] as string;
  const url = `${base}/v1/spaces/ACME/blobs/${sha}`;
  const h = { authorization: `Bearer ${tok['hong@corp']}` };

  const head = await fetch(url, { method: 'HEAD', headers: h });
  assert.equal(head.headers.get('content-length'), '10');

  const part = await fetch(url, { headers: { ...h, range: 'bytes=2-4' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '234');
  assert.equal(part.headers.get('content-range'), 'bytes 2-4/10');

  assert.equal(await (await fetch(url, { headers: h })).text(), '0123456789');
  assert.equal((await fetch(url, { headers: { ...h, range: 'bytes=99-' } })).status, 416);
});

test('없는 blob 은 404', async () => {
  const r = await call('hong@corp', 'GET', `/v1/spaces/ACME/blobs/${'0'.repeat(64)}`);
  assert.equal(r.status, 404);
});

/* ---------------- 그 밖 ---------------- */

test('health 는 토큰 없이 열려 있다 — systemd 가 본다', async () => {
  const r = await fetch(`${base}/v1/health`);
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { ok: boolean }).ok, true);
});

test('내가 속한 공간만 목록에 나온다', async () => {
  await admin('POST', '/v1/admin/spaces', { id: 'OTHER', title: '남의 공간' });
  const r = await call('hong@corp', 'GET', '/v1/spaces');
  assert.deepEqual((r.body['spaces'] as { id: string }[]).map((s) => s.id), ['ACME']);
});

test('없는 경로는 404', async () => {
  assert.equal((await call('hong@corp', 'GET', '/v1/nope')).status, 404);
  assert.equal((await call('hong@corp', 'GET', '/v1/spaces/ACME/nope')).status, 404);
});
