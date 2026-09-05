// 격리 작업 디렉터리. PLAN.md §7.1 의 1·2·5 단계.
//
// Vault 루트를 통째로 주면 무관한 프로젝트 문서까지 컨텍스트에 올라가고, 앱이 어떤 파일이
// 전달됐는지 기록·통제할 수 없다. 그래서 **이번 작업에 필요한 것만** 새 디렉터리에 쓴다.
//
// cwd 로도 쓰인다. CLI 는 cwd 의 규약 파일(`CLAUDE.md` · `AGENTS.md` · `GEMINI.md`)을
// 읽으므로, 여기에 둔 파일이 곧 모델이 받는 지침이다 (PLAN.md §7.3).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeJoin } from '../security.ts';

export interface Workdir {
  root: string;
  /** 실제로 쓴 파일의 상대 경로. 로그에 남긴다 — 무엇이 전달됐는지가 기록이다 */
  files: string[];
}

/**
 * 임시 디렉터리를 만들고 `files` 를 그대로 쓴다.
 * 키는 상대 경로다. 디렉터리 밖으로 나가는 경로는 던진다.
 */
export async function prepareWorkdir(files: Readonly<Record<string, string>>): Promise<Workdir> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-agent-'));
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const dest = safeJoin(root, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, 'utf8');
    written.push(rel);
  }
  return { root, files: written.sort() };
}

/** 작업이 끝나면 지운다. 이미 없으면 조용히 넘어간다. */
export async function disposeWorkdir(wd: Workdir): Promise<void> {
  await fs.rm(wd.root, { recursive: true, force: true });
}
