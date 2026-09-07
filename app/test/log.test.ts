import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogBuffer, describe, formatLog, redact } from '../src/core/log.ts';

/* ---------- 비식별 처리 ---------- */
// 이 로그는 클립보드로 나간다. 아래 검사가 실패하면 사내 문서 이름이 밖으로 나간다.

test('Windows 절대 경로에서 폴더와 파일 이름이 사라진다', () => {
  const out = redact('ENOENT: C:\\Users\\hong\\Desktop\\킥오프 발표.pptx 를 열지 못했습니다');
  assert.ok(!out.includes('hong'), out);
  assert.ok(!out.includes('킥오프'), out);
  assert.ok(!out.includes('Users'), out);
  assert.ok(out.includes('.pptx'), out); // 확장자는 남는다
  assert.match(out, /<파일 \d+자>\.pptx/);
});

test('POSIX 절대 경로도 같다', () => {
  const out = redact('/home/hong/vault/projects/2026 로드맵.docx 읽기 실패');
  assert.ok(!out.includes('로드맵'), out);
  assert.ok(!out.includes('/home/'), out);
  assert.match(out, /<파일 \d+자>\.docx/);
});

test('UNC 경로도 같다', () => {
  const out = redact('\\\\co-nas\\team\\원가 산출.xlsx');
  assert.ok(!out.includes('co-nas'), out);
  assert.ok(!out.includes('원가'), out);
});

test('경로 없이 이름만 나온 파일도 지운다', () => {
  const out = redact('킥오프 발표.pptx: 슬라이드 노트를 읽지 못했습니다');
  assert.ok(!out.includes('킥오프'), out);
  assert.match(out, /^<파일 6자>\.pptx:/, out);
});

test('글자 수는 코드 포인트로 센다 — 한글 한 글자가 1이다', () => {
  assert.match(redact('회의록.md'), /<파일 3자>\.md/);
});

test('토큰처럼 생긴 긴 문자열을 가린다', () => {
  const out = redact('401 Unauthorized (token=AQ.Ab8RN6Jw86ko0f9-VJrVzBiL-AEyiAy5LMDW)');
  assert.ok(!out.includes('AQ.Ab8RN6Jw86ko0f9'), out);
  assert.ok(out.includes('[가림]'), out);
});

test('이름이 붙은 비밀은 값이 짧아도 가린다', () => {
  for (const s of ['Authorization: Bearer abc123', 'password=hunter2', 'api_key: k1']) {
    const out = redact(s);
    assert.ok(out.includes('[가림]'), `${s} → ${out}`);
    assert.ok(!/abc123|hunter2|k1$/.test(out), `${s} → ${out}`);
  }
});

test('URL 은 출처만 남고 경로는 사라진다 — 경로에 페이지 이름이 들어간다', () => {
  const out = redact('PUT http://co-hub:8080/spaces/ACME/pages/원가-구조 → 409');
  assert.ok(out.includes('http://co-hub:8080/…'), out);
  assert.ok(!out.includes('원가-구조'), out);
  assert.ok(out.includes('409'), out);
});

test('파일명 앞의 낱말이 같이 지워질 수 있다 — 남기는 쪽보다 지우는 쪽으로 튼다', () => {
  // 공백이 든 파일명을 통째로 잡으려면 앞 낱말 두 개까지 삼킨다. 알고 고른 손해다.
  assert.equal(redact('슬라이드를 저장했습니다 회의록.md'), '<파일 16자>.md');
  // 파일명이 앞에 오면 뒤 문장은 온전하다
  assert.equal(redact('index.md 를 다시 조립했습니다'), '<파일 5자>.md 를 다시 조립했습니다');
});

test('허브 주소는 남는다 — 어디에 붙다 실패했는지가 사라지면 못 고친다', () => {
  assert.equal(
    redact('PUT http://co-hub:8080/spaces/ACME/pages/원가-구조 → 409 Conflict'),
    'PUT http://co-hub:8080/… → 409 Conflict',
  );
});

test('지울 것이 없으면 원문 그대로다', () => {
  const s = '변경안 3건 중 2건이 관문 4 에서 막혔습니다';
  assert.equal(redact(s), s);
});

/* ---------- Error 풀기 ---------- */

test('Error 는 이름과 메시지, 스택으로 갈린다', () => {
  const { message, detail } = describe(new TypeError('x 가 없습니다'));
  assert.equal(message, 'TypeError: x 가 없습니다');
  assert.ok(detail?.includes('log.test.ts'), detail);
});

test('Error 가 아닌 것도 받는다', () => {
  assert.equal(describe('그냥 문자열').message, '그냥 문자열');
  assert.equal(describe({ code: 409 }).message, '{"code":409}');
  assert.equal(describe(undefined).message, 'undefined');
});

/* ---------- 버퍼 ---------- */

test('상한을 넘으면 오래된 것부터 버린다', () => {
  const b = new LogBuffer(3);
  for (const n of [1, 2, 3, 4, 5]) b.add('info', 'test', `${n}`);
  assert.deepEqual(b.entries().map((e) => e.message), ['3', '4', '5']);
});

test('오류 건수는 버려진 것을 빼고 센다', () => {
  const b = new LogBuffer(2);
  b.fail('a', new Error('첫째'));
  b.fail('b', new Error('둘째'));
  assert.equal(b.errorCount(), 2);
  b.add('info', 'c', '셋째'); // 첫째가 밀려난다
  assert.equal(b.errorCount(), 1);
  b.clear();
  assert.equal(b.errorCount(), 0);
  assert.deepEqual(b.entries(), []);
});

test('적재할 때 이미 비식별 처리된다 — 원문이 버퍼에 남지 않는다', () => {
  const b = new LogBuffer();
  b.fail('ingest', new Error('C:\\docs\\원가 산출.xlsx 를 열지 못했습니다'));
  const dump = JSON.stringify(b.entries());
  assert.ok(!dump.includes('원가'), dump);
  assert.ok(!dump.includes('C:'), dump);
});

test('시각은 초까지만 적는다', () => {
  const e = new LogBuffer().add('warn', 'test', '경고');
  assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

/* ---------- 붙여 넣을 본문 ---------- */

test('머리말과 본문이 붙고 상세는 들여쓴다', () => {
  const b = new LogBuffer();
  b.add('error', 'ipc:search', '실패', 'at foo\nat bar');
  const out = formatLog(b.entries(), { 앱: '0.1.0' });
  assert.ok(out.startsWith('# co-secondbrain 오류 기록'), out);
  assert.ok(out.includes('앱: 0.1.0'), out);
  assert.ok(out.includes('ERROR ipc:search — 실패'), out);
  assert.ok(out.includes('    at foo\n    at bar'), out);
});

test('머리말도 비식별 처리를 거친다', () => {
  const out = formatLog([], { Vault: 'C:\\Users\\hong\\vault' });
  assert.ok(!out.includes('hong'), out);
});

test('기록이 없어도 복사할 것이 나온다', () => {
  assert.ok(formatLog([]).includes('(기록 없음)'));
});
