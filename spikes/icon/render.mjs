#!/usr/bin/env node
// SVG 한 장에서 앱 아이콘 자산을 만든다. 손으로 만든 이진 파일을 저장소에 두지 않기 위해서다.
//
// 만드는 것:
//   app/src/renderer/public/icon-256.png  창 아이콘 · 첫 화면 마크 (vite 가 그대로 복사한다)
//   design/icon/icon.ico                  16~256 여섯 크기를 담은 다중 해상도 (20번 NSIS 가 쓴다)
//   design/icon/out/icon-*.png            눈으로 볼 중간 산물. `out/` 은 커밋하지 않는다
//
// **개발 컨테이너 전용이다.** 전역 playwright 의 크로미움으로 래스터화한다. 사내 PC 는
// 이 스크립트를 돌리지 않는다 — 결과물이 저장소에 커밋돼 있다.
//
//   node spikes/icon/render.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'design', 'icon', 'co-secondbrain.svg');
const OUT = path.join(ROOT, 'design', 'icon', 'out');
const ICO = path.join(ROOT, 'design', 'icon', 'icon.ico');
const APP_ICON = path.join(ROOT, 'app', 'src', 'renderer', 'public', 'icon-256.png');
const SIZES = [16, 32, 48, 64, 128, 256, 512];
/** .ico 안에 넣을 크기. 256 까지만 담는다 — 그 위는 Windows 가 안 본다 */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

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

const svg = fs.readFileSync(SRC, 'utf8');
fs.mkdirSync(OUT, { recursive: true });

const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();

/** 배경을 빼고 찍는다. 판 바깥은 투명이라야 어두운 작업 표시줄에서도 같은 모양이다 */
async function raster(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  return page.screenshot({ omitBackground: true });
}

const pngs = new Map();
for (const size of SIZES) {
  const buf = await raster(size);
  pngs.set(size, buf);
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), buf);
}
await browser.close();

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

for (const size of SIZES) {
  const { width, height, hasAlpha } = readPngHeader(pngs.get(size));
  ok(`${size}px 가 ${size}×${size} 로 나온다`, width === size && height === size, { width, height });
  if (size === 256) ok('알파 채널이 있다', hasAlpha, { hasAlpha });
}

// 판 바깥은 투명이어야 한다. 어두운 배경이 그대로 남았으면 여기서 걸린다.
const corner = cornerAlpha(pngs.get(64));
ok('모서리가 투명하다 — 어두운 배경이 남지 않았다', corner === 0, { corner });

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

/** 좌상단 첫 픽셀의 알파. IDAT 를 풀어 첫 줄만 본다 (필터 바이트 하나 + RGBA) */
function cornerAlpha(buf) {
  const chunks = [];
  let p = 8;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') chunks.push(buf.subarray(p + 8, p + 8 + len));
    p += len + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  // 첫 줄 첫 픽셀은 어떤 필터든 왼쪽·위 이웃이 0 이라 원값이 그대로 남는다
  return raw[4];
}
