// W1 검증용 최소 stdio MCP 서버.
//
// 이전 스크립트는 `node -e "0"` 을 서버로 등록했는데, 즉시 종료하는 프로세스라
// 사내 정책과 무관하게 연결이 실패한다. 실제로 살아서 MCP 프로토콜을 말하는
// 서버가 있어야 "등록은 되는데 연결이 막히는가"를 구분할 수 있다.
//
// 전송: stdio, 줄 단위 JSON-RPC 2.0 (MCP stdio 규약).
// 우리 앱이 실제로 띄울 내장 서버의 최소 골격이기도 하다.

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function handle(line) {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  const id = m.id;

  if (m.method === 'initialize') {
    // 클라이언트가 요청한 프로토콜 버전을 그대로 돌려준다.
    // 버전을 고정하면 클라이언트 버전이 올라갈 때 조용히 실패한다.
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: m.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'm0probe', version: '0.0.1' },
      },
    });
    return;
  }

  if (m.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          { name: 'm0_ping', description: 'W1 probe', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    });
    return;
  }

  if (m.method === 'tools/call') {
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pong' }] } });
    return;
  }

  // notifications/* 는 id가 없다 — 응답하지 않는다.
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
}
