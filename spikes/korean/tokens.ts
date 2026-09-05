// W10 — 한국어 글자수를 토큰수로 환산한다. docs/ROADMAP.md 8번
//
// Lint 전수 검사를 돌리기 전에 "이 스캔에 약 얼마" 를 사람에게 보여주려면 환산이 필요하다.
// 추측하지 않고 실제 CLI 응답의 과금 내역으로 잰다.
//
// 방법: 프롬프트 **접두사를 고정**하고 뒤에 붙는 한국어 분량만 바꾼다. CLI 자기 시스템
// 프롬프트는 cache 읽기로 빠지므로 cache 생성 + input 이 우리 내용에 해당한다
// (M2-PLAN.md §2.3 에서 확인한 구조다).
//
// 한계: 표본이 크기당 1회다. 같은 텍스트를 다른 크기로 자른 것이라 문체가 한 종류다.
import fs from 'node:fs/promises';
import { createClaudeCode } from '../../app/src/core/agent/claude-code.ts';
import { prepareWorkdir, disposeWorkdir } from '../../app/src/core/agent/workdir.ts';

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const SIZES = [0, 500, 1500, 4000, 8000];

/** 실제 위키에 들어갈 법한 한국어 기술 산문. 이 저장소 문서에서 가져온다. */
async function corpus(): Promise<string> {
  const parts: string[] = [];
  for (const f of ['docs/PLAN.md', 'docs/M0-RESULTS.md', 'docs/HUB.md']) {
    parts.push(await fs.readFile(new URL(`../../${f}`, import.meta.url), 'utf8'));
  }
  // 코드블록과 표를 걷어낸다. 위키 페이지 본문에 가까운 산문만 남긴다.
  return parts
    .join('\n')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\|.*$/gm, '')
    .replace(/^#+ .*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const text = await corpus();
const wd = await prepareWorkdir({});
const cli = createClaudeCode();

console.log(`말뭉치 ${text.length}자 · 접두사 고정 · 크기 ${SIZES.join(', ')}자\n`);
console.log('글자수   cache생성  cache읽기  input   합계    비용        토큰/글자');

const rows: { chars: number; tokens: number; costUsd: number }[] = [];
for (const n of SIZES) {
  const body = n === 0 ? '' : `\n\n## 참고 자료\n\n${text.slice(0, n)}`;
  const prompt = `아래 참고 자료를 읽지 말고 ok 에 true 만 답하라.${body}`;
  const r = await cli.run({ workdir: wd.root, prompt }, SCHEMA);
  if (!r.ok) {
    console.log(`${n} 실패: ${r.error}`);
    continue;
  }
  const u = r.usage;
  const tokens = u.cacheCreationTokens + u.inputTokens;
  rows.push({ chars: n, tokens, costUsd: u.costUsd });
  console.log(
    `${String(n).padStart(6)}  ${String(u.cacheCreationTokens).padStart(9)}  ${String(u.cacheReadTokens).padStart(9)}  ${String(u.inputTokens).padStart(5)}  ${String(tokens).padStart(6)}  $${u.costUsd.toFixed(5)}  ${n ? (tokens / n).toFixed(4) : '-'}`,
  );
}
await disposeWorkdir(wd);

// 기울기가 우리가 원하는 값이다. 절편(고정 오버헤드)은 빼고 본다.
const base = rows[0];
console.log('\n증분 기준 (0자 대비):');
console.log('글자수   증분 토큰   토큰/글자');
for (const r of rows.slice(1)) {
  const d = r.tokens - (base?.tokens ?? 0);
  console.log(`${String(r.chars).padStart(6)}  ${String(d).padStart(9)}  ${(d / r.chars).toFixed(4)}`);
}
const last = rows[rows.length - 1];
if (base && last && last.chars > 0) {
  const ratio = (last.tokens - base.tokens) / last.chars;
  console.log(`\n최대 크기 기준 토큰/글자 = ${ratio.toFixed(4)}`);
  console.log(`총 비용 $${rows.reduce((s, r) => s + r.costUsd, 0).toFixed(4)}`);
}
