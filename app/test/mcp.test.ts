import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { handle, serve, type ToolDef } from '../src/core/mcp/server.ts';
import { wikiTools } from '../src/core/mcp/tools.ts';
import { ALLOWED_TOOLS, SERVER_NAME, TOOL_NAMES, mcpConfig } from '../src/core/mcp/config.ts';
import { createVault, type Vault } from '../src/core/vault.ts';
import { serializePage } from '../src/core/page.ts';

const INFO = { name: 'co-secondbrain', version: '0.1.0' };
const ok: ToolDef = {
  name: 'ok', description: '테스트', inputSchema: { type: 'object' },
  run: async (a) => `받음 ${JSON.stringify(a)}`,
};
const boom: ToolDef = {
  name: 'boom', description: '터짐', inputSchema: { type: 'object' },
  run: async () => { throw new Error('없는 페이지입니다'); },
};

/* ---------------- 프로토콜 ---------------- */

test('initialize — 클라이언트가 말한 판본을 그대로 돌려준다', async () => {
  // 2026-09-05 실측: claude 2.1.261 이 2025-11-25 로 붙었다
  const r = (await handle({ id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, [ok], INFO)) as {
    result: { protocolVersion: string; capabilities: object; serverInfo: object };
  };
  assert.equal(r.result.protocolVersion, '2025-11-25');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.deepEqual(r.result.serverInfo, INFO);
});

test('initialize — 판본을 안 주면 아는 값으로 답한다', async () => {
  const r = (await handle({ id: 0, method: 'initialize' }, [ok], INFO)) as { result: { protocolVersion: string } };
  assert.match(r.result.protocolVersion, /^\d{4}-\d{2}-\d{2}$/);
});

test('알림에는 답하지 않는다 — id 가 없다', async () => {
  assert.equal(await handle({ method: 'notifications/initialized' }, [ok], INFO), null);
});

test('tools/list — 이름·설명·스키마를 그대로 낸다', async () => {
  const r = (await handle({ id: 1, method: 'tools/list' }, [ok, boom], INFO)) as { result: { tools: { name: string }[] } };
  assert.deepEqual(r.result.tools.map((t) => t.name), ['ok', 'boom']);
});

test('tools/call — 결과는 text 내용이다', async () => {
  const r = (await handle({ id: 2, method: 'tools/call', params: { name: 'ok', arguments: { q: '가' } } }, [ok], INFO)) as {
    result: { content: { type: string; text: string }[] };
  };
  assert.deepEqual(r.result.content, [{ type: 'text', text: '받음 {"q":"가"}' }]);
});

test('tools/call — arguments 가 없어도 돈다', async () => {
  const r = (await handle({ id: 2, method: 'tools/call', params: { name: 'ok' } }, [ok], INFO)) as {
    result: { content: { text: string }[] };
  };
  assert.equal(r.result.content[0]!.text, '받음 {}');
});

test('도구가 던지면 프로토콜 오류가 아니라 내용으로 돌려준다 — 모델이 읽고 고친다', async () => {
  const r = (await handle({ id: 3, method: 'tools/call', params: { name: 'boom' } }, [boom], INFO)) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0]!.text, /없는 페이지/);
});

test('없는 도구와 없는 메서드는 JSON-RPC 오류다', async () => {
  for (const msg of [{ id: 4, method: 'tools/call', params: { name: '없음' } }, { id: 5, method: '없는메서드' }]) {
    const r = (await handle(msg, [ok], INFO)) as { error: { code: number } };
    assert.equal(r.error.code, -32601);
  }
});

test('ping 에 답한다', async () => {
  assert.deepEqual(await handle({ id: 6, method: 'ping' }, [ok], INFO), { jsonrpc: '2.0', id: 6, result: {} });
});

/* ---------------- 줄 프레이밍 ---------------- */

async function roundTrip(input: string): Promise<string[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: string[] = [];
  stdout.on('data', (c: Buffer) => out.push(...String(c).split('\n').filter(Boolean)));
  serve([ok], INFO, stdin, stdout);
  stdin.write(input);
  stdin.end();
  await new Promise((r) => setTimeout(r, 30));
  return out;
}

test('한 덩어리에 여러 줄이 와도 각각 답한다', async () => {
  const lines = await roundTrip(
    `${JSON.stringify({ id: 1, method: 'ping' })}\n${JSON.stringify({ id: 2, method: 'ping' })}\n`,
  );
  assert.deepEqual(lines.map((l) => JSON.parse(l).id), [1, 2]);
});

test('줄이 덩어리 사이에서 잘려도 이어 붙인다', async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const out: string[] = [];
  stdout.on('data', (c: Buffer) => out.push(String(c).trim()));
  serve([ok], INFO, stdin, stdout);
  const msg = JSON.stringify({ id: 9, method: 'ping' });
  stdin.write(msg.slice(0, 5));
  stdin.write(`${msg.slice(5)}\n`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(JSON.parse(out.join('')).id, 9);
});

test('빈 줄은 무시하고 깨진 JSON 은 오류로 답한다', async () => {
  const lines = await roundTrip(`\n\n망가짐\n`);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).error.code, -32603);
});

/* ---------------- 도구 ---------------- */

const page = (id: string, title: string, body: string, summary = '') =>
  serializePage({
    front: {
      id, type: 'entity', title, summary, aliases: [], tags: [], claims: [],
      classification: 'internal', docGenre: null,
      openQuestions: [], derivedFrom: null, generatedBy: 'claude-code',
      updated: '2026-09-05T00:00:00.000Z', updatedBy: 'app',
    },
    body: `\n# ${title}\n\n${body}\n`,
  });

