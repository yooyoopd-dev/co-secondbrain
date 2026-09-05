// Claude Code 어댑터 — A등급 (스키마 강제). PLAN.md §7.1, M2-PLAN.md §1
//
// 실측(2026-09-05): `--json-schema` 를 걸면 응답의 `structured_output` 이 **이미 파싱된
// 객체**로 온다. 펜스드 블록 스크래핑이 필요 없다.
//
// 비용 구조: 콜드 실행 1회의 바닥이 $0.11338 이고 그중 28,194 토큰이 CLI 자기 시스템
// 프롬프트다 (M2-PLAN.md §2). 프롬프트를 줄이는 최적화는 이 앞에서 거의 효과가 없다.
// 줄일 수 있는 건 **프로세스 수**뿐이라 배치는 `resumeSessionId` 로 이어 붙인다.
import { randomUUID } from 'node:crypto';
import { realExec } from './exec.ts';
import { stampProvider } from './stamp.ts';
import type { ChangeSet } from '../changeset.ts';
import type { AgentCli, AgentJob, AgentResult, Exec, Usage } from './types.ts';
import { ZERO_USAGE } from './types.ts';

export const BIN = 'claude';

/** 도구를 전부 막는다. 내용은 프롬프트에 인라인한다 — M0 실측 8턴 → 2턴, $0.176 → $0.130 */
export const BLOCKED_TOOLS = [
  'Read', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite',
] as const;

/** 부모 Claude Code 세션의 정체를 물려받으면 `--resume` 이 부모 세션과 충돌한다. */
const STRIPPED_ENV = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION'];

/** CLI 응답에서 우리가 읽는 부분만. 나머지 키는 무시한다. */
interface CliJson {
  is_error?: boolean;
  subtype?: string;
  session_id?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** 프롬프트는 argv 가 아니라 stdin 으로 간다. `-p` 를 인자 없이 둔다 (exec.ts). */
export function buildArgv(job: AgentJob, schema: object, sessionId: string): string[] {
  const argv = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(schema)];
  argv.push(job.resumeSessionId ? '--resume' : '--session-id', job.resumeSessionId ?? sessionId);
  argv.push('--strict-mcp-config');
  argv.push('--disallowedTools', ...BLOCKED_TOOLS);
  return argv;
}

export function parseUsage(j: CliJson): Usage {
  const u = j.usage ?? {};
  return {
    costUsd: j.total_cost_usd ?? 0,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

/** 원시 stdout 하나를 AgentResult 로 바꾼다. 녹화 픽스처를 그대로 먹일 수 있다. */
export function parseResult(stdout: string): AgentResult {
  let j: CliJson;
  try {
    j = JSON.parse(stdout) as CliJson;
  } catch {
    return { ok: false, data: null, sessionId: null, usage: ZERO_USAGE, error: 'CLI 응답이 JSON 이 아닙니다', raw: stdout };
  }
  const usage = parseUsage(j);
  const sessionId = j.session_id ?? null;
  if (j.is_error || j.subtype !== 'success') {
    return { ok: false, data: null, sessionId, usage, error: j.result ?? `실패: ${j.subtype}`, raw: stdout };
  }
  if (j.structured_output === undefined) {
    return { ok: false, data: null, sessionId, usage, error: 'structured_output 이 없습니다', raw: stdout };
  }
  return { ok: true, data: j.structured_output, sessionId, usage, raw: stdout };
}

export function createClaudeCode(exec: Exec = realExec): AgentCli {
  return {
    id: 'claude-code',
    supportsSchema: true,
    conventionFile: 'CLAUDE.md',

    async detect() {
      try {
        const r = await exec(BIN, ['--version'], { cwd: process.cwd(), env: process.env });
        if (r.code !== 0) return { found: false };
        const version = r.stdout.trim().split(/\s+/)[0];
        return version ? { found: true, version } : { found: true };
      } catch {
        return { found: false };
      }
    },

    async run(job, schema) {
      const env = { ...process.env };
      for (const k of STRIPPED_ENV) delete env[k];
      const argv = buildArgv(job, schema, randomUUID());
      try {
        const { stdout, stderr, code } = await exec(BIN, argv, { cwd: job.workdir, env, stdin: job.prompt });
        if (!stdout.trim()) {
          return {
            ok: false, data: null, sessionId: null, usage: ZERO_USAGE,
            error: `CLI 가 출력 없이 종료했습니다 (code=${code}): ${stderr.trim().slice(0, 300)}`,
            raw: stdout,
          };
        }
        const r = parseResult(stdout);
        // 모델이 규약 표본의 generated_by·updated 를 베낀다. 승인 화면에 가기 전에 고친다.
        return r.ok ? { ...r, data: stampProvider(r.data as ChangeSet, 'claude-code') } : r;
      } catch (e) {
        return {
          ok: false, data: null, sessionId: null, usage: ZERO_USAGE,
          error: `CLI 를 띄우지 못했습니다: ${e instanceof Error ? e.message : String(e)}`,
          raw: '',
        };
      }
    },
  };
}
