// 오프라인 편집 후 재접속. docs/ROADMAP.md 16번 완료 기준
//
// **진짜 허브를 띄우고 진짜 금고 둘로** 돌린다. FakeHub 로 통과한 것이 실제 HTTP 와
// SQLite 위에서도 되는지 보는 것이 이 스파이크의 목적이다.
//
// 정답을 알고 돌린다 (CLAUDE.md §9):
//   - 서로 다른 줄을 고치면 병합은 깨끗해야 하고 두 고침이 다 남아야 한다
//   - 같은 줄을 고치면 반드시 충돌로 잡혀야 한다. 자동으로 하나를 고르면 실패다
//   - 마지막에 두 금고의 파일이 바이트까지 같아야 한다
//
//   node --experimental-strip-types spikes/sync/offline.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createVault, type Vault } from '../../app/src/core/vault.ts';
import { emptyPage, serializePage } from '../../app/src/core/page.ts';
import { hubClient } from '../../app/src/core/sync/client.ts';
import { resolveConflict, sync } from '../../app/src/core/sync/engine.ts';

const HUB = new URL('../../hub/src/', import.meta.url);
const { openDb } = await import(new URL('db.ts', HUB).href);
const { createHub } = await import(new URL('server.ts', HUB).href);

const ADMIN = 'spike-admin-key';
const REL = 'wiki/entities/acme-corp.md';
const fails: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${what}`);
  if (!ok) fails.push(what);
};

/* ---------------- 허브 ---------------- */

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-spike-'));
const db = openDb(path.join(dir, 'hub.sqlite'));
const server = createHub({ db, blobDir: path.join(dir, 'blobs'), adminKey: ADMIN });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const admin = (p: string, body: unknown) =>
  fetch(base + p, {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json() as Promise<Record<string, unknown>>);

await admin('/v1/admin/spaces', { id: 'ACME', title: 'ACME' });
const tokens: string[] = [];
for (const user of ['hong@corp', 'kim@corp']) {
  await admin('/v1/admin/members', { spaceId: 'ACME', userId: user, role: 'writer' });
  tokens.push((await admin('/v1/admin/tokens', { userId: user })).token as string);
}

/* ---------------- 금고 둘 ---------------- */

const vaultAt = async (tag: string): Promise<Vault> =>
  createVault(await fs.mkdtemp(path.join(os.tmpdir(), `sync-${tag}-`)), { id: 'ACME', title: 'ACME', hub: base });

const A = await vaultAt('a');
const B = await vaultAt('b');
const ca = hubClient({ url: base, token: tokens[0]! });
const cb = hubClient({ url: base, token: tokens[1]! });

const write = (v: Vault, text: string) => fs.writeFile(path.join(v.root, REL), text, 'utf8');
const read = (v: Vault) => fs.readFile(path.join(v.root, REL), 'utf8');

const page = emptyPage('acme-corp', 'entity', '에이콤(주)');
page.front.updated = '2026-09-06T00:00:00.000Z';
page.body = '\n한 줄\n두 줄\n세 줄\n';
await write(A, serializePage(page));

console.log(`허브 ${base}\n`);

/* ---------------- 1. 올리기와 받기 ---------------- */

console.log('1. A 가 올리고 B 가 받는다');
const up = await sync(A, ca);
check(up.pushed.length === 1 && up.conflicts.length === 0, 'A 가 페이지를 올렸다');
const down = await sync(B, cb);
check(down.pulled.length === 1, 'B 가 페이지를 받았다');
check((await read(A)) === (await read(B)), '두 금고의 내용이 같다');

/* ---------------- 2. 오프라인 ---------------- */

console.log('\n2. 허브에 못 닿는 동안 B 가 고친다');
const dead = hubClient({ url: 'http://127.0.0.1:1', token: tokens[1]! });
await write(B, (await read(B)).replace('세 줄', '세 줄 (B 가 고침)'));
const off = await sync(B, dead);
check(off.offline === true, '오프라인으로 보고했다');
check(off.pushed.length === 0 && off.conflicts.length === 0, '오프라인에서는 아무것도 올리지 않았다');
check((await read(B)).includes('B 가 고침'), '오프라인 편집이 디스크에 그대로 남았다');

/* ---------------- 3. 서로 다른 줄 → 자동 병합 ---------------- */

console.log('\n3. 그 사이 A 는 다른 줄을 고쳐 올렸다');
await write(A, (await read(A)).replace('한 줄', '한 줄 (A 가 고침)'));
check((await sync(A, ca)).pushed.length === 1, 'A 가 먼저 올렸다');

const bs = await sync(B, cb);
check(bs.conflicts.length === 1, 'B 는 409 를 받아 병합안을 받았다');
const c1 = bs.conflicts[0]!;
check(c1.merged.clean === true, '서로 다른 줄이라 병합이 깨끗하다');
check(c1.merged.text.includes('A 가 고침') && c1.merged.text.includes('B 가 고침'), '두 고침이 모두 남았다');
check((await read(B)).includes('A 가 고침') === false, '충돌 동안 디스크를 건드리지 않았다');

const r1 = await resolveConflict(B, cb, c1, c1.merged.text);
check(r1.ok === true, '병합 결과를 올렸다');
await sync(A, ca);
check((await read(A)) === (await read(B)), '두 금고가 다시 같아졌다');

/* ---------------- 4. 같은 줄 → 사람 판단 ---------------- */

console.log('\n4. 같은 줄을 서로 다르게 고친다');
await write(A, (await read(A)).replace('두 줄', '두 줄 — A 의 주장'));
await sync(A, ca);
await write(B, (await read(B)).replace('두 줄', '두 줄 — B 의 주장'));

const bs2 = await sync(B, cb);
check(bs2.conflicts.length === 1, '충돌로 잡혔다');
const c2 = bs2.conflicts[0]!;
check(c2.merged.clean === false, '같은 줄이라 자동으로 고르지 않았다');
check(c2.merged.text.includes('<<<<<<< 내 것'), '충돌 표시를 남겼다');

const marked = await resolveConflict(B, cb, c2, c2.merged.text);
check(marked.ok === false, '충돌 표시가 남은 채로는 올리지 못한다');

const picked = c2.mine.replace('두 줄 — B 의 주장', '두 줄 — A 와 B 가 합의');
const r2 = await resolveConflict(B, cb, c2, picked);
check(r2.ok === true, '사람이 고른 결과는 올라갔다');

const last = await sync(A, ca);
check(last.pulled.length === 1, 'A 가 합의본을 받았다');
check((await read(A)) === (await read(B)), '두 금고가 같다');

/* ---------------- 5. 손실 확인 ---------------- */

const final = await read(A);
check(final.includes('한 줄 (A 가 고침)'), 'A 의 첫 고침이 남았다');
check(final.includes('세 줄 (B 가 고침)'), 'B 의 오프라인 고침이 남았다');
check(final.includes('두 줄 — A 와 B 가 합의'), '합의본이 남았다');

const versions = (db.prepare('SELECT COUNT(*) n FROM page_versions WHERE page_id = ?').get('acme-corp') as { n: number }).n;
console.log(`\n허브 판본 기록 ${versions}개`);
console.log(fails.length === 0 ? '무손실 확인' : `실패 ${fails.length}건:\n - ${fails.join('\n - ')}`);

server.close();
db.close();
process.exit(fails.length === 0 ? 0 : 1);
