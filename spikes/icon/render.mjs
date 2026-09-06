#!/usr/bin/env node
// 첨부받은 아이콘 원본에서 앱 아이콘 자산을 만든다.
//
// 원본: design/icon/co_second_brain_v2.png — 사용자가 준 그림이다. **다시 그리지 않는다.**
// 여기서 하는 일은 두 가지뿐이다. 판 바깥 배경을 투명으로 바꾸고, 크기를 줄인다.
//
// 배경을 지우는 방법은 색을 키로 잡는 것이 아니라 **네 모서리에서 시작하는 채움**이다.
// 판 안쪽(#fcfbf8)과 바깥 배경(#ffffff)이 둘 다 거의 흰색이라 색으로 자르면 판 속까지
// 뚫린다. 모서리에서 이어진 영역만 지우면 판 테두리에서 멈춘다.
//
// 만드는 것:
//   app/src/renderer/public/icon-256.png  창 아이콘 · 첫 화면 마크 (vite 가 그대로 복사한다)
//   design/icon/icon.ico                  16~256 여섯 크기를 담은 다중 해상도 (20번 NSIS 가 쓴다)
//   design/icon/out/icon-*.png            눈으로 볼 중간 산물. `out/` 은 커밋하지 않는다
//
// **개발 컨테이너 전용이다.** 전역 playwright 의 크로미움으로 처리한다. 사내 PC 는
// 이 스크립트를 돌리지 않는다 — 결과물이 저장소에 커밋돼 있다.
//
//   node spikes/icon/render.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'design', 'icon', 'co_second_brain_v2.png');
const OUT = path.join(ROOT, 'design', 'icon', 'out');
const ICO = path.join(ROOT, 'design', 'icon', 'icon.ico');
const APP_ICON = path.join(ROOT, 'app', 'src', 'renderer', 'public', 'icon-256.png');
const SIZES = [16, 32, 48, 64, 128, 256, 512];
/** .ico 안에 넣을 크기. 256 까지만 담는다 — 그 위는 Windows 가 안 본다 */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
/** 배경으로 볼 밝기 하한. 판 테두리보다 위여야 판이 안 뚫린다 */
const BG_MIN_LUMA = 243;

// smoke.mjs 와 같은 방식. ESM 은 NODE_PATH 를 안 보므로 전역 위치를 npm 에게 묻는다.
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    /* 지역 설치 없음 */
  }
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true });
  const root = r.stdout?.trim();
  if (!root) return null;
  try {
    return await import(pathToFileURL(path.join(root, 'playwright', 'index.mjs')).href);
  } catch {
    return null;
  }
}

const pw = await loadPlaywright();
if (!pw) {
  console.error('playwright 를 찾지 못했습니다. `npm i -g playwright` 후 다시 돌리십시오.');
  process.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });
const source = `data:image/png;base64,${fs.readFileSync(SRC).toString('base64')}`;

const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');

/**
 * 배경을 지우고 각 크기로 줄인다. 브라우저 안에서 도는 코드다.
 * 그림자는 반투명으로 남긴다 — 딱 잘라 내면 판 가장자리가 계단처럼 보인다.
 */
const dataUrls = await page.evaluate(
  async ([src, sizes, bgMin]) => {
    const img = new Image();
    img.src = src;
    await img.decode();

    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const im = g.getImageData(0, 0, w, h);
    const px = im.data;

    const luma = (i) => 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];

    // 네 모서리에서 시작하는 너비 우선 채움. 색 키가 아니라 이어진 영역만 지운다.
    const seen = new Uint8Array(w * h);
    const queue = [];
    const push = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const p = y * w + x;
      if (seen[p]) return;
      if (luma(p * 4) < bgMin) return;
      seen[p] = 1;
      queue.push(p);
    };
    for (let x = 0; x < w; x++) {
      push(x, 0);
      push(x, h - 1);
    }
    for (let y = 0; y < h; y++) {
      push(0, y);
      push(w - 1, y);
    }
    for (let q = 0; q < queue.length; q++) {
      const p = queue[q];
      const x = p % w;
      const y = (p / w) | 0;
      push(x - 1, y);
      push(x + 1, y);
      push(x, y - 1);
      push(x, y + 1);
    }
    for (let p = 0; p < w * h; p++) if (seen[p]) px[p * 4 + 3] = 0;

    // 지운 영역에 닿은 밝은 회색은 판의 그림자다. 밝을수록 더 깎아 계단을 없앤다.
    const soft = new Float32Array(w * h).fill(1);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (seen[p]) continue;
        if (!(seen[p - 1] || seen[p + 1] || seen[p - w] || seen[p + w])) continue;
        const l = luma(p * 4);
        if (l >= bgMin - 24) soft[p] = Math.max(0, (bgMin - l) / 24);
      }
    }
    for (let p = 0; p < w * h; p++) if (soft[p] < 1) px[p * 4 + 3] = Math.round(px[p * 4 + 3] * soft[p]);

    g.putImageData(im, 0, 0);

    const out = {};
    for (const s of sizes) {
      const d = document.createElement('canvas');
      d.width = s;
      d.height = s;
      const dg = d.getContext('2d');
      dg.imageSmoothingEnabled = true;
      dg.imageSmoothingQuality = 'high';
      dg.drawImage(c, 0, 0, s, s);
      out[s] = d.toDataURL('image/png');
    }
    out.source = `${w}x${h}`;
    return out;
  },
  [source, SIZES, BG_MIN_LUMA],
);
await browser.close();

