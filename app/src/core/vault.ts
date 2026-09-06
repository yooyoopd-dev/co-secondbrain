// Vault — 개인 금고 / CO 영역의 디스크 구조. PLAN.md §3
//
// 원칙: **디스크가 진실이다.** SQLite 는 재생성 가능한 캐시일 뿐이고,
// 앱을 지워도 지식은 마크다운으로 남는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from './security.ts';

export const VAULT_DIRS = [
  'sources',
  'extracted',
  'wiki',
  'wiki/sources',
  'wiki/entities',
  'wiki/concepts',
  'wiki/synthesis',
  'assets',
  'schema',
  'journal',
  '.sb',
  '.sb/cache',
  '.sb/history',
  '.sb/sync',
  '.sb/sync/base',
] as const;

export interface VaultConfig {
  /** 공간 id — `personal` 또는 프로젝트명 */
  id: string;
  title: string;
  /** CO 영역이면 허브 URL. 개인 금고는 null */
  hub: string | null;
  createdAt: string;
}

export interface Vault {
  root: string;
  config: VaultConfig;
}

const CONFIG_PATH = '.sb/config.json';

const AGENTS_MD = `# 위키 규약

이 파일이 LLM 을 "규율 있는 위키 관리자"로 만든다. 사람과 LLM 이 함께 고쳐 나간다.

## 페이지 형식

- YAML front-matter 로 시작한다
- 모든 주장에 앵커 인용을 붙인다: \`[^src-kickoff#slide-12]\`
- 출처 없는 문장은 쓰지 않는다

## 신뢰도

주장마다 셋 중 하나를 붙인다.

- \`EXTRACTED\` — 원본에 명시돼 있음
- \`INFERRED\` — 추론. 점수를 0.95 / 0.85 / 0.75 / 0.65 / 0.55 중에서 고른다
- \`AMBIGUOUS\` — 불확실. Lint 결과함으로 간다

## 한국어 작문

- "~을 가지고 있다" 금지 → "경쟁력이 강하다"
- 이중 피동 "~되어진다" 금지
- 분열문 "핵심은 ~다" 금지 → 주어-서술 직결
- 부정 대구 "A가 아니라 B" 문서당 1회 이하
- 연결어미 뒤 쉼표("~하고, ~하며,") 금지
- "결론적으로 / 이를 통해 / 요약하면" 문서당 1회 이하
- 이모지 금지

## 인제스트

한 건씩 감독 모드로 처리한다. 배치가 필요하면 여기에 기록한다.
`;

const TAXONOMY_MD = `# 분류

## 엔티티
사람 · 조직 · 시스템 · 제품

## 개념
결정 · 리스크 · 주제 · 용어

프로젝트에 맞게 고쳐 쓴다.
`;

/** 빈 디렉터리에 Vault 를 만든다. 이미 있으면 던진다. */
export async function createVault(root: string, config: Omit<VaultConfig, 'createdAt'>): Promise<Vault> {
  const cfgPath = safeJoin(root, CONFIG_PATH);
  if (await exists(cfgPath)) throw new Error(`이미 Vault 입니다: ${root}`);

  for (const dir of VAULT_DIRS) await fs.mkdir(safeJoin(root, dir), { recursive: true });

  const full: VaultConfig = { ...config, createdAt: new Date().toISOString() };
  await fs.writeFile(cfgPath, JSON.stringify(full, null, 2), 'utf8');
  await fs.writeFile(safeJoin(root, 'schema/AGENTS.md'), AGENTS_MD, 'utf8');
  await fs.writeFile(safeJoin(root, 'schema/taxonomy.md'), TAXONOMY_MD, 'utf8');
  await fs.writeFile(safeJoin(root, 'index.md'), '# 인덱스\n\n_아직 페이지가 없습니다._\n', 'utf8');
  await fs.writeFile(safeJoin(root, 'log.md'), '# 로그\n\n', 'utf8');
  await fs.writeFile(safeJoin(root, '.sbignore'), '# .gitignore 와 같은 문법\n', 'utf8');

  return { root, config: full };
}

/** 기존 Vault 를 연다. Vault 가 아니면 던진다. */
export async function openVault(root: string): Promise<Vault> {
  const cfgPath = safeJoin(root, CONFIG_PATH);
  if (!(await exists(cfgPath))) throw new Error(`Vault 가 아닙니다: ${root}`);
  const config = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as VaultConfig;

  // 나중에 추가된 디렉터리를 채운다 (구버전 Vault 대응)
  for (const dir of VAULT_DIRS) await fs.mkdir(safeJoin(root, dir), { recursive: true });
  return { root, config };
}

export async function isVault(root: string): Promise<boolean> {
  try {
    return await exists(safeJoin(root, CONFIG_PATH));
  } catch {
    return false;
  }
}

/** 원본을 Vault 에 복사한다. 원본 파일은 이후 절대 수정하지 않는다. */
export async function importSource(vault: Vault, filePath: string): Promise<string> {
  const dest = safeJoin(vault.root, 'sources', path.basename(filePath));
  await fs.copyFile(filePath, dest);
  return dest;
}

/** log.md 에 한 줄 추가한다. 원문이 제시한 grep 가능한 접두사 형식. */
export async function appendLog(vault: Vault, kind: 'ingest' | 'query' | 'lint', title: string): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const line = `## [${date}] ${kind.padEnd(6)}| ${title}\n`;
  await fs.appendFile(safeJoin(vault.root, 'log.md'), line, 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
