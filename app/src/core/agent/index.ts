// 공급자 선택. 어느 작업을 어느 CLI 로 보낼지(라우팅)는 아직 여기 없다 — ROADMAP 6번.
import { createClaudeCode } from './claude-code.ts';
import { createGemini } from './gemini.ts';
import type { AgentCli, ProviderId } from './types.ts';

export function createCli(id: ProviderId): AgentCli {
  switch (id) {
    case 'claude-code':
      return createClaudeCode();
    case 'gemini':
      return createGemini();
    case 'codex':
      // 개발 컨테이너에서 api.openai.com 이 막혀 응답 형태를 못 봤다. 추측으로 쓰지 않는다.
      throw new Error('Codex 어댑터는 아직 없습니다 (ROADMAP 19번)');
  }
}
