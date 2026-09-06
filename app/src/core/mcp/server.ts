// 내장 MCP 서버 — 읽기 전용. PLAN.md §7.2 안 B
//
// **외부 연동이 아니다.** MCP 는 프로토콜이지 서비스가 아니고 이 서버는 우리 실행 파일의
// 일부다. 외부로 나가는 통로는 여전히 `CLI → api.anthropic.com` 하나뿐이다.
//
// SDK 를 쓰지 않는다. 필요한 건 JSON-RPC 세 개(`initialize` · `tools/list` · `tools/call`)뿐이고,
// 오프라인 사내 설치에서 의존성 하나가 곧 배포 비용이다.
//
// 2026-09-05 실측: `claude` 2.1.261 이 protocolVersion `2025-11-25` 로 붙었고
// 도구 호출까지 성공했다. 클라이언트가 보낸 판본을 그대로 돌려준다.
import type { Readable, Writable } from 'node:stream';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema. CLI 가 모델에게 그대로 보여준다 */
  inputSchema: object;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface RpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
}

export interface ServerInfo {
  name: string;
  version: string;
}

const FALLBACK_PROTOCOL = '2025-11-25';

/** JSON-RPC 오류 코드. 필요한 두 개만 쓴다. */
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

/**
 * 요청 하나를 응답 하나로 바꾼다. 알림(id 없음)이면 `null` 이다.
 * 스트림을 안 건드리므로 테스트가 프로세스를 띄우지 않아도 된다.
 */
export async function handle(msg: RpcMessage, tools: readonly ToolDef[], info: ServerInfo): Promise<object | null> {
  if (msg.id === undefined) return null; // 알림에는 답하지 않는다
  const reply = (result: object) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });

  switch (msg.method) {
    case 'initialize':
      return reply({
        // 클라이언트가 말한 판본을 그대로 쓴다. 우리가 고집할 이유가 없다
        protocolVersion: (msg.params?.['protocolVersion'] as string) ?? FALLBACK_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: info,
      });

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({
        tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });

    case 'tools/call': {
      const name = msg.params?.['name'] as string;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(METHOD_NOT_FOUND, `없는 도구입니다: ${name}`);
      try {
        const text = await tool.run((msg.params?.['arguments'] as Record<string, unknown>) ?? {});
        return reply({ content: [{ type: 'text', text }] });
      } catch (e) {
        // 도구 실패는 프로토콜 오류가 아니다. 모델이 읽고 고칠 수 있게 내용으로 돌려준다.
        return reply({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }

    default:
      return fail(METHOD_NOT_FOUND, `없는 메서드입니다: ${msg.method}`);
  }
}

/** 줄 단위 JSON-RPC. stdio 로 붙는다. */
export function serve(tools: readonly ToolDef[], info: ServerInfo, stdin: Readable, stdout: Writable): void {
  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      void (async () => {
        let msg: RpcMessage;
        try {
          msg = JSON.parse(line) as RpcMessage;
        } catch {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: INTERNAL_ERROR, message: 'JSON 이 아닙니다' } })}\n`);
          return;
        }
        const res = await handle(msg, tools, info);
        if (res) stdout.write(`${JSON.stringify(res)}\n`);
      })();
    }
  });
}
