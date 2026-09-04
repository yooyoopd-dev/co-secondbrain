// M0 항목 6 — 추출기 실측. 텍스트 + 앵커 + 구조를 실제 파일에서 뽑는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { simpleParser } from 'mailparser';

const DIR = new URL('../fixtures/files/', import.meta.url).pathname;
const f = n => path.join(DIR, n);
const results = [];
const record = (name, ok, detail, extra = {}) => results.push({ name, ok, detail, ...extra });

/* ============ docx — 제목 트리 ============ */
async function docx() {
  const t0 = Date.now();
  const { value: html } = await mammoth.convertToHtml({ path: f('kickoff.docx') });
  const stack = [];
  const nodes = [];
  for (const m of html.matchAll(/<h([1-6])>(.*?)<\/h\1>|<p>(.*?)<\/p>/g)) {
    if (m[1]) {
      const lvl = +m[1];
      while (stack.length >= lvl) stack.pop();
      stack.push(m[2].replace(/<[^>]+>/g, ''));
      nodes.push({ kind: 'heading', level: lvl, text: stack[stack.length - 1], anchor: stack.join(' > ') });
    } else if (m[3]) {
      nodes.push({ kind: 'para', text: m[3].replace(/<[^>]+>/g, ''), anchor: stack.join(' > ') });
    }
  }
  const deepest = nodes.filter(n => n.kind === 'para').map(n => n.anchor);
  record('docx 제목 트리', nodes.length > 0 && deepest.some(a => a.includes(' > ')),
    `노드 ${nodes.length}개. 최심 앵커: "${deepest[deepest.length - 1]}"`, { ms: Date.now() - t0 });
  return nodes;
}

/* ============ xlsx — 수식 의존 그래프 ============ */
async function xlsx() {
  const t0 = Date.now();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(f('cost.xlsx'));
  const edges = [];
  // A1 / $A$1 / A1:B2 / 시트!A1  — 함수명(SUM 등)은 뒤에 '(' 가 오므로 제외
  const REF = /(?:'([^']+)'|([A-Za-z가-힣_][\w가-힣.]*))?!?\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?/g;
  for (const ws of wb.worksheets) {
    ws.eachRow(row => row.eachCell(cell => {
      const fm = cell.formula ?? cell.model?.formula;
      if (!fm) return;
      const target = `${ws.name}!${cell.address}`;
      for (const m of fm.matchAll(REF)) {
        if (!m[3]) continue;
        const sheet = m[1] || m[2] || ws.name;
        const from = m[5] ? `${sheet}!${m[3]}${m[4]}:${m[5]}${m[6]}` : `${sheet}!${m[3]}${m[4]}`;
        edges.push({ from, to: target, relation: 'feeds', confidence: 'EXTRACTED' });
      }
    }));
  }
  const cross = edges.filter(e => e.from.split('!')[0] !== e.to.split('!')[0]);
  record('xlsx 수식 의존 그래프', edges.length >= 4 && cross.length >= 1,
    `엣지 ${edges.length}개, 시트 간 참조 ${cross.length}개. 예: ${edges.map(e=>e.from+'→'+e.to).slice(0,4).join(', ')}`,
    { ms: Date.now() - t0 });
  return edges;
}

/* ============ pptx — 슬라이드 + 발표자 노트 ============ */
async function pptx() {
  const t0 = Date.now();
  const zip = await JSZip.loadAsync(await fs.readFile(f('kickoff.pptx')));
  const p = new XMLParser({ ignoreAttributes: false, isArray: () => false });
  const text = obj => {
    const out = [];
    (function walk(o) {
      if (o == null) return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (typeof o === 'object') {
        for (const [k, v] of Object.entries(o)) { if (k === 'a:t') out.push(String(v)); else walk(v); }
      }
    })(obj);
    return out;
  };
  const slides = [];
  const names = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (+a.match(/(\d+)/)[1]) - (+b.match(/(\d+)/)[1]));
  for (const n of names) {
    const idx = +n.match(/(\f|\d)+/g).pop();
    const parts = text(p.parse(await zip.file(n).async('string')));
    const nf = zip.file(`ppt/notesSlides/notesSlide${idx}.xml`);
    const notes = nf ? text(p.parse(await nf.async('string'))) : [];
    slides.push({ slide: idx, anchor: `slide-${idx}`, title: parts[0] ?? '', body: parts.slice(1), notes });
  }
  const withNotes = slides.filter(s => s.notes.length);
  record('pptx 슬라이드 + 노트', slides.length === 2 && withNotes.length === 1,
    `슬라이드 ${slides.length}개, 노트 있는 슬라이드 ${withNotes.length}개. 노트: "${withNotes[0]?.notes[0] ?? '-'}"`,
    { ms: Date.now() - t0 });
  return slides;
}

