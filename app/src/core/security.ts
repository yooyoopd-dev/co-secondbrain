// 외부 입력이 통과하는 단일 관문. PLAN.md §9.2
//
// 가장 중요한 것: **LLM 이 쓴 페이지 제목이 곧 파일 이름이 된다.**
// 모델이 `../../../Windows/System32/...` 같은 제목을 내면 경로 탈출이다.
// M0 에서 공격 문자열 14종으로 검증했다 (탈출 0건).
import path from 'node:path';

// C0/C1 제어문자 + zero-width + BiDi 제어 + BOM
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_SLUG = 80;

/** 제목을 파일명으로 쓸 수 있는 형태로 만든다. 절대 경로 구분자를 남기지 않는다. */
export function slugify(title: string): string {
  let s = String(title).normalize('NFKC');
  s = s.replace(INVISIBLE, '');
  s = s.replace(/[/\\]/g, '-'); // 경로 구분자
  s = s.replace(/[<>:"|?*]/g, ''); // Windows 금지 문자
  s = s.replace(/\.+/g, '.').replace(/^\.+|\.+$/g, ''); // 연속·선후행 마침표 → `..` 무력화
  s = s.replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  s = [...s].slice(0, MAX_SLUG).join('');
  return s || 'untitled';
}

/** Vault 안으로 resolve 되는 경로만 돌려준다. 벗어나면 던진다. */
export function safeJoin(vaultRoot: string, ...segments: string[]): string {
  const full = path.resolve(vaultRoot, ...segments);
  const root = path.resolve(vaultRoot) + path.sep;
  if (full !== path.resolve(vaultRoot) && !full.startsWith(root)) {
    throw new Error(`경로 탈출 차단: ${full}`);
  }
  return full;
}

/** 제목으로 Vault 안의 마크다운 경로를 만든다. slugify + 탈출 검사 이중 방어. */
export function safePagePath(vaultRoot: string, relDir: string, title: string): string {
  return safeJoin(vaultRoot, relDir, `${slugify(title)}.md`);
}

/** 원본 id — 파일명에서 만든다. 앵커 인용의 왼쪽 절반이 된다. */
export function sourceIdFrom(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const slug = slugify(base)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `src-${slug || 'untitled'}`;
}
