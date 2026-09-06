// Vault — 개인용과 CO 영역의 디스크 구조. PLAN.md §3
//
// 원칙: **디스크가 진실이다.** SQLite 는 재생성 가능한 캐시일 뿐이고,
// 앱을 지워도 지식은 마크다운으로 남는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeJoin } from './security.ts';

/**
 * Vault 의 폴더. **Obsidian 과 병행해서 쓰므로 사람이 여는 것에만 번호를 붙인다** —
 * 번호가 파일 목록의 순서를 고정하고, 그 순서가 곧 작업 순서다
 * (넣는다 → 원본 → 노트 → 내보낸다).
 *
 * 앱이 만들고 앱만 읽는 것은 `.sb/` 아래로 내린다. 추출 JSON 이 노트 사이에 섞여 있으면
 * 사람이 어느 것을 열어야 하는지 알 수 없다.
 *
 * 첨부만 예외로 `02_NOTES/assets/` 다. **Obsidian 은 점으로 시작하는 폴더를 통째로
 * 무시하므로** `.sb/` 에 넣으면 노트에 끼운 그림이 안 보인다.
 */
export const VAULT_DIRS = [
  // 사람이 파일을 놓는 대기함. Obsidian 파일 목록에서 맨 위에 오도록 번호를 붙인다.
  // **앱은 이 폴더의 파일을 옮기지도 지우지도 않는다** — 사람이 넣은 것을 앱이 치우면
  // 어디로 갔는지 찾을 수 없다. 처리 여부는 manifest 의 내용 해시로 판정한다.
  '00_INBOX',
  // 넣은 원본 파일 원형. 넣은 뒤로는 절대 고치지 않는다
  '01_SOURCES',
  // 위키. 관문 2 가 LLM 이 쓸 수 있는 경로를 이 네 갈래로 묶는다
  '02_NOTES',
  '02_NOTES/sources',
  '02_NOTES/entities',
  '02_NOTES/concepts',
  '02_NOTES/synthesis',
  '02_NOTES/assets',
  // 내보낸 산출물. 슬라이드 저장이 여기서 시작한다
  '03_OUTPUT',
  // 규약과 분류. LLM 이 읽는 지시가 여기 있다
  '09_TEMPLATES',
  '.sb',
  '.sb/extracted',
  '.sb/journal',
  '.sb/cache',
  '.sb/history',
  '.sb/sync',
  '.sb/sync/base',
] as const;

/** 넣은 원본 파일이 쌓이는 곳 */
export const SOURCES_DIR = '01_SOURCES';
/** 위키 루트. 관문 2 의 경로 정규식이 이 이름을 강제한다 */
export const NOTES_DIR = '02_NOTES';
/** 앱이 뽑은 추출 JSON. 사람이 읽을 것이 아니라 `.sb/` 아래에 둔다 */
export const EXTRACTED_DIR = '.sb/extracted';
/** 내보낸 산출물의 기본 위치 */
export const OUTPUT_DIR = '03_OUTPUT';
/** 규약·분류 파일 */
export const TEMPLATES_DIR = '09_TEMPLATES';

/** 개인 Vault 의 공간 id. 이 Vault 는 허브에 붙지 않는다 (PLAN.md §3) */
export const PERSONAL_ID = 'personal';

export interface VaultConfig {
  /** 공간 id — `personal` 또는 프로젝트명 */
  id: string;
  title: string;
  /** CO 영역이면 허브 URL. 개인 Vault 는 null */
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

## 폴더

번호는 사람이 파일 목록에서 순서를 보라고 붙인 것이다. 작업 순서와 같다.

| 폴더 | 무엇이 들어가나 |
|---|---|
| \`00_INBOX/\` | 사람이 처리해 달라고 놓는 파일. **앱도 LLM 도 여기를 고치지 않는다** |
| \`01_SOURCES/\` | 넣은 원본 파일 원형. 넣은 뒤로 고치지 않는다 |
| \`02_NOTES/\` | 위키. 페이지는 전부 여기 아래 넷 중 하나에 있다 |
| \`03_OUTPUT/\` | 내보낸 산출물 |
| \`09_TEMPLATES/\` | 이 파일과 분류 |

**쓸 수 있는 경로는 \`02_NOTES/\` 아래뿐이다.**
\`02_NOTES/{sources,entities,concepts,synthesis}/이름.md\` 형식이 아니면 관문 2 가 막는다.

## 페이지 형식

- YAML front-matter 로 시작한다
- 모든 주장에 앵커 인용을 붙인다: \`[^src-kickoff#slide-12]\`
- 출처 없는 문장은 쓰지 않는다

## 열람 등급

\`classification\` 은 넷 중 하나다. 빠뜨리면 \`internal\` 로 본다.

- \`public\` — 사외 공개 가능
- \`internal\` — 사내 전용 (기본값)
- \`confidential\` — 기밀
- \`restricted\` — 제한. 지정된 사람만

**인용이 등급을 끌어올린다.** 기밀 원본을 인용한 페이지는 기밀 이상이어야 한다.
낮추면 관문 9 가 막는다.

## 문서 장르

\`doc_genre\` 는 원래 문서가 무엇인가다. 해당이 없으면 \`null\` 로 둔다.
\`guideline\` \`factsheet\` \`report\` \`intelligence\` \`meeting\` 중 하나이고, 여기 없는 것은
\`tags\` 에 적는다.

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
  await fs.writeFile(safeJoin(root, `${TEMPLATES_DIR}/AGENTS.md`), AGENTS_MD, 'utf8');
  await fs.writeFile(safeJoin(root, `${TEMPLATES_DIR}/taxonomy.md`), TAXONOMY_MD, 'utf8');
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

/**
 * 허브 주소를 바꿔 적는다. **토큰은 여기 넣지 않는다** — Vault 폴더는 통째로 복사되거나
 * 백업될 수 있고 그러면 토큰이 같이 나간다. 토큰은 OS 자격 증명 저장소에만 둔다.
 */
export async function setHub(vault: Vault, hub: string | null): Promise<Vault> {
  if (hub !== null && vault.config.id === PERSONAL_ID) throw new Error('개인 Vault 는 허브에 붙이지 않습니다');
  const config: VaultConfig = { ...vault.config, hub };
  await fs.writeFile(safeJoin(vault.root, CONFIG_PATH), JSON.stringify(config, null, 2), 'utf8');
  return { root: vault.root, config };
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
  const dest = safeJoin(vault.root, SOURCES_DIR, path.basename(filePath));
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
