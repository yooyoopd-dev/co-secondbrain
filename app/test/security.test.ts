import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { slugify, safeJoin, safePagePath, sourceIdFrom } from '../src/core/security.ts';

// M0 에서 쓴 공격 문자열 14종을 회귀 테스트로 고정한다 (탈출 0건이 통과 조건).
// 제어문자는 이스케이프 시퀀스로만 적는다 — 리터럴로 넣으면 소스가 깨진다.
const ATTACKS: [string, string][] = [
  ['../../../Windows/System32/drivers/etc/hosts', '경로 탈출'],
  ['..\\..\\..\\secrets', '역슬래시 탈출'],
  ['/etc/passwd', '절대 경로'],
  ['CON', 'Windows 예약어'],
  ['nul.md', '예약어 + 확장자'],
  ['aux', '예약어 소문자'],
  ['보고서\u0000.md', 'NUL 바이트'],
  ['제목\u200B숨김', 'zero-width'],
  ['\u202Eexe.txt', 'BiDi 확장자 위장'],
  ['a'.repeat(300), '초장문'],
  ['....', '마침표만'],
  ['   ', '공백만'],
  ['에이콤(주) 계약', '정상 한국어'],
  ['ACME Corp. — 2026 Q1', '정상 영문'],
];

test('공격 문자열 14종 전부 Vault 안으로 정규화된다', () => {
  // 기대값을 `/vault/...` 로 적으면 Windows 에서 헛돈다. 거기서는 `D:\vault\...` 로
  // resolve 되고 검사는 통과하는데 이 줄이 먼저 넘어진다. 구분자는 os 에게 맡긴다.
  const dir = path.resolve('/vault', '02_NOTES/entities') + path.sep;
  for (const [title, label] of ATTACKS) {
    const p = safePagePath('/vault', '02_NOTES/entities', title);
    assert.ok(p.startsWith(dir), `${label}: ${p}`);
    assert.ok(!p.includes('..'), `${label}: 상대 경로 조각이 남음 — ${p}`);
  }
});

test('Windows 예약어에 접두사가 붙는다', () => {
  assert.equal(slugify('CON'), '_CON');
  assert.equal(slugify('aux'), '_aux');
  assert.equal(slugify('nul.md'), '_nul.md');
});

test('빈 결과는 untitled 가 된다', () => {
  assert.equal(slugify('....'), 'untitled');
  assert.equal(slugify('   '), 'untitled');
  assert.equal(slugify('\u200B\u200B'), 'untitled');
});

test('길이 상한이 걸린다', () => {
  assert.ok([...slugify('가'.repeat(300))].length <= 80);
});

test('safeJoin 은 Vault 밖을 던진다', () => {
  assert.throws(() => safeJoin('/vault', '../etc/passwd'), /경로 탈출/);
  assert.throws(() => safeJoin('/vault', 'a', '..', '..', 'b'), /경로 탈출/);
  assert.doesNotThrow(() => safeJoin('/vault', '02_NOTES', 'entities'));
});

test('sourceId 는 앵커 인용에 쓸 수 있는 형태다', () => {
  assert.equal(sourceIdFrom('2026-09-03 킥오프 발표.pptx'), 'src-2026-09-03-킥오프-발표');
  assert.equal(sourceIdFrom('../../evil.docx'), 'src-evil');
  assert.ok(/^src-[a-z0-9가-힣-]+$/.test(sourceIdFrom('RE: 계약 갱신 일정.eml')));
});
