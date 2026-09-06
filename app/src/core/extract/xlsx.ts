// xlsx — 셀 값 + 수식 의존 그래프. "이 숫자가 어디서 왔나"에 답하는 부분.
import ExcelJS from 'exceljs';
import type { Chunk, Extraction, Relation } from '../types.ts';

// A1 / $A$1 / A1:B2 / 시트!A1 / '띄어쓴 시트'!A1
// 함수명(SUM 등)은 뒤에 '(' 가 오므로 걸러야 한다.
const REF = /(?:'([^']+)'|([A-Za-z가-힣_][\w가-힣.]*))?!?\$?([A-Z]{1,3})\$?(\d{1,7})(?::\$?([A-Z]{1,3})\$?(\d{1,7}))?/g;

export async function extractXlsx(file: string, sourceId: string): Promise<Extraction> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const chunks: Chunk[] = [];
  const relations: Relation[] = [];

  for (const ws of wb.worksheets) {
    const rows: string[] = [];
    ws.eachRow((row) => {
      const cells: string[] = [];
      row.eachCell((cell) => {
        const v = cell.value;
        const shown =
          v == null ? '' :
          typeof v === 'object' && 'formula' in v ? String((v as { result?: unknown }).result ?? `=${(v as { formula: string }).formula}`) :
          typeof v === 'object' && 'text' in v ? String((v as { text: unknown }).text) :
          String(v);
        if (shown) cells.push(shown);

        const formula = cell.formula ?? (cell.model as { formula?: string } | undefined)?.formula;
        if (!formula) return;
        const target = `${sourceId}#${ws.name}!${cell.address}`;
        for (const m of formula.matchAll(REF)) {
          if (!m[3]) continue;
          const sheet = m[1] ?? m[2] ?? ws.name;
          const from = m[5] ? `${sheet}!${m[3]}${m[4]}:${m[5]}${m[6]}` : `${sheet}!${m[3]}${m[4]}`;
          relations.push({ from: `${sourceId}#${from}`, to: target, kind: 'feeds', confidence: 'EXTRACTED' });
        }
      });
      if (cells.length) rows.push(cells.join(' | '));
    });
    if (rows.length) {
      chunks.push({ anchor: { sourceId, locator: ws.name, label: `시트 ${ws.name}` }, text: rows.join('\n') });
    }
  }

  return {
    sourceId, filename: file.split(/[/\\]/).pop() ?? file, kind: 'xlsx',
    chunks, relations,
    warnings: chunks.length === 0 ? ['시트에서 값을 찾지 못했습니다'] : [],
  };
}
