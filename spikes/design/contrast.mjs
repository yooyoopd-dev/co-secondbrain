#!/usr/bin/env node
// 크림 바탕에서 토큰이 읽히는가. docs/DESIGN-SYSTEM.md §2 의 수치를 여기서 잽니다.
//
// **명세를 그대로 옮기면 세 곳이 안 읽힙니다.** design/design.md 의 accent `#3b82f6` 은
// 흰 글자 대비가 3.68:1 이고 채도가 91% 라 명세 자신의 "saturation cap: 80%" 도 넘습니다.
// 눈으로 고르지 않고 계산해서 골랐다는 것을 이 스크립트가 붙듭니다.
//
// 값은 tokens.css 에서 읽습니다 — 문서와 코드가 갈라지면 여기서 걸립니다.
//
//   node spikes/design/contrast.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'app', 'src', 'renderer', 'tokens.css'), 'utf8');

/** `--이름: 값;` 을 전부 긁는다. 주석은 값에 안 들어간다 */
function tokens(src) {
  const m = new Map();
  for (const [, name, value] of src.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) m.set(name, value.trim());
  return m;
}

const T = tokens(CSS);
const CANVAS = '#f7f4ed';

/** `#rrggbb` 나 `rgba(r,g,b,a)` 를 바탕 위에 얹은 실제 RGB 로 바꾼다 */
function flatten(value, over) {
  const rgba = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,/\s]+([\d.]+))?\s*\)/.exec(value);
  const bg = hex(over);
  if (rgba) {
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    return [1, 2, 3].map((i) => Math.round(Number(rgba[i]) * a + bg[i - 1] * (1 - a)));
  }
  return hex(value);
}

function hex(v) {
  const n = parseInt(v.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lin = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** WCAG 2 명암비 */
function ratio(fg, bg) {
  const a = lum(flatten(fg, bg));
  const b = lum(hex(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** HSL 채도. design.md Don'ts 의 상한 80% 를 보는 데 쓴다 */
function saturation(v) {
  const [r, g, b] = flatten(v, CANVAS).map((x) => x / 255);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  return mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
}

const fails = [];
const ok = (name, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${JSON.stringify(got)}`}`);
  if (!cond) fails.push(name);
};

ok('바탕이 명세의 Creme 이다', T.get('--bg-canvas') === CANVAS, T.get('--bg-canvas'));

// 본문으로 읽히는 색은 4.5:1 이 필요하다. `--fg-faint` 도 캡션이라 본문이다.
for (const name of ['--fg', '--fg-muted', '--fg-faint', '--accent', '--ok', '--warn', '--danger']) {
  const r = ratio(T.get(name), CANVAS);
  ok(`${name} 이 바탕에서 4.5:1 이상`, r >= 4.5, r.toFixed(2));
}

// 기본 버튼은 accent 채움에 흰 글자다
const onAccent = ratio('#ffffff', T.get('--accent'));
ok('accent 채움 위의 흰 글자가 4.5:1 이상', onAccent >= 4.5, onAccent.toFixed(2));

// 포커스 링과 아웃라인 경계는 비텍스트라 3:1 (WCAG 1.4.11)
for (const name of ['--ring', '--border-strong']) {
  const r = ratio(T.get(name), CANVAS);
  ok(`${name} 이 바탕에서 3:1 이상`, r >= 3, r.toFixed(2));
}

// design.md Don'ts — "No oversaturated accent colors (saturation cap: 80%)".
// 명세가 지정한 #3b82f6 이 91% 라 accent 로 못 쓴다. 링에만 남긴 이유가 이것이다.
for (const name of ['--accent', '--ok', '--warn', '--danger']) {
  const s = saturation(T.get(name));
  ok(`${name} 채도가 80% 이하`, s <= 0.8, `${(s * 100).toFixed(0)}%`);
}

// 표면은 위로 올라올수록 밝아야 한다. 뒤집히면 층이 안 보인다.
const levels = ['--bg-canvas', '--bg-surface', '--bg-raised'].map((n) => lum(hex(T.get(n))));
ok('표면이 위로 갈수록 밝다', levels[0] < levels[1] && levels[1] < levels[2], levels.map((l) => l.toFixed(3)));

// diff 배경은 색만으로 구분하지 않지만, 그래도 흰 카드와 구별돼야 한다
for (const name of ['--ok-wash', '--danger-wash', '--info-wash']) {
  const r = ratio(T.get(name), '#ffffff');
  ok(`${name} 이 흰 카드와 구별된다`, r > 1.03, r.toFixed(3));
}

console.log(fails.length === 0 ? '\n전부 통과' : `\n실패 ${fails.length}건: ${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);
