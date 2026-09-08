// 로컬 모델 질의 경로. docs/LOCAL-LLM.md §2.2 의 구조를 검사한다.
//
// **Ollama 를 실제로 안 부른다.** 가짜 fetch 를 물려서 앱 쪽 판정만 본다 —
// 모델이 무엇을 내는지는 사내 PC 에서 재는 것이고(W-O3 · W-O4), 여기서 볼 것은
// 그 답을 받았을 때 앱이 무엇을 하느냐다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/main/store.ts';
import { Ollama, pickModel } from '../src/core/local/ollama.ts';
import { allowedAnchors, chunkPage, localPrompt, nearest, normalize, queryTerms, rrf } from '../src/core/local/index.ts';
import { chunkHash, readVectors, reusable, writeVectors } from '../src/core/local/file.ts';
import { parsePage } from '../src/core/page.ts';
import { createVault } from '../src/core/vault.ts';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sb-local-'));

const FRONT = [
  '---',
  'id: ent-acme',
  'type: entity',
  'title: 에이콤',
  'summary: 주 협력사.',
  'classification: internal',
  'generated_by: claude-code',
  'updated: 2026-09-05T00:00:00.000Z',
  'updated_by: app',
  '---',
].join('\n');

const page = (body: string) => parsePage(`${FRONT}\n${body}\n`);

/* ---------- 자르기 ---------- */

test('문단 안에서 자르지 않는다. 인용이 그 문장과 같은 조각에 남는다', () => {
  // 목표 길이를 혼자서 넘기는 문단. 이래야 다음 문단이 다른 조각으로 간다
  const long = '가'.repeat(800);
  const p = page(`\n${long}\n\n계약 갱신일은 3월 31일이다.[^src-kickoff#slide-12]\n\n${long}\n`);
  const cs = chunkPage('02_NOTES/entities/acme.md', p);
  assert.ok(cs.length >= 2, `조각이 ${cs.length}개다`);
  const owner = cs.find((c) => c.text.includes('갱신일'));
  assert.ok(owner, '인용이 붙은 문단이 사라졌다');
  assert.ok(owner.text.includes('[^src-kickoff#slide-12]'), '인용이 문장에서 떨어져 나갔다');
});

test('본문이 비면 요약이라도 조각으로 남는다', () => {
  const cs = chunkPage('02_NOTES/entities/acme.md', page('\n'));
  assert.equal(cs.length, 1);
  assert.equal(cs[0]?.text, '주 협력사.');
});

test('준 조각에 있는 앵커만 허용한다', () => {
  const cs = chunkPage('p.md', page('\n가.[^src-a#s-1]\n\n나.[^src-b#s-2]\n'));
  const a = allowedAnchors(cs);
  assert.ok(a.has('src-a#s-1'));
  assert.ok(a.has('src-b#s-2'));
  assert.ok(!a.has('src-a#s-99'));
});

/* ---------- 낱말 가르기 ---------- */

test('조사를 뗀 것도 같이 묻는다. 1자는 안 묻는다', () => {
  const t = queryTerms('계약 갱신일은 언제인가?');
  assert.ok(t.includes('갱신일은'), JSON.stringify(t));
  assert.ok(t.includes('갱신일'), '조사를 뗀 것이 없다');
  assert.ok(!t.some((x) => [...x].length < 2), '1자가 섞였다');
});

test('같은 낱말을 두 번 묻지 않는다', () => {
  const t = queryTerms('계약 계약 계약');
  assert.deepEqual(t, ['계약']);
});

/* ---------- 합치기 ---------- */

test('두 목록에 다 있는 것이 위로 온다', () => {
  const r = rrf([
    ['a', 'b'],
    ['b', 'c'],
  ]);
  assert.equal(r[0]?.key, 'b', JSON.stringify(r));
});

test('한쪽에만 걸린 것도 살아남는다', () => {
  const r = rrf([['a'], ['z']]).map((x) => x.key);
  assert.deepEqual(r.sort(), ['a', 'z']);
});

/* ---------- 벡터 ---------- */

