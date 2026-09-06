// M0 스파이크용 샘플 문서 생성. 실제 라이브러리로 만들어 실제 라이브러리로 읽는다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';

// `.pathname` 은 Windows 에서 `/D:/...` 를 준다. 앞의 슬래시가 붙은 채로 fs 에 들어가면
// 엉뚱한 자리에 만든다. 변환은 `fileURLToPath` 에게 맡긴다.
const DIR = fileURLToPath(new URL('./files/', import.meta.url));
await fs.mkdir(DIR, { recursive: true });
const w = (n, b) => fs.writeFile(path.join(DIR, n), b);

/* ---------- docx: 제목 트리 검증용 ---------- */
await w('kickoff.docx', await Packer.toBuffer(new Document({
  sections: [{ children: [
    new Paragraph({ text: '2026 ACME 프로젝트', heading: HeadingLevel.HEADING_1 }),
    new Paragraph('구매팀 주관 킥오프 회의록.'),
    new Paragraph({ text: '협력사 현황', heading: HeadingLevel.HEADING_2 }),
    new Paragraph('에이콤(주)이 주 협력사로 확정되었다.'),
    new Paragraph({ text: '계약 조건', heading: HeadingLevel.HEADING_2 }),
    new Paragraph('계약 갱신일은 2027-01-15이다.'),
    new Paragraph({ text: '리스크', heading: HeadingLevel.HEADING_3 }),
    new Paragraph('갱신일에 대해 8월 메일과 불일치가 있다.'),
  ]}],
})));

/* ---------- xlsx: 수식 의존 그래프 검증용 ---------- */
{
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('원가');
  s.getCell('A1').value = '항목'; s.getCell('B1').value = '단가'; s.getCell('C1').value = '수량'; s.getCell('D1').value = '금액';
  s.getCell('A2').value = '라이선스'; s.getCell('B2').value = 1200000; s.getCell('C2').value = 12;
  s.getCell('D2').value = { formula: 'B2*C2' };
  s.getCell('A3').value = '유지보수'; s.getCell('B3').value = 300000;  s.getCell('C3').value = 12;
  s.getCell('D3').value = { formula: 'B3*C3' };
  s.getCell('A4').value = '합계';
  s.getCell('D4').value = { formula: 'SUM(D2:D3)' };
  const s2 = wb.addWorksheet('요약');
  s2.getCell('A1').value = '총원가';
  s2.getCell('B1').value = { formula: "원가!D4*1.1" };   // 시트 간 참조
  await wb.xlsx.writeFile(path.join(DIR, 'cost.xlsx'));
}

/* ---------- pptx: 슬라이드 계층 + 발표자 노트 (OOXML 직접 생성) ---------- */
{
  const zip = new JSZip();
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  const slide = (title, body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${esc(title)}</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${esc(body)}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;
  const notes = t => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>
<p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:notes>`;
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('ppt/slides/slide1.xml', slide('2026 ACME 프로젝트 킥오프', '구매팀 주관'));
  zip.file('ppt/slides/slide2.xml', slide('협력사 현황', '에이콤(주) 주 협력사 확정'));
  zip.file('ppt/notesSlides/notesSlide2.xml', notes('에이콤 계약 갱신일 확인 필요'));
  await w('kickoff.pptx', await zip.generateAsync({ type: 'nodebuffer' }));
}

/* ---------- pdf: 텍스트 있는 것 / 없는 것(스캔본 모사) ---------- */
{
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595, 842]);
  p.drawText('ACME Project Kickoff 2026', { x: 60, y: 760, size: 18, font: f });
  p.drawText('Contract renewal: 2027-01-15', { x: 60, y: 720, size: 11, font: f });
  await w('report.pdf', await d.save());

  const d2 = await PDFDocument.create();          // 텍스트 레이어 없음 = 스캔본
  d2.addPage([595, 842]);
  d2.addPage([595, 842]);
  await w('scanned.pdf', await d2.save());
}

/* ---------- eml: 스레드 3통 (In-Reply-To / References) ---------- */
{
  const mk = (id, subj, from, to, date, refs, body) =>
    `Message-ID: <${id}>\r\nSubject: ${subj}\r\nFrom: ${from}\r\nTo: ${to}\r\nDate: ${date}\r\n` +
    (refs ? `In-Reply-To: <${refs[refs.length-1]}>\r\nReferences: ${refs.map(r=>`<${r}>`).join(' ')}\r\n` : '') +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
  await w('mail-1.eml', mk('a1@acme.example', '계약 갱신 일정', '홍길동 <gd.hong@corp.example>', '김철수 <cs.kim@acme.example>',
    'Wed, 19 Aug 2026 09:00:00 +0900', null, '갱신일 2027-01-15로 확인 부탁드립니다.'));
  await w('mail-2.eml', mk('a2@acme.example', 'RE: 계약 갱신 일정', '김철수 <cs.kim@acme.example>', '홍길동 <gd.hong@corp.example>',
    'Thu, 20 Aug 2026 10:30:00 +0900', ['a1@acme.example'], '2027-03-01로 조정 요청드립니다.'));
  await w('mail-3.eml', mk('a3@acme.example', 'RE: RE: 계약 갱신 일정', '홍길동 <gd.hong@corp.example>', '김철수 <cs.kim@acme.example>',
    'Thu, 20 Aug 2026 14:00:00 +0900', ['a1@acme.example','a2@acme.example'], '내부 검토 후 회신드리겠습니다.'));
}

/* ---------- vtt: 전사 ---------- */
await w('meeting.vtt', `WEBVTT

00:00:05.000 --> 00:00:12.400
<v 홍길동>에이콤 계약 갱신일이 문서마다 다릅니다.

00:00:12.400 --> 00:00:19.000
<v 김철수>1월 15일이 맞고 3월은 조정 요청이었습니다.
`);

console.log('생성 완료:', (await fs.readdir(DIR)).sort().join(', '));
