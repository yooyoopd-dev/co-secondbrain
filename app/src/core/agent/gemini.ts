// Gemini 어댑터 — B등급 (스키마 강제 불가). PLAN.md §7.1, ROADMAP.md §1
//
// Gemini CLI 에는 `--json-schema` 같은 플래그가 없다. 그래서 스키마를 프롬프트에 붙이고
// **앱이 형식을 검증한다.** 틀리면 사유를 붙여 한 번만 다시 묻는다 (PLAN.md §9.4).
//
// 실측 (2026-09-05, 0.58.0, 개인 API 키, n=3): 세 번 다 펜스 없는 순수 JSON 을 냈고
// 관문을 전부 통과했다.
//
// 실측 (2026-09-07, 0.58.0, 사내 기업계정, n=10): 유효 JSON 10/10 · 스키마 10/10 ·
// 앵커 10/10. **펜스도 10/10 이었다** — 그 프롬프트가 펜스를 요구했기 때문이다.
// 두 회차를 합치면 모델은 시킨 대로 낸다. 그러니 **펜스가 있는 경우를 같이 받는다.**
//
// **`-o json` 봉투로 받는다** (ROADMAP 27번). 2026-09-07 사내 실측에서
// `stats.models[모델].tokens` 가 `input · prompt · candidates · total · cached` 를
// 주는 것을 확인했다 (ROADMAP.md §10.3). 그래서 토큰은 센다.
//
// **돈은 못 센다.** 봉투에 금액이 없고 사내 계약 단가를 앱이 모른다. `costUsd` 를
// 지어내면 $50 상한 판정이 거짓말이 된다. 0 으로 두고 토큰만 남긴다.
//
// 주의: 이 봉투 경로는 **W3 를 100% 로 통과시킨 경로가 아니다.** 그때는 평문 stdout
// 이었다. 사내에서 `record.mjs` 로 다시 재기 전까지 미검증이다 (ROADMAP §10.3).
import { validateShape, type ChangeSet } from '../changeset.ts';
import { SERVER_NAME } from '../mcp/config.ts';
import { realExec } from './exec.ts';
import { stampProvider } from './stamp.ts';
import type { AgentCli, AgentResult, Exec, Usage } from './types.ts';
import { addUsage, ZERO_USAGE } from './types.ts';

export const BIN = 'gemini';

/**
 * `--skip-trust` 는 폴더 신뢰 게이트를 지난다 (M0 §5). `plan` 은 읽기 전용이라
 * 모델이 도구로 파일을 건드리지 못한다. 프롬프트는 `-p` 없이 stdin 으로 간다.
 *
 * MCP 를 쓸 때는 `--allowed-mcp-server-names` 로 **우리 서버 하나만** 남긴다.
 * Claude Code 의 `--strict-mcp-config` 와 같은 자리다 — 사내 PC 에 이미 등록된
 * 서버가 우리 호출까지 망가뜨린 적이 있다 (`core/mcp/config.ts`).
 * Gemini 에는 `--mcp-config` 가 없어 설정은 cwd 의 `.gemini/settings.json` 이 진다.
 */
export function buildArgv(mcp = false): string[] {
  const argv = ['--skip-trust', '--approval-mode', 'plan', '-o', 'json'];
  if (mcp) argv.push('--allowed-mcp-server-names', SERVER_NAME);
  return argv;
}

/**
 * 폴더 신뢰 게이트가 MCP 를 꺼 버렸는가.
 *
 * **조용히 넘어가면 안 된다.** MCP 가 꺼진 채로도 모델은 답을 낸다 — 위키를 안 읽고
 * 아는 대로 답한 것인데 사람은 그것을 구별할 방법이 없다. 여기서 막는 편이 낫다.
 *
 * 경고 문구는 2026-09-05 사내 실측에서 받은 그대로다 (`M2-PLAN.md` §12.2):
 * `MCP servers are configured but disabled because this folder is untrusted.`
 * 판이 올라 문구가 조금 달라져도 걸리도록 두 낱말로 본다.
 */
export function mcpDisabled(stderr: string): boolean {
  return /untrusted/i.test(stderr) && /mcp/i.test(stderr);
}

export const MCP_OFF_MESSAGE =
  'Gemini 가 폴더 신뢰 때문에 MCP 를 껐습니다. 위키를 안 읽고 답하게 되므로 멈춥니다. ' +
  '사용자 수준 설정(`~/.gemini/settings.json`)에 `security.folderTrust.enabled: false` 를 넣으십시오.';

