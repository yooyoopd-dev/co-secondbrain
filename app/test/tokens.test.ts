import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PER_ITEM_USD, TOKENS_PER_CHAR, USD_PER_MTOK, estimateScan, estimateTokens, summarizeScan } from '../src/core/tokens.ts';
import { COST } from '../src/core/agent/batch.ts';

test('실측 구간 안에 있는 값을 쓴다', () => {
  // 실측 0.847 ~ 0.905 (n=4). 최대 위로 잡아 과소 추정을 막는다
  assert.ok(TOKENS_PER_CHAR >= 0.905 && TOKENS_PER_CHAR <= 0.95, `${TOKENS_PER_CHAR}`);
  assert.ok(USD_PER_MTOK >= 3.6 && USD_PER_MTOK <= 3.9, `${USD_PER_MTOK}`);
});

test('실측한 네 점을 15% 안으로 맞춘다', () => {
  const measured: [number, number][] = [[500, 444], [1500, 1337], [4000, 3618], [8000, 6775]];
  for (const [chars, actual] of measured) {
    const est = estimateTokens(chars);
    assert.ok(Math.abs(est - actual) / actual < 0.15, `${chars}자: 추정 ${est} vs 실측 ${actual}`);
  }
});

test('추정은 실측보다 넉넉해야 한다 — 싸게 나오는 편이 낫다', () => {
  for (const [chars, actual] of [[500, 444], [1500, 1337], [4000, 3618], [8000, 6775]] as [number, number][]) {
    assert.ok(estimateTokens(chars) >= actual, `${chars}자에서 과소 추정`);
  }
});

test('빈 스캔은 0원이다', () => {
  assert.deepEqual(estimateScan([]), { items: 0, chars: 0, tokens: 0, usd: 0 });
});

test('한 건이면 콜드 실행 한 번 + 내용', () => {
  const e = estimateScan([1000]);
  assert.equal(e.items, 1);
  assert.equal(e.tokens, Math.round(1000 * TOKENS_PER_CHAR));
  assert.ok(Math.abs(e.usd - (COST.coldTypicalUsd + (e.tokens * USD_PER_MTOK) / 1e6)) < 1e-9);
});

test('위키 200쪽 전수 검사가 배치로 약 $11 이다 — 월 예산의 22%', () => {
  // 처음에 $4 로 적었다가 A/B 측정(20건, 실제 페이지 분량)에서 재개분이 두 배 넘게
  // 나와 고쳤다. 짧은 합성 입력으로 잰 값이 낮게 보였다.
  const e = estimateScan(Array.from({ length: 200 }, () => 1500));
  assert.equal(e.items, 200);
  assert.equal(e.chars, 300_000);
  assert.ok(e.usd > 9 && e.usd < 13, `$${e.usd.toFixed(2)}`);
});

test('페이지당 프로세스로 돌리면 두 배 넘게 든다 — 그래서 배치 전용이다', () => {
  const batch = estimateScan(Array.from({ length: 200 }, () => 1500)).usd;
  const perProcess = 200 * COST.coldTypicalUsd;
  assert.ok(perProcess / batch > 2, `배치 $${batch.toFixed(2)} vs 건별 $${perProcess.toFixed(2)}`);
});

test('음수 글자수는 0으로 본다', () => {
  assert.equal(estimateTokens(-100), 0);
  assert.equal(estimateScan([-5, 100]).chars, 100);
});

test('한 줄 요약에 건수·글자·토큰·예상 비용이 다 있다', () => {
  const s = summarizeScan(estimateScan([1500, 1500]));
  assert.match(s, /2건/);
  assert.match(s, /3,000자/);
  assert.match(s, /\$\d+\.\d\d/);
  assert.ok(PER_ITEM_USD > 0);
});