test('정규화하면 자기 자신과의 내적이 1 이다', () => {
  const v = normalize(Float32Array.from([3, 4]));
  assert.ok(Math.abs(v[0]! * v[0]! + v[1]! * v[1]! - 1) < 1e-6);
});

test('가까운 것부터 준다. 차원이 다른 것은 건너뛴다', () => {
  const vs = new Map([
    ['a', normalize(Float32Array.from([1, 0]))],
    ['b', normalize(Float32Array.from([0, 1]))],
    ['c', Float32Array.from([1, 0, 0])],
  ]);
  assert.deepEqual(nearest(normalize(Float32Array.from([0.9, 0.1])), vs, 5), ['a', 'b']);
});

test('벡터 파일은 왕복해도 값이 같다', async () => {
  const v = await createVault(await tmp(), { id: 'x', title: 'x', hub: null });
  const vec = normalize(Float32Array.from([1, 2, 3, 4]));
  await writeVectors(v, { model: 'bge-m3', dim: 4, entries: new Map([['k#0', { hash: 'h', vec }]]) });
  const back = await readVectors(v);
  assert.ok(back, '다시 못 읽었다');
  assert.equal(back.dim, 4);
  assert.equal(back.entries.get('k#0')?.hash, 'h');
  assert.deepEqual([...back.entries.get('k#0')!.vec], [...vec]);
});

test('모델을 바꾸면 예전 벡터를 안 쓴다', () => {
  const prev = { model: 'bge-m3', dim: 4, entries: new Map([['a', { hash: 'h', vec: new Float32Array(4) }]]) };
  assert.equal(reusable(prev, 'bge-m3').entries.size, 1);
  assert.equal(reusable(prev, 'other').entries.size, 0);
});

test('같은 글은 같은 해시다', () => {
  assert.equal(chunkHash('가나다'), chunkHash('가나다'));
  assert.notEqual(chunkHash('가나다'), chunkHash('가나다라'));
});

/* ---------- Ollama 클라이언트 ---------- */

test('태그가 붙은 이름을 알아본다', () => {
  assert.equal(pickModel(['qwen2.5:7b', 'bge-m3:latest'], 'qwen2.5'), 'qwen2.5:7b');
  assert.equal(pickModel(['qwen2.5:7b'], 'llama3'), null);
});

/** 원하는 대로 답하는 가짜 Ollama */
function fakeOllama(opts: {
  models?: string[];
  chat?: unknown;
  embedDim?: number;
  down?: boolean;
}): typeof globalThis.fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (opts.down) throw new Error('connect ECONNREFUSED');
    if (u.endsWith('/api/tags')) {
      return new Response(JSON.stringify({ models: (opts.models ?? []).map((name) => ({ name })) }), { status: 200 });
    }
    if (u.endsWith('/api/embed')) {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      const dim = opts.embedDim ?? 4;
      // 글자 코드로 만든 결정적인 벡터. 같은 글은 같은 벡터가 된다
      const vecs = body.input.map((t) => {
        const v = new Array(dim).fill(0);
        for (const [i, ch] of [...t].entries()) v[i % dim] += ch.codePointAt(0)! / 1000;
        return v;
      });
      return new Response(JSON.stringify({ embeddings: vecs }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: { content: JSON.stringify(opts.chat ?? {}) } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
}

test('못 붙으면 사유를 문장으로 준다', async () => {
  const st = await new Ollama({ host: 'http://x', chatModel: 'qwen2.5', embedModel: 'bge-m3' }, fakeOllama({ down: true })).status();
  assert.equal(st.ok, false);
  assert.match(st.error ?? '', /못 붙었습니다/);
});

test('모델이 없으면 무엇이 없는지 적는다', async () => {
  const st = await new Ollama(
    { host: 'http://x', chatModel: 'qwen2.5', embedModel: 'bge-m3' },
    fakeOllama({ models: ['qwen2.5:7b'] }),
  ).status();
  assert.equal(st.ok, false);
  assert.match(st.error ?? '', /bge-m3/);
});

test('벡터 수가 입력과 다르면 실패로 본다', async () => {
  const f = (async () => new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 })) as unknown as typeof globalThis.fetch;
  const r = await new Ollama({ host: 'http://x', chatModel: 'a', embedModel: 'b' }, f).embed('b', ['가', '나']);
  assert.equal(r.ok, false);
});

