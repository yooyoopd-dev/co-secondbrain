import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex, snippet, MIN_QUERY_LEN } from '../src/core/search.ts';
import type { Chunk } from '../src/core/types.ts';

const chunk = (sourceId: string, locator: string, text: string): Chunk => ({
  anchor: { sourceId, locator, label: locator },
  text,
});

function fixture() {
  const idx = new SearchIndex(new DatabaseSync(':memory:'));
  idx.indexSource('src-kickoff', [
    chunk('src-kickoff', 'slide-2', '에이콤(주)이 2026년 ACME 프로젝트의 주 협력사로 확정되었다.'),
    chunk('src-kickoff', 'slide-12', '계약 갱신일은 2027-01-15이며 구매팀이 최종 검토를 맡는다.'),
  ]);
  idx.indexSource('src-mail-a41f', [
    chunk('src-mail-a41f', 'body', '에이콤의 김철수 담당자가 갱신일을 2027-03-01로 조정해달라고 요청했다.'),
  ]);
  idx.indexSource('src-arch', [
    chunk('src-arch', 'page-3', '데이터센터 이관은 클라우드 마이그레이션 로드맵의 2단계에 해당한다.'),
  ]);
  idx.indexSource('src-sec', [chunk('src-sec', 'page-1', '접근 통제 정책은 보안팀이 관리하며 분기마다 감사를 수행한다.')]);
  return idx;
}

const ids = (idx: SearchIndex, q: string) => [...new Set(idx.search(q).map((h) => h.sourceId))].sort();

// M0 §11 에서 하이브리드가 통과한 질의를 그대로 회귀 테스트로 둔다.
test('조사가 붙은 어절도 걸린다 (기본 토크나이저의 실패 지점)', () => {
  const idx = fixture();
  assert.deepEqual(ids(idx, '에이콤'), ['src-kickoff', 'src-mail-a41f']);
  assert.deepEqual(ids(idx, '갱신일'), ['src-kickoff', 'src-mail-a41f']);
  assert.deepEqual(ids(idx, '협력사'), ['src-kickoff']);
  assert.deepEqual(ids(idx, '구매팀'), ['src-kickoff']);
});

test('2음절 질의가 걸린다 (trigram 단독의 실패 지점)', () => {
  const idx = fixture();
  assert.deepEqual(ids(idx, '계약'), ['src-kickoff']);
  assert.deepEqual(ids(idx, '이관'), ['src-arch']);
  assert.deepEqual(ids(idx, '검토'), ['src-kickoff']);
  assert.deepEqual(ids(idx, '보안'), ['src-sec']);
});

test('어절 중간 2음절도 걸린다 (LIKE 폴백)', () => {
  const idx = fixture();
  assert.deepEqual(ids(idx, '센터'), ['src-arch'], '데이터센터 안의 "센터"');
});

test('1자 질의는 거부한다 (오검색 방지)', () => {
  const idx = fixture();
  assert.equal(MIN_QUERY_LEN, 2);
  assert.deepEqual(idx.search('이'), []);
  assert.deepEqual(idx.search('검'), []);
  assert.deepEqual(idx.search('  '), []);
});

test('영문·숫자도 걸린다', () => {
  const idx = fixture();
  assert.deepEqual(ids(idx, 'ACME'), ['src-kickoff']);
  assert.deepEqual(ids(idx, '2027'), ['src-kickoff', 'src-mail-a41f']);
});

test('재색인하면 이전 내용이 남지 않는다', () => {
  const idx = fixture();
  assert.deepEqual(ids(idx, '협력사'), ['src-kickoff']);
  idx.indexSource('src-kickoff', [chunk('src-kickoff', 'slide-1', '전혀 다른 내용으로 교체되었다.')]);
  assert.deepEqual(ids(idx, '협력사'), [], '옛 청크가 색인에 남아 있으면 안 된다');
  assert.deepEqual(ids(idx, '교체'), ['src-kickoff']);
});

test('앵커가 결과에 실려 온다', () => {
  const idx = fixture();
  const hit = idx.search('협력사')[0];
  assert.equal(hit?.sourceId, 'src-kickoff');
  assert.equal(hit?.locator, 'slide-2');
  assert.ok(hit?.snippet.includes('협력사'));
});

test('FTS5 특수문자가 질의를 깨뜨리지 않는다', () => {
  const idx = fixture();
  for (const q of ['에이콤"', 'a OR b', 'NEAR(x)', '"; DROP TABLE chunks; --']) {
    assert.doesNotThrow(() => idx.search(q), `질의 ${JSON.stringify(q)} 에서 던짐`);
  }
  assert.deepEqual(ids(idx, '협력사'), ['src-kickoff'], '테이블이 살아 있어야 한다');
});

test('snippet 은 질의어 주변을 자른다', () => {
  assert.ok(snippet('가'.repeat(200) + '에이콤' + '나'.repeat(200), '에이콤').includes('에이콤'));
  assert.ok(snippet('짧은 글', '없는말').length <= 10);
});