const pngs = new Map();
for (const size of SIZES) {
  const buf = Buffer.from(dataUrls[size].split(',')[1], 'base64');
  pngs.set(size, buf);
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), buf);
}
fs.writeFileSync(APP_ICON, pngs.get(256));
fs.writeFileSync(ICO, ico(ICO_SIZES.map((s) => [s, pngs.get(s)])));

/**
 * ICO 컨테이너. 헤더 6바이트 + 항목당 16바이트 디렉터리 + PNG 원본을 그대로 이어 붙인다.
 * Vista 이후 Windows 는 항목이 PNG 여도 읽는다 — BMP 로 다시 인코딩할 필요가 없다.
 */
function ico(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = head.length + dir.length;
  entries.forEach(([size, buf], i) => {
    const p = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, p + 0); // 256 은 0 으로 적는다
    dir.writeUInt8(size >= 256 ? 0 : size, p + 1);
    dir.writeUInt8(0, p + 2); // 팔레트 없음
    dir.writeUInt8(0, p + 3);
    dir.writeUInt16LE(1, p + 4); // color planes
    dir.writeUInt16LE(32, p + 6); // bpp
    dir.writeUInt32LE(buf.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += buf.length;
  });
  return Buffer.concat([head, dir, ...entries.map(([, b]) => b)]);
}

/* ---------- 자가 검사. 정답을 아는 것만 본다 (CLAUDE.md §9) ---------- */

const fails = [];
const ok = (name, cond, got) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ← ${JSON.stringify(got)}`}`);
  if (!cond) fails.push(name);
};

console.log(`      원본: ${path.basename(SRC)} ${dataUrls.source}`);

for (const size of SIZES) {
  const { width, height, hasAlpha } = readPngHeader(pngs.get(size));
  ok(`${size}px 가 ${size}×${size} 로 나온다`, width === size && height === size, { width, height });
  if (size === 256) ok('알파 채널이 있다', hasAlpha, { hasAlpha });
}

const px = pixels(pngs.get(64));
const at = (x, y) => [...px.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];

// 모서리는 투명해야 한다. 배경이 남았으면 여기서 걸린다.
ok('모서리가 투명하다', at(0, 0)[3] === 0 && at(63, 0)[3] === 0 && at(0, 63)[3] === 0, at(0, 0));
// 판 속은 지워지면 안 된다. 색으로 잘랐다면 여기가 뚫린다.
ok('판 속이 남아 있다', at(32, 12)[3] > 200, at(32, 12));
// 원본의 크림 판이 그대로 온다 — 다시 그린 것이 아니라는 확인
const plate = at(32, 12);
ok('판 색이 크림이다', plate[0] > 230 && plate[2] < plate[0], plate);
// 가운데는 뇌·악수의 숯색 선이 지난다
ok('가운데에 그림이 있다', at(32, 32)[3] > 200, at(32, 32));

const icoBuf = fs.readFileSync(ICO);
ok('ico 가 여섯 크기를 담는다', icoBuf.readUInt16LE(4) === ICO_SIZES.length, icoBuf.readUInt16LE(4));

console.log(fails.length === 0 ? '\n전부 통과' : `\n실패 ${fails.length}건: ${fails.join(', ')}`);
process.exit(fails.length === 0 ? 0 : 1);

/** IHDR 만 읽는다. 폭·높이·색 타입 */
function readPngHeader(buf) {
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    // 색 타입 6 = truecolor + alpha, 4 = grayscale + alpha
    hasAlpha: (buf.readUInt8(25) & 4) !== 0,
  };
}

/** PNG 를 RGBA 로 푼다. 필터 5종을 되돌린다 */
function pixels(buf) {
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  const chunks = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    if (buf.toString('ascii', p + 4, p + 8) === 'IDAT') chunks.push(buf.subarray(p + 8, p + 8 + len));
    p += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const bpp = 4;
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return out;
}