async function wiki(): Promise<Vault> {
  const v = await createVault(await fs.mkdtemp(path.join(os.tmpdir(), 'sb-mcp-')), { id: 'p', title: 'P', hub: null });
  const w = (n: string, c: string) => fs.writeFile(path.join(v.root, '02_NOTES/entities', n), c, 'utf8');
  await w('acme.md', page('ent-acme', '에이콤', '[[entities/beta|베타테크]] 와 거래한다.', '주 협력사.'));
  await w('beta.md', page('ent-beta', '베타테크', '[[entities/gamma|감마]] 에 납품한다.'));
  await w('gamma.md', page('ent-gamma', '감마', '납품을 받는다. 운송비가 오른다.'));
  await w('delta.md', page('ent-delta', '델타', '아무와도 안 이어진다.'));
  return v;
}

const call = async (v: Vault, name: string, args: Record<string, unknown>) => {
  const t = wikiTools(v).find((x) => x.name === name)!;
  return t.run(args);
};

test('search — 제목이 본문보다 먼저 걸린다', async () => {
  const v = await wiki();
  assert.match(await call(v, 'search', { query: '에이콤' }), /02_NOTES\/entities\/acme\.md — 에이콤 · 주 협력사\./);
  const r = await call(v, 'search', { query: '운송비' });
  assert.match(r, /gamma\.md/);
  assert.equal(await call(v, 'search', { query: '없는말' }), '결과가 없습니다.');
});

test('search — 빈 질의는 던진다', async () => {
  const v = await wiki();
  await assert.rejects(() => call(v, 'search', { query: '  ' }), /query 가 필요합니다/);
});

test('get_page — 전문을 돌려주고 없는 페이지는 던진다', async () => {
  const v = await wiki();
  const r = await call(v, 'get_page', { path: '02_NOTES/entities/acme.md' });
  assert.match(r, /에이콤/);
  assert.match(r, /베타테크/);
  await assert.rejects(() => call(v, 'get_page', { path: '02_NOTES/entities/없음.md' }), /없는 페이지/);
});

test('get_page — wiki 밖은 못 읽는다. 이걸 안 막으면 금고 전체가 샌다', async () => {
  const v = await wiki();
  for (const bad of ['../../etc/passwd', '.sb/config.json', 'sources/킥오프.pptx', '/etc/passwd', '02_NOTES/../.sb/config.json']) {
    await assert.rejects(() => call(v, 'get_page', { path: bad }), /읽을 수 없는 경로/, bad);
  }
});

test('neighbors — 링크로 이어진 페이지만 낸다', async () => {
  const v = await wiki();
  const r = await call(v, 'neighbors', { path: '02_NOTES/entities/beta.md' });
  assert.match(r, /acme\.md/);
  assert.match(r, /gamma\.md/);
  assert.equal(await call(v, 'neighbors', { path: '02_NOTES/entities/delta.md' }), '이어진 페이지가 없습니다.');
});

test('path — 최단 경로를 제목으로 낸다', async () => {
  const v = await wiki();
  assert.equal(await call(v, 'path', { from: '02_NOTES/entities/acme.md', to: '02_NOTES/entities/gamma.md' }), '에이콤 → 베타테크 → 감마');
  assert.equal(await call(v, 'path', { from: '02_NOTES/entities/acme.md', to: '02_NOTES/entities/acme.md' }), '에이콤');
  assert.equal(await call(v, 'path', { from: '02_NOTES/entities/acme.md', to: '02_NOTES/entities/delta.md' }), '이어지는 경로가 없습니다.');
});

test('승인 직후의 변경이 바로 보인다 — 호출할 때마다 디스크를 다시 읽는다', async () => {
  const v = await wiki();
  assert.equal(await call(v, 'search', { query: '새페이지' }), '결과가 없습니다.');
  await fs.writeFile(path.join(v.root, '02_NOTES/entities/new.md'), page('ent-new', '새페이지', '방금 승인됐다.'), 'utf8');
  assert.match(await call(v, 'search', { query: '새페이지' }), /new\.md/);
});

/* ---------------- 설정 ---------------- */

test('도구 이름이 CLI 규약(mcp__서버__도구)과 맞는다', () => {
  assert.deepEqual(ALLOWED_TOOLS, ['search', 'get_page', 'neighbors', 'path'].map((t) => `mcp__${SERVER_NAME}__${t}`));
  assert.deepEqual([...TOOL_NAMES].sort(), ['get_page', 'neighbors', 'path', 'search']);
});

test('노출한 도구와 설정의 허용 목록이 같다 — 하나가 빠지면 CLI 가 거부한다', async () => {
  const v = await wiki();
  assert.deepEqual(wikiTools(v).map((t) => t.name).sort(), [...TOOL_NAMES].sort());
});

test('mcpConfig — 호출 단위 설정 모양', () => {
  const c = mcpConfig({ command: '/bin/electron', args: ['/app/mcp.js', '/vault'], env: { ELECTRON_RUN_AS_NODE: '1' } }) as {
    mcpServers: Record<string, { command: string; args: string[]; env: object }>;
  };
  assert.deepEqual(c.mcpServers[SERVER_NAME], {
    command: '/bin/electron', args: ['/app/mcp.js', '/vault'], env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.equal('env' in (mcpConfig({ command: 'node', args: [] }) as { mcpServers: Record<string, object> }).mcpServers[SERVER_NAME]!, false);
});
