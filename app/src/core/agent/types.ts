// LLM CLI 어댑터의 공통 계약. PLAN.md §7
//
// 어댑터는 **ChangeSet 을 받아오기만 한다.** 디스크에 쓰는 건 changeset.ts 의 관문을
// 통과한 뒤 applyChangeSet 이 한다. 이 파일에는 fs 쓰기가 없다.

export type ProviderId = 'claude-code' | 'gemini' | 'codex';

/** 한 번 호출의 과금 내역. M2-PLAN.md §2 — 이 값으로 지출 계량기를 돌린다. */
export interface Usage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** 콜드 실행에서 비용의 거의 전부를 차지한다 (실측 28,194 토큰) */
  cacheCreationTokens: number;
  /** 세션 재개하면 위 값이 이쪽으로 옮겨 온다 */
  cacheReadTokens: number;
}

export const ZERO_USAGE: Usage = {
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    costUsd: a.costUsd + b.costUsd,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export interface AgentJob {
  /** 격리 작업 디렉터리. CLI 는 여기를 cwd 로 돈다 */
  workdir: string;
  prompt: string;
  /**
   * 이어 붙일 세션 id. 넘기면 cache 생성이 cache 읽기로 바뀐다
   * (M0 §7.1.1 — $0.130 → $0.049). 배치의 두 번째 문서부터 넘긴다.
   */
  resumeSessionId?: string | null;
  /**
   * 읽기 경로에서만 쓴다 (PLAN.md §7.2 안 B). 에이전트가 위키를 당겨 갈 수 있게
   * 내장 MCP 서버를 붙인다. 쓰기 경로에는 붙이지 않는다 — 도구로 디스크에 닿으면
   * "사람 승인 전에는 안 쓴다" 는 원칙을 지킬 수 없다.
   */
  mcp?: { configPath: string; allowedTools: readonly string[] };
  /**
   * B등급(스키마 강제 불가) 공급자가 다시 물을지 정할 때 쓴다. `null` 이면 통과,
   * 문자열이면 그 사유를 붙여 한 번 다시 묻는다.
   *
   * **어댑터가 모양을 넘겨짚지 않는다.** 예전에는 무조건 ChangeSet 으로 검증해서
   * Lint 판단 검사 응답이 항상 거부됐다.
   */
  validate?: (data: unknown) => string | null;
}

export interface AgentResult {
  ok: boolean;
  /**
   * A등급이면 CLI 가 스키마를 강제한 결과, B등급이면 앱이 파싱한 결과.
   * **여기서는 검증하지 않는다** — changeset.ts 의 관문이 판정한다.
   */
  data: unknown;
  /** 다음 호출에 resumeSessionId 로 넘길 값 */
  sessionId: string | null;
  usage: Usage;
  /** ok === false 일 때만 채운다 */
  error?: string;
  /** 녹화용 원시 stdout. 사내 PC 응답을 픽스처로 커밋할 때 쓴다 */
  raw: string;
}

export interface AgentCli {
  id: ProviderId;
  /** CLI 가 스키마를 강제하는가. Claude Code·Codex true, Gemini false (PLAN.md §7.1) */
  supportsSchema: boolean;
  /** 작업 디렉터리에 놓을 규약 파일 이름. CLI 마다 찾는 이름이 다르다 (PLAN.md §7.3) */
  conventionFile: 'CLAUDE.md' | 'AGENTS.md' | 'GEMINI.md';
  detect(): Promise<{ found: boolean; version?: string }>;
  run(job: AgentJob, schema: object): Promise<AgentResult>;
}

/** 서브프로세스 실행. 테스트에서 픽스처로 갈아 끼운다. */
export type Exec = (
  bin: string,
  argv: readonly string[],
  /** `stdin` 으로 프롬프트를 넘긴다 — Windows argv 인용부호를 피한다 (agent/exec.ts) */
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string },
) => Promise<{ stdout: string; stderr: string; code: number }>;