/* ---------------- `-o json` 봉투 ---------------- */

interface GeminiEnvelope {
  session_id?: string;
  response?: string;
  stats?: { models?: Record<string, { tokens?: Record<string, number> } | undefined> };
  error?: { message?: string; code?: number };
}

/**
 * 봉투인가. **"JSON 이면 봉투"로 보면 안 된다** — 모델이 낸 ChangeSet 자체가 JSON 객체라
 * 그것을 봉투로 읽으면 `response` 가 없어서 본문이 통째로 빈 것이 된다. 실제로 검사에서
 * 걸렸다. 봉투에만 있는 칸을 보고 가른다.
 */
function isEnvelope(j: unknown): j is GeminiEnvelope {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return false;
  return ['response', 'error', 'stats', 'session_id'].some((k) => k in j);
}

/**
 * 봉투를 연다. **오류 봉투는 stderr 로 오고 종료 코드가 41 이다** (0.58.0 실측).
 * stdout 만 보면 실패 사유를 통째로 놓치고 "출력이 없다"로만 보인다.
 */
export function parseEnvelope(stdout: string, stderr = ''): { text: string; usage: Usage; error: string | null } {
  let env: GeminiEnvelope | null = null;
  for (const raw of [stdout, stderr]) {
    if (env !== null) break;
    try {
      const j: unknown = JSON.parse(raw.trim());
      if (isEnvelope(j)) env = j;
    } catch {
      /* 다음 것 */
    }
  }
  if (env === null) {
    // 봉투가 아니면 평문으로 본다. 옛 경로로 녹화한 것과 CLI 판이 바뀌는 경우를 같이 받는다.
    return { text: stdout, usage: ZERO_USAGE, error: null };
  }
  const usage = usageFromStats(env);
  if (env.error) return { text: '', usage, error: `${env.error.message ?? '알 수 없는 오류'} (code=${env.error.code ?? '?'})` };
  return { text: env.response ?? '', usage, error: null };
}

/**
 * 토큰을 센다. 모델이 여러 개면 더한다.
 *
 * 낸 토큰은 `total - prompt` 로 구한다. `candidates` 만 더하면 모자란다 — 실측에서
 * `prompt 9178 + candidates 2` 가 `total 9361` 에 못 미쳤다. 이름을 다 모르는 칸이
 * 있다는 뜻이라 **빼기로 구한다.**
 *
 * `cached` 가 `input` 에 포함되는지는 **모른다.** 실측 표본이 `cached: 0` 이었다.
 * 지출 상한 판정은 `costUsd` 로만 하므로 겹쳐 세도 상한이 틀어지지는 않는다.
 */
export function usageFromStats(env: unknown): Usage {
  const models = (env as GeminiEnvelope | null)?.stats?.models ?? {};
  let u = ZERO_USAGE;
  for (const m of Object.values(models)) {
    const t = m?.tokens ?? {};
    const input = t['prompt'] ?? t['input'] ?? 0;
    const total = t['total'] ?? 0;
    const output = total > input ? total - input : (t['candidates'] ?? 0);
    u = addUsage(u, {
      costUsd: 0, // 봉투에 금액이 없다. 지어내지 않는다
      inputTokens: input,
      outputTokens: output,
      cacheCreationTokens: 0,
      cacheReadTokens: t['cached'] ?? 0,
    });
  }
  return u;
}

/** 펜스가 있을 수도 없을 수도 있다. 둘 다 받는다. */
export function stripFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1]! : s).trim();
}

export interface Extracted {
  cs: ChangeSet | null;
  /** 다시 물을 때 프롬프트에 붙일 사유 */
  reason: string | null;
}

/** ChangeSet 을 요청했을 때 쓰는 검증기. 관문에서 걸릴 것을 여기서 알면 왕복을 아낀다. */
export function validateChangeSet(data: unknown): string | null {
  const v = validateShape(data as ChangeSet);
  return v.length > 0 ? v.map((x) => `${x.path}: ${x.reason}`).join(' / ') : null;
}

/**
 * 형식까지 본다. **무엇을 요청했는지는 호출자가 안다** — 검증기를 안 주면 JSON 이
 * 객체인지만 본다. 어댑터가 모양을 넘겨짚으면 다른 스키마를 쓰는 작업이 전부 막힌다.
 */
