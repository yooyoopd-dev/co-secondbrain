// W-O1~W-O4 — 로컬 LLM 경로가 성립하는지 사내 PC 에서 한 번에 잰다.
//
// 계획은 `docs/LOCAL-LLM.md` 에 있다. 여기서는 그 §7 의 네 가지만 본다.
//
// **사내 문서를 안 읽고 안 내보낸다.** 입력은 아래 SAMPLE 세 덩이가 전부이고 전부
// 이 파일 안에 적힌 합성 한국어다. 화면에 나가는 것은 PASS/FAIL 과 집계 수치뿐이다.
//
// 실행: node ollama-check.mjs
//       node ollama-check.mjs --selftest   (Ollama 를 안 부른다)
//
// 종료 코드: 0 통과 · 1 실패 · 2 안 돌았음(판정 아님)

const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
const CHAT_MODEL = process.env.SB_CHAT_MODEL ?? 'qwen2.5';
const EMBED_MODEL = process.env.SB_EMBED_MODEL ?? 'bge-m3';
const N = 5; // 형식 시험 회차. n=1 은 통계가 아니라 일화다 (CLAUDE.md §5)

/** 합성 위키 청크. 앵커는 실제 형식을 흉내 낸 가짜다 */
export const SAMPLE = [
  '에이콤은 2026년 상반기 주 협력사다.[^src-kickoff#slide-3]',
  '계약 갱신일은 3월 31일이다.[^src-kickoff#slide-12]',
  '담당은 구매팀이 맡는다.[^src-meeting#t-2]',
];

/** SAMPLE 안에 실제로 있는 앵커. 이것 말고를 답이 들면 지어낸 것이다 */
export function anchorsOf(chunks) {
  const out = new Set();
  for (const c of chunks) for (const m of c.matchAll(/\[\^([^\]]+)\]/g)) out.add(m[1]);
  return out;
}

/**
 * `app/src/core/query.ts` 의 ANSWER_SCHEMA 를 그대로 옮긴 것이다. 앱을 빌드하지 않고
 * 단독으로 돌아야 해서 베꼈다 — 사내 PC 에는 빌드 도구가 없다.
 * **저쪽이 바뀌면 여기도 고쳐야 한다.** 안 그러면 여기서 통과한 것이 앱에서 막힌다.
 */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', description: '한국어 답변. 두세 문장' },
    claims: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '근거가 되는 사실 한 문장' },
          source: { type: 'string', description: '앵커 인용. `src-kickoff#slide-12` 형태' },
        },
        required: ['text', 'source'],
        additionalProperties: false,
      },
    },
    pages: { type: 'array', items: { type: 'string', description: '참고한 위키 페이지 경로' } },
  },
  required: ['answer', 'claims'],
  additionalProperties: false,
};

/** 답이 스키마를 맞췄는가. 지어낸 앵커도 같이 센다 */
export function judge(raw, allowed) {
  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    return { valid: false, schema: false, invented: 0 };
  }
  const schema =
    typeof j.answer === 'string' &&
    Array.isArray(j.claims) &&
    j.claims.every((c) => c && typeof c.text === 'string' && typeof c.source === 'string');
  if (!schema) return { valid: true, schema: false, invented: 0 };
  const invented = j.claims.filter((c) => !allowed.has(c.source)).length;
  return { valid: true, schema: true, invented };
}

