// 지출 기록의 디스크 저장. `spend.ts` 에서 갈라 나왔다 — 렌더러가 그 파일을 부르는데
// 여기 있는 `node:fs` 가 브라우저 번들로 끌려 들어갔다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { EMPTY_LOG, type SpendLog } from './spend.ts';

/**
 * Vault 가 아니라 앱 단위로 쌓는다. 사내 계정 상한은 Vault 마다가 아니라 계정마다다 —
 * Vault 별로 세면 상한을 두 배로 쓰게 된다.
 */
export async function read(file: string): Promise<SpendLog> {
  try {
    const log = JSON.parse(await fs.readFile(file, 'utf8')) as SpendLog;
    return log.version === 1 && log.days ? log : EMPTY_LOG;
  } catch {
    return EMPTY_LOG;
  }
}

export async function write(file: string, log: SpendLog): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(log, null, 1), 'utf8');
  await fs.rename(tmp, file);
}
