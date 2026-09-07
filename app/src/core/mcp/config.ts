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

export function mcpConfig(launch: McpLaunch): object {
  return {
    mcpServers: {
      [SERVER_NAME]: { command: launch.command, args: launch.args, ...(launch.env ? { env: launch.env } : {}) },
    },
  };
}
