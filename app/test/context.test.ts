import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_CONTEXT_FIELDS,
  CORE_CONTEXT_PATH,
  EMPTY_CORE_CONTEXT,
  coreContextBlock,
  isEmptyCoreContext,
  parseCoreContext,
  serializeCoreContext,
} from '../src/core/context.ts';
import { conventionFile } from '../src/core/agent/ingest.ts';
import { questionPrompt } from '../src/core/query.ts';

const FILLED = {
  who: '구매팀 대리. 협력사 계약과 원가를 본다.',
  why: '분기 원가 검토 때 근거를 다시 찾느라 시간을 버린다.',
  output: '슬라이드에 그대로 붙일 수 있는 근거 딸린 한 문단.',
};

test('세 문항이 파일로 갔다가 그대로 돌아온다', () => {
  assert.deepEqual(parseCoreContext(serializeCoreContext(FILLED)), FILLED);
});

test('안 적은 칸의 안내 문구는 값으로 읽지 않는다', () => {
  const md = serializeCoreContext(EMPTY_CORE_CONTEXT);
  assert.match(md, /아직 안 적었습니다/);
  assert.deepEqual(parseCoreContext(md), EMPTY_CORE_CONTEXT);
});

test('일부만 적어도 적은 것만 돌아온다', () => {
  const one = { ...EMPTY_CORE_CONTEXT, why: '회의 준비를 줄이려고.' };
  assert.deepEqual(parseCoreContext(serializeCoreContext(one)), one);
});

test('여러 줄과 목록을 적어도 유지된다', () => {
  const long = { ...EMPTY_CORE_CONTEXT, output: '- 보고서 초안\n- 회의록 요약\n\n둘 다 인용이 붙어야 한다.' };
  assert.equal(parseCoreContext(serializeCoreContext(long)).output, long.output);
});

/* ---------------- 사람이 Obsidian 에서 고쳐 쓴 파일 ---------------- */

test('절 순서를 바꿔도 읽는다', () => {
  const md = ['## 왜 기록하는가', '', '나중에 못 찾아서.', '', '## 나는 누구인가', '', '구매팀.', ''].join('\n');
  const c = parseCoreContext(md);
  assert.equal(c.who, '구매팀.');
  assert.equal(c.why, '나중에 못 찾아서.');
  assert.equal(c.output, '');
});

test('모르는 절이 섞여 있어도 던지지 않는다', () => {
  const md = ['# 나의 기준 맥락', '', '## 메모', '', '아무거나.', '', '## 나는 누구인가', '', '구매팀.', ''].join('\n');
  assert.equal(parseCoreContext(md).who, '구매팀.');
});

test('빈 파일도 던지지 않는다', () => {
  assert.deepEqual(parseCoreContext(''), EMPTY_CORE_CONTEXT);
  assert.equal(isEmptyCoreContext(parseCoreContext('')), true);
});

/* ---------------- 프롬프트에 얹히는 방식 ---------------- */

test('안 적었으면 프롬프트에 한 글자도 안 붙는다', () => {
  // 접두사는 배치 내내 같은 바이트여야 캐시가 산다 (M2-PLAN.md §2.1).
  // 안 적은 사람에게 "안 적었습니다" 세 줄을 매번 보내면 토큰만 쓴다.
  assert.equal(coreContextBlock(EMPTY_CORE_CONTEXT), '');
  assert.equal(conventionFile('# 규약', coreContextBlock(EMPTY_CORE_CONTEXT)), conventionFile('# 규약'));
  assert.equal(questionPrompt('원가는?', coreContextBlock(EMPTY_CORE_CONTEXT)), questionPrompt('원가는?'));
});

test('적었으면 적은 칸만 프롬프트로 간다', () => {
  const block = coreContextBlock({ ...EMPTY_CORE_CONTEXT, who: '구매팀.' });
  assert.match(block, /## 이 위키를 쓰는 사람/);
  assert.match(block, /### 나는 누구인가\n\n구매팀\./);
  assert.equal(block.includes('왜 기록하는가'), false);
});

test('규약 파일과 질의 프롬프트 둘 다에 실린다', () => {
  const block = coreContextBlock(FILLED);
  assert.ok(conventionFile('# 규약', block).includes(block));
  assert.ok(questionPrompt('원가는?', block).includes(block));
});

/* ---------------- 자리 ---------------- */

test('정본은 동기화가 안 올리는 자리에 있다', () => {
  // sync/engine.ts scanLocal 은 02_NOTES/ 아래 페이지만 올린다.
  // 여기가 02_NOTES 로 옮겨 가면 CO 영역에서 개인 맥락이 동료에게 간다.
  assert.equal(CORE_CONTEXT_PATH.startsWith('09_TEMPLATES/'), true);
});

test('문항은 셋이고 화면과 파일이 같은 순서를 쓴다', () => {
  assert.deepEqual(
    CORE_CONTEXT_FIELDS.map((f) => f.key),
    ['who', 'why', 'output'],
  );
});
