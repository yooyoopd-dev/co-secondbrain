#!/usr/bin/env node
// 사내 PC 회수 스크립트 — W2 · W3 · W3b. docs/ROADMAP.md §4
//
// 사내 PC 에서 **이 파일 하나만** 돌리면 CLI 3종의 원시 응답이 파일로 떨어진다.
// 사내에서 개발하지 않는다. 회수한 응답으로 파서를 개발 쪽에서 완성한다.
//
// 규약 (CLAUDE.md §9):
// - 입력은 전부 **합성 데이터**다. 사내 문서를 읽지 않으므로 원시 응답을 그대로 커밋해도 된다
// - 정답(어떤 앵커가 실재하는가)을 알고 돌린다. 없는 앵커를 인용하면 FAIL 이다
// - **오탐 0 이어야 하는 검사(없는 앵커 인용)를 종료 코드로 강제한다**
// - 합성 데이터의 한계: 원본이 두세 줄이라 실제 사내 문서의 길이·잡음을 재지 못한다
//
// 의존성이 없다. Node 만 있으면 된다 (`npm install` 불필요).
//
//   node spikes/cli/record.mjs                      전체
//   node spikes/cli/record.mjs --only gemini --n 1   하나만
//   node spikes/cli/record.mjs --timeout 60             한 건당 대기 상한(초, 기본 180)
//
// 환경변수: 개인 Gemini 키를 쓰는 경우에만 GEMINI_API_KEY. 사내 기업계정은 불필요.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ *
 * app/src/core/agent 와 같은 값. 어긋나면 app/test/record.test.ts 가 잡는다.
 * ------------------------------------------------------------------ */

export const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '이 변경안이 무엇을 하는지 한국어 한 줄. diff 검토 화면 제목이 된다' },
    discussion: { type: 'string', description: '사람에게 물을 것이 있으면 여기에. 없으면 생략한다' },
    ops: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['create', 'update', 'delete'] },
          path: { type: 'string', pattern: '(?:^wiki/overview\\.md$)|(?:^wiki\\/(sources|entities|concepts|synthesis)\\/[a-z0-9가-힣-]+\\.md$)' },
          baseHash: { type: ['string', 'null'], description: 'update·delete 는 지금 페이지의 해시, create 는 null' },
          content: { type: 'string', description: 'YAML front-matter 로 시작하는 페이지 전문. delete 는 생략한다' },
        },
        required: ['op', 'path', 'baseHash'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'ops'],
  additionalProperties: false,
};

export const PAGE_TEMPLATE =
  '---\nid: ent-example\ntype: entity\ntitle: 보기\nsummary: 한 줄 요약.\nclassification: internal\ndoc_genre: null\naliases: []\ntags: []\nclaims:\n  - text: 주장 한 문장.\n    source: src-example#slide-1\n    confidence: EXTRACTED\nopen_questions: []\nderived_from: null\ngenerated_by: claude-code\nupdated: 2026-09-05T00:00:00.000Z\nupdated_by: app\n---\n# 보기\n\n주장 한 문장.[^src-example#slide-1]\n';

export const CONVENTION = `# 위키 규약

- 모든 주장에 앵커 인용을 붙인다. 출처 없는 문장은 쓰지 않는다
- confidence 는 EXTRACTED · INFERRED · AMBIGUOUS 중 하나
- 한국어로 쓴다. 이모지를 쓰지 않는다

## 페이지 형식 (앱이 만든 표본 — 키 이름과 순서를 바꾸지 않는다)

\`\`\`markdown
${PAGE_TEMPLATE}\`\`\`
`;

/** 정답을 아는 입력. `anchors` 밖을 인용하면 FAIL 이다. */
export const CASES = [
  {
    id: 'kickoff',
    sourceId: 'src-kickoff',
    filename: '킥오프.pptx',
    chunks: [
      ['slide-3', '에이콤(주)이 2026년 하반기 주 협력사로 선정됐다.'],
      ['slide-12', '에이콤과의 계약 갱신일은 2026-12-31 이다.'],
    ],
  },
  {
    id: 'contract',
    sourceId: 'src-contract',
    filename: '계약서.docx',
    chunks: [['page-2', '베타테크는 2026-11-30 까지 납품을 완료한다.']],
  },
  {
    id: 'cost',
    sourceId: 'src-cost',
    filename: '원가.xlsx',
    chunks: [['원가!D4', '델타물류의 월 운송비는 1,200만원이다.']],
  },
];

