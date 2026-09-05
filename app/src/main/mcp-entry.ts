// 내장 MCP 서버의 stdio 진입점. CLI 가 이걸 서브프로세스로 띄운다.
//
// **stdout 에 JSON-RPC 말고 아무것도 쓰지 않는다.** 한 줄이라도 섞이면 프로토콜이 깨진다.
// 진단은 stderr 로 보낸다.
//
// 패키징본에서는 `node` 가 없으므로 Electron 자신을 `ELECTRON_RUN_AS_NODE=1` 로 띄운다
// (`core/mcp/config.ts` 의 McpLaunch).
import { serve } from '../core/mcp/server.ts';
import { wikiTools } from '../core/mcp/tools.ts';
import { openVault } from '../core/vault.ts';

const root = process.argv[2];
if (!root) {
  process.stderr.write('사용법: mcp-entry <vault 경로>\n');
  process.exit(2);
}

try {
  const vault = await openVault(root);
  serve(wikiTools(vault), { name: 'co-secondbrain', version: '0.1.0' }, process.stdin, process.stdout);
} catch (e) {
  process.stderr.write(`Vault 를 열지 못했습니다: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
