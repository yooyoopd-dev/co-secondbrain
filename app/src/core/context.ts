// 나의 기준 맥락 — LLM 이 "누가 왜 무엇을 위해" 쌓는 위키인지 알게 하는 세 문항.
//
// **금고 안 마크다운 파일 하나가 정본이다.** 앱 설정에 넣지 않은 이유가 두 가지다.
// 하나는 Obsidian 으로 열어 그대로 고칠 수 있어야 해서고, 하나는 이 내용이 프롬프트
// 접두사에 들어가기 때문이다 — 접두사는 배치 내내 같은 바이트여야 캐시가 산다
// (M2-PLAN.md §2.1). 파일이 안 바뀌면 바이트도 안 바뀐다.
//
// 위치는 `09_TEMPLATES/` 다. 동기화가 올리는 것은 `02_NOTES/` 아래 페이지뿐이라
// (sync/engine.ts `scanLocal`) **CO 영역에서도 이 파일은 동료에게 안 간다.**

/** 정본 위치. Vault 기준 상대 경로 */
export const CORE_CONTEXT_PATH = '09_TEMPLATES/me.md';

export interface CoreContext {
  /** 나는 누구인가 */
  who: string;
  /** 왜 기록하는가 */
  why: string;
  /** 어떤 산출물을 원하는가 */
  output: string;
}

export const EMPTY_CORE_CONTEXT: CoreContext = { who: '', why: '', output: '' };

/** 문항. 순서가 곧 파일의 절 순서이고 화면의 칸 순서다. */
export const CORE_CONTEXT_FIELDS = [
  { key: 'who', heading: '나는 누구인가', label: 'Who am I?', hint: '직무 · 담당 · 이 문서들을 다루는 자리' },
  { key: 'why', heading: '왜 기록하는가', label: 'Why record this?', hint: '이 금고로 무엇을 하려는가' },
  { key: 'output', heading: '어떤 산출물을 원하는가', label: 'What output do you want?', hint: '보고서 · 회의 준비 · 근거 추적 등' },
] as const satisfies readonly { key: keyof CoreContext; heading: string; label: string; hint: string }[];

const PREAMBLE = `# 나의 기준 맥락

이 파일은 LLM 호출의 앞머리에 그대로 들어간다. 위키를 누가 왜 쌓는지 알아야
같은 원본에서도 쓸모 있는 쪽을 고른다. 앱의 [내 맥락] 화면에서도, 여기서 바로도 고칠 수 있다.
`;

/** 세 문항을 파일 한 벌로 만든다. 빈 칸도 절은 남긴다 — 사람이 무엇을 적어야 하는지 봐야 한다. */
export function serializeCoreContext(ctx: CoreContext): string {
  const parts = [PREAMBLE];
  for (const f of CORE_CONTEXT_FIELDS) {
    const body = ctx[f.key].trim();
    parts.push(`\n## ${f.heading}\n\n${body || `_아직 안 적었습니다. ${f.hint}._`}\n`);
  }
  return parts.join('');
}

/**
 * 파일을 되읽는다. **못 알아본 절은 조용히 버린다** — 사람이 Obsidian 에서 자유롭게
 * 고쳐 쓸 파일이라, 형식이 어긋났다고 던지면 앱이 안 열린다.
 */
export function parseCoreContext(md: string): CoreContext {
  const out: CoreContext = { ...EMPTY_CORE_CONTEXT };
  for (const f of CORE_CONTEXT_FIELDS) {
    // 다음 `## ` 나 파일 끝까지가 한 절이다. 한글은 `\b` 가 안 먹으므로 줄머리로 끊는다 (CLAUDE.md §7)
    const re = new RegExp(String.raw`^##[ \t]+${f.heading}[ \t]*$([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))`, 'm');
    const body = re.exec(md)?.[1]?.trim() ?? '';
    out[f.key] = body.startsWith('_아직 안 적었습니다') ? '' : body;
  }
  return out;
}

export function isEmptyCoreContext(ctx: CoreContext): boolean {
  return CORE_CONTEXT_FIELDS.every((f) => !ctx[f.key].trim());
}

/**
 * 프롬프트에 얹을 블록. **비어 있으면 빈 문자열을 준다** — 안 적은 사람에게
 * "안 적었습니다" 세 줄을 매 호출 보내면 토큰만 쓰고 모델을 헷갈리게 한다.
 */
export function coreContextBlock(ctx: CoreContext): string {
  if (isEmptyCoreContext(ctx)) return '';
  const rows = CORE_CONTEXT_FIELDS.filter((f) => ctx[f.key].trim()).map((f) => `### ${f.heading}\n\n${ctx[f.key].trim()}`);
  return `## 이 위키를 쓰는 사람\n\n${rows.join('\n\n')}\n`;
}
