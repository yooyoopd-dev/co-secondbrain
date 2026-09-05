// 2인 동시 쓰기 무손실. docs/ROADMAP.md 15번 완료 기준
//
// 허브를 띄우고 **별도 프로세스 둘**이 같은 페이지를 번갈아 고친다. 각자 자기 줄을
// 덧붙이므로, 하나라도 덮어써지면 마지막 내용에서 줄이 빈다.
//
// 정답을 알고 돌린다 (CLAUDE.md §9): 워커 둘이 N번씩 성공해야 하므로 최종 줄 수는
// 정확히 2N 이고 판본은 2N+1 이다. 어긋나면 종료 코드 1.
//
//   node --experimental-strip-types spikes/hub/concurrent.ts [N]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const HUB = new URL('../../hub/src/', import.meta.url);
const N = Number(process.argv[3] ?? process.argv[2] ?? 25) || 25;

/* ---------------- 워커 ---------------- */

if (process.argv[2] === '--worker') {
  const [, , , base, token, user, count] = process.argv;
  let done = 0;
  let conflicts = 0;
  for (let i = 0; i < Number(count); i++) {
    // 409 를 받으면 서버 판본으로 다시 읽어 덧붙인다. 이게 클라이언트가 할 일이다.
    for (;;) {
      const cur = await fetch(`${base}/v1/spaces/ACME/pages/race`, { headers: { authorization: `Bearer ${token}` } });
      const page = (await cur.json()) as { version: number; content: string };
      const res = await fetch(`${base}/v1/spaces/ACME/pages/race`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'if-match': String(page.version) },
        body: JSON.stringify({ path: 'wiki/entities/race.md', content: `${page.content}\n${user}-${i}` }),
      });
      if (res.status === 200) {
        done++;
        break;
      }
      if (res.status !== 409) {
        process.stdout.write(`WORKER_FAIL ${res.status}\n`);
        process.exit(1);
      }
      conflicts++;
    }
  }
  process.stdout.write(`WORKER_OK ${done} ${conflicts}\n`);
  process.exit(0);
}

/* ---------------- 부모 ---------------- */

const { openDb } = await import(new URL('db.ts', HUB).href);
const { createHub } = await import(new URL('server.ts', HUB).href);

const ADMIN = 'spike-admin-key';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-spike-'));
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
await fetch(`${base}/v1/spaces/ACME/pages/race`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json', 'if-none-match': '*' },
  body: JSON.stringify({ path: 'wiki/entities/race.md', content: 'start' }),
});

console.log(`허브 ${base} · 워커 2개 × ${N}회`);
const self = fileURLToPath(import.meta.url);
const t0 = Date.now();
const runs = ['hong@corp', 'kim@corp'].map(
  (user, i) =>
    new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', self, '--worker', base, tokens[i]!, user, String(N)], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.on('close', () => resolve(out.trim()));
    }),
);
const outs = await Promise.all(runs);
const ms = Date.now() - t0;

const cur = await fetch(`${base}/v1/spaces/ACME/pages/race`, { headers: { authorization: `Bearer ${tokens[0]}` } });
const page = (await cur.json()) as { version: number; content: string };
const lines = page.content.split('\n').filter((l) => l !== 'start');
const versions = (db.prepare('SELECT COUNT(*) n FROM page_versions WHERE page_id = ?').get('race') as { n: number }).n;

let conflicts = 0;
for (const o of outs) {
  console.log(' ', o);
  const m = /^WORKER_OK (\d+) (\d+)$/.exec(o);
  if (m) conflicts += Number(m[2]);
}

const fails: string[] = [];
const want = 2 * N;
if (lines.length !== want) fails.push(`줄 ${lines.length} (기대 ${want}) — 덮어써진 쓰기가 있습니다`);
if (new Set(lines).size !== want) fails.push('중복 줄이 있습니다');
if (page.version !== want + 1) fails.push(`판본 ${page.version} (기대 ${want + 1})`);
if (versions !== want + 1) fails.push(`판본 기록 ${versions} (기대 ${want + 1}) — 3-way 병합의 base 를 잃습니다`);

console.log(`\n최종 판본 ${page.version} · 줄 ${lines.length}/${want} · 판본 기록 ${versions} · 충돌 재시도 ${conflicts}회 · ${ms}ms`);
console.log(fails.length === 0 ? '무손실 확인' : `실패:\n - ${fails.join('\n - ')}`);
server.close();
db.close();
process.exit(fails.length === 0 ? 0 : 1);
