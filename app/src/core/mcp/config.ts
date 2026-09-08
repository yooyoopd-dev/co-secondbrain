// `--mcp-config` 로 넘길 설정. PLAN.md §7.2
//
// `claude mcp add`(전역 설정 파일에 기록) 대신 **호출 단위 설정**을 쓴다.
// 사내 PC 의 기존 MCP 설정을 건드리지 않고, `--strict-mcp-config` 가 기존 서버를 격리한다.
// 사내 1차 시도에서 이미 등록돼 있던 HTTP MCP 서버가 502 를 내 우리 호출까지 막은 적이 있다.

/** 설정 안의 서버 이름. 도구 이름이 `mcp__sb__search` 형태가 된다 */
export const SERVER_NAME = 'sb';

export const TOOL_NAMES = ['search', 'get_page', 'neighbors', 'path'] as const;

/** `--allowedTools` 에 넘길 이름. 이 목록 밖은 CLI 가 거부한다 */
export const ALLOWED_TOOLS: string[] = TOOL_NAMES.map((t) => `mcp__${SERVER_NAME}__${t}`);

export interface McpLaunch {
  /** 실행 파일. 패키징본에서는 Electron 자신이다 */
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * 설정 한 벌. 모양은 두 CLI 가 같다 — `mcpServers` 아래 이름 하나.
 *
 * `trust` 는 Gemini 것이다. 도구 호출마다 확인을 묻지 않게 한다 (`gemini mcp add --trust`
 * 가 쓰는 칸이다, 2026-09-09 실측). 우리 서버는 우리 실행 파일의 일부이고 읽기만 하므로
 * 물어볼 것이 없다. **Claude Code 쪽에는 안 붙인다** — 그 설정 스키마에 없는 칸이다.
 */
export function mcpConfig(launch: McpLaunch, trust = false): object {
  return {
    mcpServers: {
      [SERVER_NAME]: {
        command: launch.command,
        args: launch.args,
        ...(launch.env ? { env: launch.env } : {}),
        ...(trust ? { trust: true } : {}),
      },
    },
  };
}