export function promptFor(c, withSchema) {
  const anchors = c.chunks.map(([loc]) => `${c.sourceId}#${loc}`);
  const body = c.chunks.map(([loc, text]) => `- ${loc}: ${text}`).join('\n');
  const tail = withSchema
    ? `\n\n## 출력 형식\n\n아래 JSON Schema 를 정확히 지키는 JSON 하나만 낸다. 다른 말을 덧붙이지 않는다.\n\n\`\`\`json\n${JSON.stringify(SCHEMA, null, 1)}\n\`\`\``
    : '';
  return `아래 원본에서 위키를 갱신하는 ChangeSet 을 내라. 도구는 쓸 수 없다. 주어진 내용만 쓴다.

## 원본 ${c.sourceId} (${c.filename})

${body}

## 쓸 수 있는 앵커

${anchors.join(' · ')}

없는 앵커를 인용하면 변경안 전체가 거부된다.

## 지금 위키에 있는 페이지

없다. 전부 create 다.${tail}`;
}

/* ------------------------------------------------------------------ *
 * 검사 — 정답을 알고 판정한다
 * ------------------------------------------------------------------ */

const PATH_RE = /^wiki\/(overview\.md|(sources|entities|concepts|synthesis)\/[a-z0-9가-힣-]+\.md)$/;
const CITE_RE = /\[\^([a-z0-9가-힣-]+)#([^\]]+)\](?!:)/gi;

export function stripFence(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

/** 원시 응답에서 마지막 JSON 객체를 건져 본다. 봉투 형식을 모르는 CLI 용. */
function looseJson(s) {
  const start = s.indexOf('{');
  for (let i = start; i >= 0; i = s.indexOf('{', i + 1)) {
    for (let j = s.lastIndexOf('}'); j > i; j = s.lastIndexOf('}', j - 1)) {
      try {
        const o = JSON.parse(s.slice(i, j + 1));
        if (o && typeof o === 'object' && Array.isArray(o.ops)) return o;
      } catch {
        /* 다음 후보 */
      }
    }
  }
  return null;
}

export function check(cs, c) {
  const bad = [];
  const known = new Set(c.chunks.map(([loc]) => `${c.sourceId}#${loc}`));
  if (!cs || typeof cs !== 'object') return { ok: false, fatal: false, reasons: ['ChangeSet 이 객체가 아니다'] };
  if (typeof cs.summary !== 'string' || !cs.summary.trim()) bad.push('summary 가 비었다');
  if (!Array.isArray(cs.ops) || cs.ops.length === 0) return { ok: false, fatal: false, reasons: [...bad, 'ops 가 비었다'] };

  let fatal = false;
  for (const op of cs.ops) {
    if (!PATH_RE.test(String(op.path))) bad.push(`경로 형식 위반: ${op.path}`);
    if (op.op === 'create' && op.baseHash !== null) bad.push(`create 에 baseHash 가 있다: ${op.path}`);
    const content = typeof op.content === 'string' ? op.content : '';
    if (op.op !== 'delete' && !content.startsWith('---\n')) bad.push(`front-matter 로 시작하지 않는다: ${op.path}`);
    for (const m of content.matchAll(CITE_RE)) {
      const ref = `${m[1]}#${m[2]}`;
      // 오탐 0 대상 — 없는 앵커 인용은 종료 코드로 강제한다
      if (!known.has(ref)) {
        bad.push(`없는 앵커를 인용했다: ${ref}`);
        fatal = true;
      }
    }
  }
  return { ok: bad.length === 0, fatal, reasons: bad };
}

/* ------------------------------------------------------------------ *
 * CLI 규약. 프롬프트는 전부 stdin 으로 넘긴다 — Windows argv 인용부호를 피한다.
 * ------------------------------------------------------------------ */

const BLOCKED = ['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite'];

const CLIS = [
  {
    id: 'claude-code',
    bin: 'claude',
    conventionFile: 'CLAUDE.md',
    schemaInPrompt: false,
    // `--json-schema` 는 인라인 JSON 만 받는다 (파일 경로 거부, 2026-09-05 실측).
    // 그래서 Windows 에서 cmd 메타문자(^ | \)가 argv 로 나간다. 이게 W2 의 관건이다.
    args: (wd) => ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(SCHEMA), '--strict-mcp-config', '--disallowedTools', ...BLOCKED],
    extract: (out) => JSON.parse(out).structured_output ?? null,
    verified: true,
  },
  {
    id: 'gemini',
    bin: 'gemini',
    conventionFile: 'GEMINI.md',
    schemaInPrompt: true, // B등급 — CLI 가 스키마를 강제하지 못한다
    args: () => ['--skip-trust', '--approval-mode', 'plan'],
    extract: (out) => JSON.parse(stripFence(out)),
    verified: true,
  },
  {
    id: 'codex',
    bin: 'codex',
    conventionFile: 'AGENTS.md',
    schemaInPrompt: false,
    args: (wd) => ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-schema', path.join(wd, 'schema.json')],
    // 실제 출력 형태를 못 봤다 (개발 컨테이너에서 api.openai.com 이 차단됨).
    // 추측으로 파서를 쓰지 않는다. 원시 응답을 회수하는 것이 이 CLI 에서의 목적이다.
    extract: (out) => looseJson(out),
    verified: false,
  },
];

/** 무엇을 찾았는지 보고에 남긴다. `.cmd` 면 shell 을 거쳐야 해서 인용부호 위험이 생긴다. */
function resolveBin(bin) {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'where' : 'which', [bin], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const found = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] ?? null;
  if (!found) return null;
  const v = spawnSync(found, ['--version'], { encoding: 'utf8', shell: /\.(cmd|bat)$/i.test(found) });
  return { path: found, shell: /\.(cmd|bat)$/i.test(found), version: (v.stdout || '').trim().split(/\r?\n/)[0] ?? '' };
}

