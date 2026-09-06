// W3 — Gemini 가 스키마 강제 없이 유효한 ChangeSet JSON 을 얼마나 안정적으로 내는가.
//
// PROVIDER-ROUTING.md §7 의 B등급 경로가 실현 가능한지가 여기 달려 있다.
// Gemini 에는 --json-schema / --output-schema 에 해당하는 플래그가 없으므로
// 프롬프트 지시 + 앱 검증 + 1회 재시도로 가야 하는데, 그 성공률을 모른다.
//
// 실행: node gemini-schema-check.mjs [횟수]
// 전제: Gemini 인증이 끝난 PC (GEMINI_API_KEY 또는 gemini 로그인)
//
// 출력은 손으로 옮겨 적을 수 있게 3줄이다.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const N = Number(process.argv[2] ?? 10);

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'update'] },
          path: { type: 'string', pattern: '^02_NOTES/(sources|entities|concepts|synthesis)/[a-z0-9-]+\\.md$' },
          content: { type: 'string' },
        },
        required: ['op', 'path', 'content'],
      },
    },
  },
  required: ['summary', 'ops'],
};

const PROMPT = `아래 원본을 인제스트하는 ChangeSet 을 만들어라.
설명을 붙이지 말고 \`\`\`json 펜스 블록 안에 JSON 하나만 출력하라.

[스키마]
${JSON.stringify(SCHEMA, null, 1)}

[규칙]
- path 는 반드시 02_NOTES/entities/<ascii-소문자-하이픈>.md 형식이다
- 모든 주장에 [^src-kickoff#slide-12] 형식 앵커 인용을 붙인다
- 엔티티 페이지 1개만 만든다

[원본: src-kickoff]
# 킥오프 회의록 (2026-09-03)
참석: 홍길동(구매팀), 김철수(에이콤)
- 에이콤(주)이 주 협력사로 확정됨. [slide-12]
- 계약 갱신일은 2027-01-15. [slide-12]`;

/** 펜스드 블록에서 JSON 회수. 펜스가 없으면 첫 { 부터 마지막 } 까지. */
function extractJson(out) {
  const fenced = out.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const raw = fenced ? fenced[1] : out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  try {
    return { ok: true, value: JSON.parse(raw), fenced: Boolean(fenced) };
  } catch (e) {
    return { ok: false, err: e.message.slice(0, 60), fenced: Boolean(fenced) };
  }
}

/** 의존성 없이 이 스키마만 검증한다 (ajv 를 사내에 설치 못 할 수 있으므로). */
function validate(v) {
  const errs = [];
  if (typeof v?.summary !== 'string') errs.push('summary');
  if (!Array.isArray(v?.ops) || v.ops.length === 0) {
    errs.push('ops');
    return errs;
  }
  const re = /^02_NOTES\/(sources|entities|concepts|synthesis)\/[a-z0-9-]+\.md$/;
  v.ops.forEach((o, i) => {
    if (!['create', 'update'].includes(o?.op)) errs.push(`ops[${i}].op`);
    if (typeof o?.path !== 'string' || !re.test(o.path)) errs.push(`ops[${i}].path`);
    if (typeof o?.content !== 'string' || !o.content) errs.push(`ops[${i}].content`);
  });
  return errs;
}

const tally = { json: 0, schema: 0, anchor: 0, fenced: 0, fail: 0 };
const pathFails = [];

for (let i = 0; i < N; i++) {
  let out = '';
  try {
    const r = await run('gemini', ['--skip-trust', '-y', '-p', PROMPT], {
      maxBuffer: 8 << 20,
      timeout: 180_000,
    });
    out = r.stdout;
  } catch (e) {
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }

  const got = extractJson(out);
  if (got.fenced) tally.fenced++;
  if (!got.ok) {
    tally.fail++;
    continue;
  }
  tally.json++;

  const errs = validate(got.value);
  if (errs.length === 0) tally.schema++;
  else pathFails.push(errs.join(','));

  const hasAnchor = (got.value.ops ?? []).some((o) => /\[\^[a-z0-9-]+#[^\]]+\]/.test(o.content ?? ''));
  if (hasAnchor) tally.anchor++;
}

const pct = (n) => `${Math.round((n / N) * 100)}%`;
console.log('');
console.log('===== 아래 3줄만 적어 주세요 =====');
console.log(`1 W3  n=${N} json=${pct(tally.json)} schema=${pct(tally.schema)} anchor=${pct(tally.anchor)}`);
console.log(`2 형식 fenced=${pct(tally.fenced)} 파싱실패=${tally.fail}`);
console.log(`3 위반 ${[...new Set(pathFails)].slice(0, 3).join(' / ') || '없음'}`);
console.log('==================================');
console.log('');
console.log('json=JSON 파싱 성공률 · schema=스키마 통과율 · anchor=앵커 인용 포함률');
console.log('schema 가 90% 미만이면 B등급 경로의 재시도 비용이 절감분을 잠식할 수 있음');
