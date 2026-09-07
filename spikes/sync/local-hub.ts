// Windows 에서 허브 연결과 병합 화면을 눈으로 확인하기 위한 도구.
//
// **자가 판정 스파이크가 아니다** (CLAUDE.md §9). 사람이 화면을 보는 동안 옆에서
// 허브 노릇을 해 주는 발판이다. 자동 판정은 `offline.ts` 와 `app/test/sync-store.test.ts`
// 가 이미 한다.
//
//   node --experimental-strip-types spikes/sync/local-hub.ts serve
//   node --experimental-strip-types spikes/sync/local-hub.ts edit acme-corp
//
// `serve` 는 127.0.0.1 에 허브를 띄우고 접속 정보를 `spikes/out/dev-hub.json` 에 적는다.
// `edit` 은 **다른 사용자인 척** 허브의 페이지를 고쳐 충돌을 만든다.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const HUB = new URL('../../hub/src/', import.meta.url);
const OUT = path.resolve(import.meta.dirname, '..', 'out');
const INFO = path.join(OUT, 'dev-hub.json');
const SPACE = process.env['SB_SPACE'] ?? 'ACME';
const PORT = Number(process.env['SB_PORT'] ?? 8787);
const ADMIN = 'dev-admin-key';

interface Info {
  url: string;
  space: string;
  /** 앱에 넣을 토큰 */
  token: string;
  /** `edit` 이 쓰는 다른 사용자의 토큰 */
  otherToken: string;
}

const mode = process.argv[2];

if (mode === 'serve') await serve();
else if (mode === 'edit') await edit(process.argv[3]);
else {
  console.error('사용법: local-hub.ts serve | local-hub.ts edit <pageId>');
  process.exit(2);
}

async function serve(): Promise<void> {
  const { openDb } = await import(new URL('db.ts', HUB).href);
  const { createHub } = await import(new URL('server.ts', HUB).href);

  const dir = path.join(OUT, 'dev-hub');
  await fsp.mkdir(dir, { recursive: true });
  const server = createHub({
    db: openDb(path.join(dir, 'hub.sqlite')),
    blobDir: path.join(dir, 'blobs'),
    adminKey: ADMIN,
  });
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const admin = (p: string, body: unknown) =>
    fetch(url + p, {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);

  await admin('/v1/admin/spaces', { id: SPACE, title: SPACE });
  const token: string[] = [];
  for (const user of ['me@dev', 'other@dev']) {
    await admin('/v1/admin/members', { spaceId: SPACE, userId: user, role: 'writer' });
    token.push((await admin('/v1/admin/tokens', { userId: user })).token as string);
  }

  const info: Info = { url, space: SPACE, token: token[0]!, otherToken: token[1]! };
  await fsp.writeFile(INFO, JSON.stringify(info, null, 1), 'utf8');

  console.log(`
허브가 떴습니다. 앱의 [허브 연결] 에 아래를 넣으십시오.

  허브 주소   ${url}
  토큰        ${info.token}

Vault 폴더 이름이 공간 id 가 됩니다. **폴더 이름을 ${SPACE} 로 만드십시오.**
충돌을 보려면 다른 창에서:

  node --experimental-strip-types spikes/sync/local-hub.ts edit acme-corp

Ctrl+C 로 끕니다. 데이터는 ${dir} 에 남습니다.`);
}

/** 다른 사용자가 같은 페이지의 첫 줄을 고친 것처럼 만든다. 앱에서 같은 줄을 고치면 충돌한다. */
async function edit(pageId: string | undefined): Promise<void> {
  if (!pageId) {
    console.error('pageId 가 필요합니다. 예: acme-corp (페이지 front-matter 의 id)');
    process.exit(2);
  }
  if (!fs.existsSync(INFO)) {
    console.error(`${INFO} 가 없습니다. 먼저 serve 로 띄우십시오.`);
    process.exit(2);
  }
  const info = JSON.parse(await fsp.readFile(INFO, 'utf8')) as Info;
  const head = { authorization: `Bearer ${info.otherToken}` };
  const at = `${info.url}/v1/spaces/${encodeURIComponent(info.space)}/pages/${encodeURIComponent(pageId)}`;

  const res = await fetch(at, { headers: head });
  if (!res.ok) {
    console.error(`페이지를 못 찾았습니다 (${res.status}). 앱에서 먼저 한 번 동기화하십시오.`);
    process.exit(1);
  }
  const page = (await res.json()) as { path: string; version: number; content: string };
  const lines = page.content.split('\n');
  // 본문의 첫 줄을 고친다. front-matter 를 건너뛰어야 한다 — 안 그러면 여는 `---` 바로
  // 다음 줄(`id: ...`)을 고쳐 YAML 자체가 깨진다. 실제로 그렇게 짰다가 실측 중에 잡았다.
  const closeAt = lines.indexOf('---', 1);
  const bodyFrom = closeAt === -1 ? 0 : closeAt + 1;
  const i = lines.findIndex((l, n) => n >= bodyFrom && l.trim().length > 0);
  if (i === -1) {
    console.error('본문에 고칠 줄이 없습니다.');
    process.exit(1);
  }
  lines[i] = `${lines[i]} — 다른 사람이 고침`;

  const put = await fetch(at, {
    method: 'PUT',
    headers: { ...head, 'content-type': 'application/json', 'if-match': String(page.version) },
    body: JSON.stringify({ path: page.path, content: lines.join('\n') }),
  });
  const body = (await put.json()) as Record<string, unknown>;
  if (!put.ok) {
    console.error(`허브가 거절했습니다 (${put.status}): ${JSON.stringify(body)}`);
    process.exit(1);
  }
  console.log(`허브의 ${page.path} 를 v${body['version']} 로 고쳤습니다. 앱에서 같은 줄을 고치고 동기화하십시오.`);
}