/**
 * CLI 하나가 멎어도 스크립트 전체가 멎지 않게 한다.
 * SIGKILL 을 보내도 `close` 가 안 오는 경우를 실제로 봤다 (codex 가 egress 차단으로
 * 재시도를 도는 동안). 그래서 죽이는 것과 **포기하는 것을 분리**한다.
 */
function run(binInfo, args, cwd, promptFile, timeoutMs) {
  return new Promise((resolve) => {
    const fd = fs.openSync(promptFile, 'r');
    const p = spawn(binInfo.path, args, { cwd, shell: binInfo.shell, stdio: [fd, 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.closeSync(fd);
      } catch {
        /* 이미 닫혔다 */
      }
      resolve(r);
    };
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      // 죽었는지 기다리지 않는다. 응답이 없다는 사실만 확정하고 다음으로 넘어간다.
      // 파이프를 끊어 주지 않으면 죽은 자식의 핸들 때문에 Node 가 종료하지 못한다.
      p.stdout.destroy();
      p.stderr.destroy();
      p.unref();
      done({ stdout, stderr: `${stderr}\n${timeoutMs / 1000}초 안에 응답이 없어 포기했습니다`, code: -1 });
    }, timeoutMs);
    p.stdout.on('data', (c) => (stdout += c));
    p.stderr.on('data', (c) => (stderr += c));
    p.on('error', (e) => done({ stdout, stderr: `${stderr}\n${e.message}`, code: -1 }));
    p.on('close', (code) => done({ stdout, stderr, code: code ?? -1 }));
  });
}

