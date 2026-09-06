// Gemini 어댑터 — B등급 (스키마 강제 불가). PLAN.md §7.1, ROADMAP.md §1
//
// Gemini CLI 에는 `--json-schema` 같은 플래그가 없다. 그래서 스키마를 프롬프트에 붙이고
// **앱이 형식을 검증한다.** 틀리면 사유를 붙여 한 번만 다시 묻는다 (PLAN.md §9.4).
//
// 실측 (2026-09-05, 0.58.0, 개인 API 키, n=3): 세 번 다 펜스 없는 순수 JSON 을 냈고
// 관문을 전부 통과했다. 그래도 **펜스가 있는 경우를 같이 받는다** — n=3 은 작다.
//
// 비용을 보고하지 않는다. `total_cost_usd` 에 해당하는 값이 응답에 없어서 지출 계량기가
// Gemini 소비를 셀 수 없다. PROVIDER-ROUTING.md §7.2.1 이 토큰을 많이 먹는 작업을
// Gemini 로 보내는 근거가 "상한이 느슨하다"는 것이라 지금은 이대로 둔다.
import { validateShape, type ChangeSet } from '../changeset.ts';
import { realExec } from './exec.ts';
import { stampProvider } from './stamp.ts';
import type { AgentCli, AgentResult, Exec } from './types.ts';
import { ZERO_USAGE } from './types.ts';

export const BIN = 'gemini';

/**
 * `--skip-trust` 는 폴더 신뢰 게이트를 지난다 (M0 §5). `plan` 은 읽기 전용이라
 * 모델이 도구로 파일을 건드리지 못한다. 프롬프트는 `-p` 없이 stdin 으로 간다.
 */
export function buildArgv(): string[] {
  return ['--skip-trust', '--approval-mode', 'plan'];
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
      const fail = (error: string, raw: string): AgentResult => ({
        ok: false, data: null, sessionId: null, usage: ZERO_USAGE, error, raw,
      });

      const call = async (prompt: string) => {
        try {
          return await exec(BIN, buildArgv(), { cwd: job.workdir, env: process.env, stdin: prompt });
        } catch (e) {
          return { stdout: '', stderr: e instanceof Error ? e.message : String(e), code: -1 };
        }
      };

      const prompt = withSchema(job.prompt, schema);
      const first = await call(prompt);
      if (!first.stdout.trim()) {
        return fail(`CLI 가 출력 없이 종료했습니다 (code=${first.code}): ${first.stderr.trim().slice(0, 300)}`, first.stdout);
      }
      const a = extract(first.stdout, job.validate);
      if (a.cs) return { ok: true, data: stampProvider(a.cs, 'gemini'), sessionId: null, usage: ZERO_USAGE, raw: first.stdout };

      // 재요청은 1회 고정이다 (PLAN.md §9.4). 조용히 더 돌지 않는다.
      const second = await call(retryPrompt(prompt, a.reason ?? ''));
      const b = extract(second.stdout, job.validate);
      if (b.cs) return { ok: true, data: stampProvider(b.cs, 'gemini'), sessionId: null, usage: ZERO_USAGE, raw: second.stdout };

      return fail(`형식이 두 번 다 틀렸습니다. 1차: ${a.reason} / 2차: ${b.reason}`, second.stdout || first.stdout);
    },
  };
}