let fails = 0;
function ok(name, cond, note = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${note ? `  ${note}` : ''}`);
  if (!cond) fails += 1;
}

if (process.argv.includes('--selftest')) {
  const a = anchorsOf(SAMPLE);
  ok('표본에서 앵커 셋을 뽑는다', a.size === 3);
  ok('표본 앵커를 알아본다', a.has('src-kickoff#slide-3'));
  ok('JSON 이 아니면 무효다', judge('그냥 글', a).valid === false);
  ok('모양이 틀리면 스키마 실패다', judge('{"answer":"가"}', a).schema === false);
  const good = JSON.stringify({ answer: '가', claims: [{ text: '나', source: 'src-kickoff#slide-3' }] });
  ok('맞는 앵커는 지어낸 것이 아니다', judge(good, a).invented === 0);
  const bad = JSON.stringify({ answer: '가', claims: [{ text: '나', source: 'src-kickoff#p-99' }] });
  ok('없는 앵커를 센다', judge(bad, a).invented === 1);
  process.exit(fails === 0 ? 0 : 1);
}

async function post(path, body, timeoutMs = 180_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return await r.json();
  } catch (e) {
    return { error: String(e instanceof Error ? e.message : e) };
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- W-O1 무엇이 깔려 있나 ---------------- */

let tags;
try {
  const r = await fetch(`${HOST}/api/tags`, { signal: AbortSignal.timeout(10_000) });
  tags = await r.json();
} catch (e) {
  console.error(`Ollama 에 못 붙었습니다 (${HOST}). 떠 있는지 확인하십시오.`);
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(2);
}

const names = (tags.models ?? []).map((m) => m.name);
const chat = names.find((n) => n.startsWith(CHAT_MODEL));
const embed = names.find((n) => n.startsWith(EMBED_MODEL));
console.log(`깔린 모델 ${names.length}개`);
ok('W-O1 대화 모델이 있다', chat !== undefined, chat ?? `${CHAT_MODEL} 없음`);
ok('W-O1 임베딩 모델이 있다', embed !== undefined, embed ?? `${EMBED_MODEL} 없음 — ollama pull ${EMBED_MODEL}`);
if (!chat || !embed) {
  console.error('\n둘 다 있어야 나머지를 잽니다. 이 회차는 표본이 아닙니다.');
  process.exit(2);
}

/* ---------------- W-O2 임베딩 차원과 속도 ---------------- */

const t0 = Date.now();
const emb = await post('/api/embed', { model: embed, input: SAMPLE });
const ms = Date.now() - t0;
if (emb.error) {
  console.error(`임베딩 호출이 실패했습니다: ${emb.error}`);
  process.exit(2);
}
const dim = emb.embeddings?.[0]?.length ?? 0;
const per = Math.round(ms / SAMPLE.length);
ok('W-O2 차원이 1024 다', dim === 1024, `${dim}차원`);
console.log(`      청크당 ${per}ms — 5,000 청크면 약 ${Math.round((per * 5000) / 60000)}분`);

/* ---------------- W-O3 · W-O4 형식과 앵커 ---------------- */

const allowed = anchorsOf(SAMPLE);
const PROMPT = [
  '아래 위키 조각만 보고 답한다. 조각에 없는 것은 모른다고 한다.',
  '주장마다 그 주장이 나온 조각의 대괄호 안 앵커를 source 에 그대로 적는다.',
  '',
  ...SAMPLE.map((c, i) => `조각 ${i + 1}: ${c}`),
  '',
  '질문: 계약 갱신일은 언제이고 담당은 어디인가?',
].join('\n');

let valid = 0;
let schema = 0;
let invented = 0;
let chatMs = 0;
for (let i = 0; i < N; i++) {
  const t = Date.now();
  const r = await post('/api/chat', {
    model: chat,
    stream: false,
    format: ANSWER_SCHEMA,
    messages: [{ role: 'user', content: PROMPT }],
  });
  chatMs += Date.now() - t;
  if (r.error) {
    console.error(`대화 호출이 실패했습니다: ${r.error}`);
    process.exit(2);
  }
  const v = judge(r.message?.content ?? '', allowed);
  if (v.valid) valid += 1;
  if (v.schema) schema += 1;
  invented += v.invented;
}

console.log('');
console.log(`W-O3 유효 JSON      : ${valid}/${N}`);
console.log(`W-O3 스키마 일치    : ${schema}/${N}`);
console.log(`W-O4 지어낸 앵커    : ${invented}건`);
console.log(`     회차당 ${Math.round(chatMs / N)}ms`);
console.log('');

ok('W-O3 형식을 전부 맞췄다', schema === N);
ok('W-O4 없는 앵커를 안 지어냈다', invented === 0);

if (fails > 0) {
  console.log('');
  console.log('하나라도 FAIL 이면 docs/LOCAL-LLM.md §7 을 보십시오.');
  console.log('W-O3 이 안 나오면 그 계획은 접는 편이 낫습니다.');
}
process.exit(fails === 0 ? 0 : 1);