/* ------------------------------------------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : d;
  };
  const only = arg('--only', null);
  const n = Math.max(1, Math.min(CASES.length, Number(arg('--n', String(CASES.length)))));
  const timeoutMs = Math.max(10, Number(arg('--timeout', '180'))) * 1000;
  const outDir = path.resolve(arg('--out', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cli')));
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`플랫폼 ${process.platform} · Node ${process.version} · 출력 ${outDir}\n`);

  const rows = [];
  let fatalCount = 0;

  for (const cli of CLIS) {
    if (only && cli.id !== only) continue;
    const info = resolveBin(cli.bin);
    if (!info) {
      console.log(`${cli.id.padEnd(12)} 미설치 — 건너뜀`);
      rows.push({ cli: cli.id, installed: false });
      continue;
    }
    console.log(`${cli.id.padEnd(12)} ${info.version || '(버전 미상)'}  ${info.path}${info.shell ? '  [shell 경유 — 인용부호 주의]' : ''}`);

    const wd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-rec-'));
    fs.writeFileSync(path.join(wd, cli.conventionFile), CONVENTION, 'utf8');
    fs.writeFileSync(path.join(wd, 'schema.json'), JSON.stringify(SCHEMA, null, 1), 'utf8');

    for (const c of CASES.slice(0, n)) {
      const promptFile = path.join(wd, `${c.id}.prompt.txt`);
      fs.writeFileSync(promptFile, promptFor(c, cli.schemaInPrompt), 'utf8');
      const t0 = Date.now();
      const r = await run(info, cli.args(wd), wd, promptFile, timeoutMs);
      const ms = Date.now() - t0;

      const rawPath = path.join(outDir, `${cli.id}-${c.id}.txt`);
      fs.writeFileSync(rawPath, r.stdout, 'utf8');
      if (r.stderr.trim()) fs.writeFileSync(path.join(outDir, `${cli.id}-${c.id}.stderr.txt`), r.stderr, 'utf8');

      let verdict;
      let reasons = [];
      if (!r.stdout.trim()) {
        verdict = '무응답';
        reasons = [r.stderr.trim().slice(0, 200) || `종료 코드 ${r.code}`];
      } else {
        let cs = null;
        try {
          cs = cli.extract(r.stdout);
        } catch (e) {
          cs = null;
          reasons = [String(e.message).slice(0, 120)];
        }
        if (!cs) {
          verdict = cli.verified ? 'FAIL' : '회수만';
          if (!cli.verified) reasons = ['봉투 형태를 모른다. 원시 응답만 회수했다'];
        } else {
          const v = check(cs, c);
          verdict = v.ok ? 'PASS' : 'FAIL';
          reasons = v.reasons;
          if (v.fatal) fatalCount++;
        }
      }
      console.log(`  ${c.id.padEnd(9)} ${verdict.padEnd(6)} ${String(ms).padStart(6)}ms  ${path.basename(rawPath)}`);
      for (const x of reasons) console.log(`    - ${x}`);
      rows.push({ cli: cli.id, installed: true, version: info.version, shell: info.shell, case: c.id, verdict, ms, reasons, verified: cli.verified });
    }
    fs.rmSync(wd, { recursive: true, force: true });
  }

  // `--only` 로 나눠 돌려도 앞 결과가 사라지지 않게 이어 붙인다.
  const summaryPath = path.join(outDir, 'summary.json');
  let runs = [];
  try {
    runs = JSON.parse(fs.readFileSync(summaryPath, 'utf8')).runs ?? [];
  } catch {
    /* 첫 실행 */
  }
  runs.push({ platform: process.platform, node: process.version, at: new Date().toISOString(), rows });
  fs.writeFileSync(summaryPath, JSON.stringify({ runs }, null, 1), 'utf8');

  const tried = rows.filter((r) => r.verdict);
  const pass = tried.filter((r) => r.verdict === 'PASS').length;
  // 봉투 형태를 모르는 CLI(codex)는 회수가 목적이라 PASS 비율에서 뺀다.
  // 그걸 실패로 세면 사내에서 스크립트가 고장 난 줄 안다.
  const judged = tried.filter((r) => r.verified);
  console.log(`\n${pass}/${judged.length} PASS · 회수만 ${tried.length - judged.length}건 · 없는 앵커 인용 ${fatalCount}건`);
  console.log(`이 폴더를 통째로 저장소에 커밋하십시오: ${outDir}`);
  console.log('입력이 전부 합성 데이터라 사내 문서는 들어 있지 않습니다.');

  // 오탐 0 이어야 하는 검사를 종료 코드로 강제한다 (CLAUDE.md §9)
  // 멎은 자식의 핸들이 남아 있을 수 있으므로 명시적으로 끝낸다. 위의 쓰기는 전부 동기다.
  if (fatalCount > 0) process.exit(1);
  process.exit(judged.length > 0 && pass === 0 ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
