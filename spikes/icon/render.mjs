#!/usr/bin/env node
// 첨부받은 아이콘 원본에서 앱 아이콘 자산을 만든다.
//
// 원본: design/icon/co_second_brain_v2.png — 사용자가 준 그림이다. **다시 그리지 않는다.**
// 여기서 하는 일은 두 가지뿐이다. 판 바깥 배경을 투명으로 바꾸고, 크기를 줄인다.
//
// 줄이는 방식이 곧 품질이다. 처음에는 500px 를 16px 로 한 번에 그렸는데 **16px 에
// 어두운 픽셀이 하나도 남지 않았다** (가장 어두운 곳이 밝기 122). 3px 짜리 검은 선이
// 31:1 로 평균되면 회색이 된다. 그래서 셋을 겹쳐 쓴다 —
//   여백을 잘라 내고 (그림이 차지하는 픽셀을 25% 늘린다)
//   절반씩 여러 번 줄이고 (한 번에 줄이면 표본이 성기다)
//   작은 크기에는 언샤프를 건다 (평균으로 흐려진 경계를 되살린다).
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
/** 이 크기 이하에는 언샤프를 건다. 128 이상은 원본 그대로가 낫다 */
const SHARPEN_MAX = 64;

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
  async ([src, sizes, bgMin, sharpenMax]) => {
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

    // 그림이 실제로 차지하는 네모를 찾아 여백을 버린다. 정사각으로 맞춰 비율을 지킨다.
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] <= 16) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const side = Math.max(x1 - x0, y1 - y0) + 1;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const crop = { x: Math.round(cx - side / 2), y: Math.round(cy - side / 2), s: side };

    /** 절반씩 줄인다. 한 번에 줄이면 원본 표본이 성겨 선이 회색으로 뭉갠다 */
    function shrink(src, srcBox, target) {
      let cur = document.createElement('canvas');
      cur.width = srcBox.s;
      cur.height = srcBox.s;
      cur.getContext('2d').drawImage(src, srcBox.x, srcBox.y, srcBox.s, srcBox.s, 0, 0, srcBox.s, srcBox.s);
      while (cur.width > target * 2) {
        const half = Math.max(target, Math.floor(cur.width / 2));
        const n = document.createElement('canvas');
        n.width = half;
        n.height = half;
        const ng = n.getContext('2d');
        ng.imageSmoothingEnabled = true;
        ng.imageSmoothingQuality = 'high';
        ng.drawImage(cur, 0, 0, half, half);
        cur = n;
      }
      const d = document.createElement('canvas');
      d.width = target;
      d.height = target;
      const dg = d.getContext('2d');
      dg.imageSmoothingEnabled = true;
      dg.imageSmoothingQuality = 'high';
      dg.drawImage(cur, 0, 0, target, target);
      return d;
    }

    /** 언샤프. 평균으로 흐려진 경계를 되살린다. 알파는 건드리지 않는다 */
    function sharpen(canvas, amount) {
      const s = canvas.width;
      const cg = canvas.getContext('2d', { willReadFrequently: true });
      const src = cg.getImageData(0, 0, s, s);
      const dst = cg.createImageData(s, s);
      for (let y = 0; y < s; y++) {
        for (let x = 0; x < s; x++) {
          const i = (y * s + x) * 4;
          for (let k = 0; k < 3; k++) {
            const up = y > 0 ? src.data[i - s * 4 + k] : src.data[i + k];
            const dn = y < s - 1 ? src.data[i + s * 4 + k] : src.data[i + k];
            const lf = x > 0 ? src.data[i - 4 + k] : src.data[i + k];
            const rt = x < s - 1 ? src.data[i + 4 + k] : src.data[i + k];
            const v = src.data[i + k] * (1 + 4 * amount) - amount * (up + dn + lf + rt);
            dst.data[i + k] = Math.max(0, Math.min(255, Math.round(v)));
          }
          dst.data[i + 3] = src.data[i + 3];
        }
      }
      cg.putImageData(dst, 0, 0);
      return canvas;
    }

    const out = {};
    for (const s of sizes) {
      let d = shrink(c, crop, s);
      if (s <= sharpenMax) d = sharpen(d, s <= 32 ? 0.9 : 0.5);
      out[s] = d.toDataURL('image/png');
    }
    out.source = `${w}x${h}`;
    out.crop = `${crop.s}x${crop.s}`;
    return out;
  },
  [source, SIZES, BG_MIN_LUMA, SHARPEN_MAX],
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

console.log(`      원본: ${path.basename(SRC)} ${dataUrls.source} → 여백을 자른 뒤 ${dataUrls.crop}`);

for (const size of SIZES) {
  const { width, height, hasAlpha } = readPngHeader(pngs.get(size));
  ok(`${size}px 가 ${size}×${size} 로 나온다`, width === size && height === size, { width, height });
  if (size === 256) ok('알파 채널이 있다', hasAlpha, { hasAlpha });
}

const px = pixels(pngs.get(64));
const at = (x, y) => [...px.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];

// 모서리는 투명해야 한다. 배경이 남았으면 여기서 걸린다.
ok('모서리가 투명하다', at(0, 0)[3] === 0 && at(63, 0)[3] === 0 && at(0, 63)[3] === 0, at(0, 0));
// 가운데는 뇌·악수가 지난다. 판 속이 통째로 뚫렸으면 여기가 비어 있다.
ok('가운데에 그림이 있다', at(32, 32)[3] > 200, at(32, 32));

// 원본의 크림 판이 그대로 온다 — 다시 그린 것도, 색으로 잘라 뚫린 것도 아니라는 확인.
// 좌표 하나를 찍으면 여백을 자를 때마다 낡는다. 넓이 비율로 본다.
let cream = 0;
let solid = 0;
for (let i = 0; i < 64 * 64; i++) {
  if (px[i * 4 + 3] < 128) continue;
  solid += 1;
  if (px[i * 4] > 235 && px[i * 4 + 2] < px[i * 4]) cream += 1;
}
const creamPct = Number(((cream / solid) * 100).toFixed(1));
ok('판이 크림으로 남아 있다', creamPct > 25, { creamPct, solid });

// 축소본이 뭉갰는가. 16px 에 어두운 픽셀이 하나도 없던 것이 이 검사를 만든 이유다.
for (const size of [16, 32]) {
  const { minLuma, darkPct } = ink(pngs.get(size), size);
  ok(`${size}px 에 잉크가 남는다`, minLuma <= 90, { minLuma, darkPct });
  console.log(`      ${size}px 최소 밝기 ${minLuma} · 어두운 픽셀 ${darkPct}%`);
}

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

/** 축소본의 잉크. 가장 어두운 픽셀과 어두운 픽셀 비율 — 뭉갰는지 이 둘로 본다 */
function ink(buf, size) {
  const px = pixels(buf);
  let min = 255;
  let dark = 0;
  let opaque = 0;
  for (let i = 0; i < size * size; i++) {
    if (px[i * 4 + 3] < 128) continue;
    opaque += 1;
    const l = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
    if (l < min) min = l;
    if (l < 110) dark += 1;
  }
  return { minLuma: Math.round(min), darkPct: Number(((dark / opaque) * 100).toFixed(1)) };
}