export function extract(stdout: string, validate?: (data: unknown) => string | null): Extracted {
  const body = stripFence(stdout);
  if (!body) return { cs: null, reason: '응답이 비었습니다' };
  let cs: unknown;
  try {
    cs = JSON.parse(body);
  } catch (e) {
    return { cs: null, reason: `JSON 이 아닙니다: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!cs || typeof cs !== 'object') return { cs: null, reason: 'JSON 객체가 아닙니다' };
  const reason = validate?.(cs) ?? null;
  return reason ? { cs: null, reason } : { cs: cs as ChangeSet, reason: null };
}

/**
 * B등급의 핵심 — CLI 가 스키마를 강제하지 못하니 프롬프트에 붙인다.
 * 스키마는 **프롬프트 뒤쪽**에 둔다. 문서마다 달라지는 내용보다 앞에 두면 배치 내내
 * 같아야 하는 접두사가 깨진다 (M2-PLAN.md §2.1).
 */
export function withSchema(prompt: string, schema: object): string {
  return `${prompt}

## 출력 형식

아래 JSON Schema 를 정확히 지키는 JSON 하나만 낸다. 설명도 코드 펜스도 붙이지 않는다.

\`\`\`json
${JSON.stringify(schema, null, 1)}
\`\`\``;
}

export function retryPrompt(original: string, reason: string): string {
  return `${original}

## 앞선 응답이 거부됐다

${reason}

JSON 하나만 낸다. 설명도 코드 펜스도 붙이지 않는다.`;
}

export function createGemini(exec: Exec = realExec): AgentCli {
  return {
    id: 'gemini',
    supportsSchema: false,
    conventionFile: 'GEMINI.md',
    // `--mcp-config` 가 없다. cwd 의 프로젝트 설정만 읽는다 (2026-09-09 실측)
    mcpConfigFile: '.gemini/settings.json',

    async detect() {
      try {
        const r = await exec(BIN, ['--version'], { cwd: process.cwd(), env: process.env });
        if (r.code !== 0) return { found: false };
        const version = r.stdout.trim().split(/\r?\n/).pop()?.trim();
        return version ? { found: true, version } : { found: true };
      } catch {
        return { found: false };
      }
    },

    async run(job, schema) {
      // **두 호출의 토큰을 다 더한다.** 재요청분을 빼면 계량기가 실제보다 적게 센다.
      let usage = ZERO_USAGE;
      // 세션 id 는 봉투에 오지만 null 을 준다. `buildArgv` 가 `--resume` 을 안 붙여서
      // 돌려주면 batch 가 이어진 줄 알고 처음부터 다시 돌린다 (agent/batch.ts).
      const fail = (error: string, raw: string): AgentResult => ({
        ok: false, data: null, sessionId: null, usage, error, raw,
      });

      const call = async (prompt: string) => {
        try {
          const r = await exec(BIN, buildArgv(job.mcp !== undefined), {
            cwd: job.workdir, env: process.env, stdin: prompt, onOutput: job.onOutput, signal: job.signal,
          });
          const env = parseEnvelope(r.stdout, r.stderr);
          usage = addUsage(usage, env.usage);
          return { ...r, env };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { stdout: '', stderr: msg, code: -1, env: { text: '', usage: ZERO_USAGE, error: msg } };
        }
      };

      const prompt = withSchema(job.prompt, schema);
      const first = await call(prompt);
      // 위키를 읽어야 하는 호출인데 MCP 가 꺼졌으면 여기서 끝낸다. 답이 오더라도 못 믿는다.
      if (job.mcp && mcpDisabled(first.stderr)) return fail(MCP_OFF_MESSAGE, first.stdout);
      if (first.env.error !== null) return fail(`CLI 가 거절했습니다: ${first.env.error.slice(0, 300)}`, first.stdout);
      if (!first.env.text.trim()) {
        return fail(`CLI 가 출력 없이 종료했습니다 (code=${first.code}): ${first.stderr.trim().slice(0, 300)}`, first.stdout);
      }
      const a = extract(first.env.text, job.validate);
      if (a.cs) return { ok: true, data: stampProvider(a.cs, 'gemini'), sessionId: null, usage, raw: first.stdout };

      // 재요청은 1회 고정이다 (PLAN.md §9.4). 조용히 더 돌지 않는다.
      const second = await call(retryPrompt(prompt, a.reason ?? ''));
      const b = extract(second.env.text, job.validate);
      if (b.cs) return { ok: true, data: stampProvider(b.cs, 'gemini'), sessionId: null, usage, raw: second.stdout };

      return fail(`형식이 두 번 다 틀렸습니다. 1차: ${a.reason} / 2차: ${b.reason}`, second.stdout || first.stdout);
    },
  };
}