/* ---------- 앱이 붙였을 때 ---------- */

async function withWiki(fetchImpl: typeof globalThis.fetch) {
  const root = await tmp();
  const s = new Store({ localFetch: fetchImpl });
  await s.open(root, { id: '로컬', title: '로컬' });
  await fs.mkdir(path.join(root, '02_NOTES/entities'), { recursive: true });
  await fs.writeFile(
    path.join(root, '02_NOTES/entities/acme.md'),
    `${FRONT}\n\n계약 갱신일은 3월 31일이다.[^src-kickoff#slide-12]\n`,
    'utf8',
  );
  await s.setAnswerWith('local');
  return { s, root };
}

const MODELS = ['qwen2.5:7b', 'bge-m3:latest'];

test('로컬로 고르면 묻기가 로컬로 간다. 임베딩이 없어도 답이 나온다', async () => {
  const { s } = await withWiki(
    fakeOllama({
      models: MODELS,
      chat: { answer: '3월 31일입니다.', claims: [{ text: '갱신일은 3월 31일이다.', source: 'src-kickoff#slide-12' }] },
    }),
  );
  const r = await s.ask('계약 갱신일은 언제인가');
  assert.equal(r.ok, true, r.ok ? '' : r.error);
  if (r.ok) {
    assert.equal(r.costUsd, 0, '로컬인데 돈이 들었다고 적혔다');
    assert.equal(r.answer.claims[0]?.source, 'src-kickoff#slide-12');
  }
  s.close();
});

test('준 조각에 없는 앵커를 인용하면 답을 통째로 거부한다', async () => {
  const { s } = await withWiki(
    fakeOllama({
      models: MODELS,
      chat: { answer: '아무 말.', claims: [{ text: '지어낸 것.', source: 'src-없음#p-99' }] },
    }),
  );
  const r = await s.ask('계약 갱신일은 언제인가');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /없는 앵커/);
  s.close();
});

test('Ollama 가 꺼져 있으면 사유를 그대로 준다', async () => {
  const { s } = await withWiki(fakeOllama({ down: true }));
  const r = await s.ask('계약 갱신일은 언제인가');
  assert.equal(r.ok, false);
  s.close();
});

test('임베딩을 만들면 두 번째에는 다시 안 만든다', async () => {
  const { s } = await withWiki(fakeOllama({ models: MODELS, embedDim: 8 }));
  const first = await s.buildVectors();
  assert.equal(first.ok, true, first.ok ? '' : first.error);
  if (first.ok) assert.ok(first.made > 0, '아무것도 안 만들었다');
  const second = await s.buildVectors();
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.made, 0, '본문이 그대로인데 다시 만들었다');
  s.close();
});

test('상태에 조각 수와 임베딩 수를 같이 준다', async () => {
  const { s } = await withWiki(fakeOllama({ models: MODELS, embedDim: 8 }));
  const before = await s.localInfo();
  assert.equal(before.status.ok, true);
  assert.ok(before.chunks > 0);
  assert.equal(before.vectors, 0);
  await s.buildVectors();
  assert.equal((await s.localInfo()).vectors, before.chunks);
  s.close();
});

test('프롬프트에 조각과 질문이 다 들어간다', () => {
  const cs = chunkPage('p.md', page('\n계약 갱신일은 3월 31일이다.[^src-kickoff#slide-12]\n'));
  const p = localPrompt('갱신일은?', cs);
  assert.match(p, /조각 1/);
  assert.match(p, /src-kickoff#slide-12/);
  assert.match(p, /갱신일은\?/);
});

test('Vault 를 안 열어도 상태를 물어볼 수 있다. 설정 화면이 그때도 열린다', async () => {
  const s = new Store({ localFetch: fakeOllama({ models: MODELS }) });
  const info = await s.localInfo();
  assert.equal(info.status.ok, true);
  assert.equal(info.chunks, 0);
  assert.equal(info.vectors, 0);
});
