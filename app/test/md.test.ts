import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, parseInline, parseMarkdown, parseSnippet, stripHtml, type Block } from '../src/core/md.ts';

/** 블록 하나를 글자로 눌러 본다. 트리 모양까지 단언하면 시험이 부서지기 쉽다. */
function flat(b: Block): string {
  switch (b.t) {
    case 'h':
    case 'p':
    case 'quote':
      return text(b.v);
    case 'list':
      return b.items.map(text).join('|');
    case 'code':
      return b.v;
    case 'table':
      return [b.head.map(text).join('|'), ...b.rows.map((r) => r.map(text).join('|'))].join('/');
    case 'hr':
      return '---';
  }
}

function text(v: readonly import('../src/core/md.ts').Inline[]): string {
  return v
    .map((n) => {
      switch (n.t) {
        case 'text':
        case 'code':
          return n.v;
        default:
          return text(n.v);
      }
    })
    .join('');
}

test('HTML 조각은 태그가 아니라 글자로 내려간다', () => {
  // 변환기가 만든 md 에서 실제로 나오는 모양이다. 그대로 두면 화면에 </td> 가 보인다.
  const md = '<tr><td>이름</td><td>값</td></tr>';
  // 줄 끝의 `</tr>` 은 줄바꿈으로 남는다. 다음 행과 붙으면 안 되기 때문이다.
  assert.equal(stripHtml(md), '이름 · 값\n');
  assert.ok(!stripHtml(md).includes('<'));
});

test('br 은 줄바꿈이 된다', () => {
  assert.equal(stripHtml('앞<br>뒤'), '앞\n뒤');
  assert.equal(stripHtml('앞<br />뒤'), '앞\n뒤');
});

test('엔티티를 푼다', () => {
  assert.equal(decodeEntities('a&amp;b&nbsp;c&lt;d&#65;'), 'a&b c<dA');
  assert.equal(decodeEntities('&unknown;'), '&unknown;');
});

test('제목·문단·목록·구분선을 가른다', () => {
  const blocks = parseMarkdown('# 제목\n\n첫 문단\n\n- 하나\n- 둘\n\n---\n');
  assert.deepEqual(
    blocks.map((b) => b.t),
    ['h', 'p', 'list', 'hr'],
  );
  assert.equal(flat(blocks[0]!), '제목');
  assert.equal(flat(blocks[2]!), '하나|둘');
});

test('파이프 표는 구분선이 있어야 표다', () => {
  const t = parseMarkdown('| 이름 | 값 |\n|---|---|\n| 가 | 1 |\n| 나 | 2 |');
  assert.equal(t.length, 1);
  assert.equal(t[0]!.t, 'table');
  assert.equal(flat(t[0]!), '이름|값/가|1/나|2');

  // 구분선이 없으면 그냥 문단이다. 표로 만들면 본문이 깨진다.
  const p = parseMarkdown('가격 | 수량 입니다');
  assert.equal(p[0]!.t, 'p');
});

test('코드 펜스 안은 손대지 않는다', () => {
  const b = parseMarkdown('```js\nconst a = **b**;\n# 제목 아님\n```');
  assert.equal(b.length, 1);
  assert.equal(b[0]!.t, 'code');
  assert.equal(flat(b[0]!), 'const a = **b**;\n# 제목 아님');
});

test('앞머리 YAML 은 코드 블록으로 남는다', () => {
  const b = parseMarkdown('---\nid: ent-acme\ntype: entity\n---\n\n본문');
  assert.equal(b[0]!.t, 'code');
  assert.equal(flat(b[0]!), 'id: ent-acme\ntype: entity');
  assert.equal(flat(b[1]!), '본문');
});

test('인라인 코드가 강조보다 세다', () => {
  const v = parseInline('`**안 굵다**` 그리고 **굵다**');
  assert.equal(v[0]!.t, 'code');
  assert.equal(text([v[0]!]), '**안 굵다**');
  assert.ok(v.some((n) => n.t === 'strong'));
});

test('각주 인용은 글자로 남는다 — 화면이 칩으로 따로 그린다', () => {
  const v = parseInline('확정했다 [^src-kickoff#slide-12]');
  assert.equal(text(v), '확정했다 [^src-kickoff#slide-12]');
  assert.ok(v.every((n) => n.t === 'text'));
});

test('위키링크와 일반 링크를 읽는다', () => {
  const [w] = parseInline('[[ent-acme|에이콤]]');
  assert.equal(w!.t, 'link');
  assert.equal(text([w!]), '에이콤');

  const [l] = parseInline('[문서](https://example.com)');
  assert.equal(l!.t, 'link');
  assert.equal(text([l!]), '문서');
});

test('검색 조각은 한 줄로 눌린다', () => {
  assert.equal(text(parseSnippet('앞<br>뒤\n\n그리고')), '앞 뒤 그리고');
});

test('빈 글은 블록이 없다', () => {
  assert.deepEqual(parseMarkdown(''), []);
  assert.deepEqual(parseMarkdown('\n\n  \n'), []);
});
