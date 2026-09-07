import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { extractFile, kindOf, isSupported, buildThreads } from '../src/core/extract/index.ts';
import { extractEmail } from '../src/core/extract/email.ts';
import { SCAN_THRESHOLD_CHARS_PER_PAGE } from '../src/core/extract/pdf.ts';

// M0 에서 실제 라이브러리로 만든 샘플을 그대로 쓴다.
const FIX = path.resolve(import.meta.dirname, '../../spikes/fixtures/files');
const f = (n: string) => path.join(FIX, n);
const allText = (chunks: { text: string }[]) => chunks.map((c) => c.text).join('\n');

test('확장자 판별', () => {
  assert.equal(kindOf('a.docx'), 'docx');
  assert.equal(kindOf('A.PPTX'), 'pptx');
  assert.equal(kindOf('a.zip'), null);
  assert.ok(isSupported('회의록.md'));
  assert.ok(!isSupported('사진.jpg'));
});

test('docx — 제목 트리가 앵커가 된다', async () => {
  const e = await extractFile(f('kickoff.docx'));
  assert.equal(e.kind, 'docx');
  assert.ok(e.chunks.length > 0);
  const deep = e.chunks.find((c) => c.anchor.locator.split(' > ').length >= 3);
  assert.ok(deep, `3단 제목 경로가 없다: ${e.chunks.map((c) => c.anchor.locator).join(' | ')}`);
  assert.ok(e.relations.some((r) => r.kind === 'contains'), '제목 계층 관계가 없다');
});

test('xlsx — 수식 의존 그래프. 시트 간 참조까지 잡는다', async () => {
  const e = await extractFile(f('cost.xlsx'));
  const feeds = e.relations.filter((r) => r.kind === 'feeds');
  assert.ok(feeds.length >= 4, `엣지가 ${feeds.length}개뿐`);
  const cross = feeds.filter((r) => {
    const s = (x: string) => x.split('#')[1]?.split('!')[0];
    return s(r.from) !== s(r.to);
  });
  assert.ok(cross.length >= 1, '시트 간 참조를 못 잡았다');
  assert.ok(feeds.every((r) => r.confidence === 'EXTRACTED'));
});

test('pptx — 슬라이드 + 발표자 노트', async () => {
  const e = await extractFile(f('kickoff.pptx'));
  assert.equal(e.chunks.length, 2);
  assert.ok(e.chunks.every((c) => /^slide-\d+$/.test(c.anchor.locator)));
  assert.ok(allText(e.chunks).includes('발표자 노트'), '노트를 못 읽었다');
});

test('pdf — 텍스트 추출', async () => {
  const e = await extractFile(f('report.pdf'));
  assert.ok(e.chunks.length >= 1);
  assert.equal(e.chunks[0]?.anchor.locator, 'page-1');
  assert.equal(e.warnings.length, 0, '정상 PDF 에 경고가 붙었다');
});

test('pdf — 스캔본을 감지해 경고한다', async () => {
  const e = await extractFile(f('scanned.pdf'));
  assert.ok(e.warnings.some((w) => w.includes('스캔본')), `경고 없음: ${JSON.stringify(e.warnings)}`);
  assert.ok(SCAN_THRESHOLD_CHARS_PER_PAGE > 0);
});

test('이메일 — 입력 순서를 섞어도 스레드가 복원된다', async () => {
  // 일부러 3 → 1 → 2 순서로 넣는다
  const metas = [];
  for (const n of ['mail-3.eml', 'mail-1.eml', 'mail-2.eml']) {
    metas.push((await extractEmail(f(n), `src-${n.replace('.eml', '')}`)).meta);
  }
  const rels = buildThreads(metas);
  assert.equal(rels.length, 2, '답장 관계 2건이 나와야 한다');
  assert.ok(rels.every((r) => r.kind === 'replies-to' && r.confidence === 'EXTRACTED'));

  // 3 → 2 → 1 사슬인지 확인
  const parentOf = new Map(rels.map((r) => [r.from, r.to]));
  assert.equal(parentOf.get('src-mail-3#body'), 'src-mail-2#body');
  assert.equal(parentOf.get('src-mail-2#body'), 'src-mail-1#body');
  assert.equal(parentOf.get('src-mail-1#body'), undefined, '루트에 부모가 있으면 안 된다');
});

test('스레드 밖의 메일은 관계를 만들지 않는다', async () => {
  const one = (await extractEmail(f('mail-2.eml'), 'src-mail-2')).meta;
  assert.deepEqual(buildThreads([one]), [], '부모가 없는데 관계를 만들었다');
});

test('vtt — 화자 턴과 타임코드', async () => {
  const e = await extractFile(f('meeting.vtt'));
  assert.equal(e.chunks.length, 2);
  assert.ok(e.chunks[0]?.anchor.locator.startsWith('t-00:00:'));
  assert.ok(allText(e.chunks).includes('홍길동'));
  assert.ok(e.relations.some((r) => r.kind === 'speaks-after'));
});

test('지원하지 않는 형식은 던진다', async () => {
  await assert.rejects(() => extractFile('/tmp/사진.jpg'), /지원하지 않는 형식/);
});
