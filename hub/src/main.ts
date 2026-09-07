// CO-Hub 진입점. Ubuntu 리눅스에서 systemd 로 돈다 (HUB.md §2).
//
//   node dist/main.js /srv/co-hub/config.json
//
// config.json:
//   { "bind": "0.0.0.0", "port": 8787, "dataDir": "/srv/co-hub", "adminKey": "..." }
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.ts';
import { createHub } from './server.ts';

const configPath = process.argv[2] ?? '/srv/co-hub/config.json';
let cfg: { bind?: string; port?: number; dataDir?: string; adminKey?: string };
try {
  cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) as typeof cfg;
} catch (e) {
  process.stderr.write(`설정을 읽지 못했습니다 (${configPath}): ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}

const dataDir = cfg.dataDir ?? path.dirname(path.resolve(configPath));
const adminKey = cfg.adminKey;
if (!adminKey) {
  // 관리 열쇠가 없으면 토큰을 발급할 방법이 없다. 조용히 열어 두지 않는다.
  process.stderr.write('config.json 에 adminKey 가 필요합니다\n');
  process.exit(2);
}
// 열쇠는 `X-Admin-Key` 헤더로 온다. HTTP 헤더 값은 ASCII 만 받으므로 한글 열쇠를 넣으면
// 클라이언트가 보내지도 못한다. 여기서 막지 않으면 배포하고 나서야 알게 된다.
if (!/^[\x21-\x7e]+$/.test(adminKey)) {
  process.stderr.write('adminKey 는 공백 없는 ASCII 여야 합니다 (HTTP 헤더 제약)\n');
  process.exit(2);
}

const db = openDb(path.join(dataDir, 'hub.sqlite'));
const server = createHub({ db, blobDir: path.join(dataDir, 'blobs'), adminKey });

const port = cfg.port ?? 8787;
const bind = cfg.bind ?? '127.0.0.1';
server.listen(port, bind, () => process.stdout.write(`co-hub ${bind}:${port} · ${dataDir}\n`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