/* ============ pdf — 텍스트 + 스캔본 감지 ============ */
async function pdf() {
  const t0 = Date.now();
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const read = async file => {
    const doc = await getDocument({ data: new Uint8Array(await fs.readFile(f(file))), useSystemFonts: true }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      pages.push({ page: i, anchor: `page-${i}`, text: c.items.map(it => it.str).join(' ').trim() });
    }
    return pages;
  };
  const good = await read('report.pdf');
  const scan = await read('scanned.pdf');
  const chars = ps => ps.reduce((a, p) => a + p.text.length, 0);
  const perPage = ps => chars(ps) / ps.length;
  record('pdf 텍스트 추출', chars(good) > 30, `${good.length}쪽, ${chars(good)}자. p1="${good[0].text.slice(0, 40)}"`, { ms: Date.now() - t0 });
  record('pdf 스캔본 감지', perPage(scan) < 10 && perPage(good) > 10,
    `정상 ${perPage(good).toFixed(1)}자/쪽 vs 스캔본 ${perPage(scan).toFixed(1)}자/쪽 → 임계 10자/쪽으로 분리 가능`);
  return good;
}

/* ============ eml — 스레드 트리 복원 ============ */
async function email() {
  const t0 = Date.now();
  const msgs = [];
  for (const n of ['mail-3.eml', 'mail-1.eml', 'mail-2.eml']) {   // 일부러 순서를 섞음
    const m = await simpleParser(await fs.readFile(f(n)));
    const norm = v => String(v ?? '').replace(/[<>]/g, '').trim();
    msgs.push({
      file: n,
      id: norm(m.messageId),
      inReplyTo: m.inReplyTo ? norm(m.inReplyTo) : null,
      references: (Array.isArray(m.references) ? m.references : m.references ? [m.references] : []).map(norm),
      subject: m.subject, from: m.from?.text, date: m.date,
      body: (m.text ?? '').trim(),
    });
  }
  const byId = new Map(msgs.map(m => [m.id, m]));
  const roots = [];
  for (const m of msgs) {
    m.children = m.children ?? [];
    const parentId = m.inReplyTo ?? m.references[m.references.length - 1] ?? null;
    const parent = parentId ? byId.get(parentId) : null;
    if (parent) { parent.children = parent.children ?? []; parent.children.push(m); }
    else roots.push(m);
  }
  const depth = n => 1 + Math.max(0, ...(n.children ?? []).map(depth));
  const ok = roots.length === 1 && depth(roots[0]) === 3;
  const chain = (function walk(n, d = 0) { return [`${'  '.repeat(d)}${n.subject}`, ...(n.children ?? []).flatMap(c => walk(c, d + 1))]; })(roots[0]);
  record('이메일 스레드 복원', ok,
    `메시지 3통(입력 순서 무작위) → 루트 ${roots.length}개, 깊이 ${depth(roots[0])}\n      ${chain.join('\n      ')}`,
    { ms: Date.now() - t0 });
  return roots;
}

/* ============ vtt — 화자 턴 ============ */
async function vtt() {
  const t0 = Date.now();
  const raw = await fs.readFile(f('meeting.vtt'), 'utf8');
  const turns = [];
  for (const m of raw.matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})\s*\n(.*)/g)) {
    const sp = m[3].match(/^<v ([^>]+)>(.*)$/);
    turns.push({ start: m[1], anchor: `t-${m[1]}`, speaker: sp?.[1] ?? null, text: (sp?.[2] ?? m[3]).trim() });
  }
  record('vtt 화자 턴', turns.length === 2 && turns.every(t => t.speaker),
    `턴 ${turns.length}개, 화자 ${[...new Set(turns.map(t => t.speaker))].join('/')}. 앵커 예: ${turns[0]?.anchor}`,
    { ms: Date.now() - t0 });
  return turns;
}

const out = {};
for (const [k, fn] of Object.entries({ docx, xlsx, pptx, pdf, email, vtt })) {
  try { out[k] = await fn(); }
  catch (e) { record(`${k} (예외)`, false, `${e.constructor.name}: ${e.message}`); }
}

console.log('\n=== M0 항목 6 · 추출기 실측 ===\n');
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ms != null ? `  (${r.ms}ms)` : ''}`);
  console.log(`      ${r.detail}\n`);
}
const pass = results.filter(r => r.ok).length;
console.log(`합계 ${pass}/${results.length} 통과`);
await fs.mkdir(new URL('../out/', import.meta.url).pathname, { recursive: true });
await fs.writeFile(new URL('../out/extract.json', import.meta.url).pathname, JSON.stringify({ results, out }, null, 1));
process.exit(pass === results.length ? 0 : 1);
