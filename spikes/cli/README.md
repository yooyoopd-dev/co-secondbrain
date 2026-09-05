# CLI 검증 (M0 항목 1·3·4·5)

## W1 — 사내 Windows PC에서 실행

```powershell
powershell -ExecutionPolicy Bypass -File windows-check.ps1
```

**출력은 4줄뿐입니다.** 사내에서 텍스트 복사가 안 되므로 손으로 옮겨 적을 수 있게 줄였습니다.

```
===== 아래 4줄만 적어 주세요 =====
1 CLI   claude=2.1.260 gemini=0.58.0 codex=0.153.2
2 설정  cfg=OK add=OK
3 연결  probe=OK 기존=- gm=AUTH
4 mpm   X
==================================
```

**사내 실측 결과 (2026-09-04)** — `claude=2.1.260 gemini=0.58.0 codex=X`,
`cfg=OK add=OK probe=OK 기존=- mpm=O` → **안 B 채택 확정**. 상세는
[`../../docs/M0-RESULTS.md`](../../docs/M0-RESULTS.md) §8.2.

| 필드 | 뜻 |
|---|---|
| `cfg` | `--mcp-config` 경로 — 설정 파일을 **건드리지 않고** 호출 단위로 MCP 서버를 붙임 |
| `add` | `claude mcp add` 경로 — 프로젝트 로컬 설정에 기록 (끝에 자동 제거) |
| `probe` | 우리 프로브 서버가 실제로 **연결**됐는지 |
| `기존` | 사내에 **이미 등록돼 있던 다른 서버**의 오류 (우리와 무관) |
| `gm` | Gemini의 MCP — `TRUST`=폴더신뢰 차단, `AUTH`=인증필요(MCP는 통과), `OK`=연결됨 |
| `mpm` | 사내 플러그인 로더 설치 여부 |

코드: `OK`=성공 · `X`=없음 · `DENY`=정책차단 · `4xx/5xx`=HTTP오류 ·
`NOEXE`=실행파일없음 · `TMO`=시간초과 · `ERR`=기타 · `SKIP`=건너뜀 ·
`TRUST`=폴더신뢰차단 · `AUTH`=인증필요

설정을 영구 변경하지 않습니다. `mcp add`로 만든 `m0probe` 항목은 검사 후 제거합니다.

Linux/mac에서 같은 검사를 돌리려면 `./check.sh` (로직 동일, 검증용).

---

## 이전 버전의 결함 (2026-09-04 수정)

첫 스크립트는 이렇게 등록했습니다.

```powershell
claude mcp add m0probe -- node -e "0"     # ← 잘못됨
```

`node -e "0"`은 **즉시 종료**합니다. MCP 서버는 살아서 stdio로 JSON-RPC를 주고받아야 하므로,
사내 정책과 **무관하게** 연결이 실패합니다. 정책 차단 여부를 판별할 수 없는 프로브였습니다.

지금은 `mcp-probe.mjs` — `initialize` / `tools/list` / `tools/call`에 응답하는 실제 최소
stdio MCP 서버를 씁니다. 우리 앱이 띄울 내장 서버의 골격이기도 합니다.

## 502 오류에 대한 가설

사내에서 보고된 오류:

```
Failed to connect ... HTTP 502: Error POSTing to endpoint
```

**"POSTing to endpoint"는 HTTP 전송 표현입니다.** 우리 프로브는 stdio라 어디에도
POST하지 않습니다. 따라서 이 502는 우리 프로브가 아니라 **사내에 이미 등록돼 있던 다른
HTTP MCP 서버**에서 났을 가능성이 큽니다 — `claude mcp list`가 등록된 **모든** 서버를
health-check하기 때문입니다. **추측이며, 새 스크립트의 `기존=` 필드가 이걸 분리해 보여줍니다.**

새 스크립트는 `--strict-mcp-config`를 씁니다. 이 플래그는 지정한 설정 파일의 서버만 쓰고
나머지는 무시하므로, 사내 서버의 상태와 무관하게 우리 경로만 검증됩니다.

---

## 검증된 사실 (Linux, Claude Code 2.1.260)

두 경로 모두 실제 stdio MCP 서버로 **도구 호출까지 성공**했습니다.

| 경로 | 결과 | 설정 파일 영향 |
|---|---|---|
| `--mcp-config <file> --strict-mcp-config` | `pong` 반환, 3턴 | **없음** — 호출 단위 |
| `claude mcp add` → `mcp list` | `√ Connected` | `~/.claude.json`의 **프로젝트 로컬** 범위 |

`claude mcp add`가 쓰는 곳이 마켓플레이스가 아니라 **프로젝트 로컬 설정 파일**이라는 점이
중요합니다 (`Scope: Local config (private to you in this project)`).

---

## 설계 결론 — `--mcp-config`를 쓴다

`PLAN.md` §7.2 안 B를 채택할 경우, **`claude mcp add`가 아니라 `--mcp-config`** 를 씁니다.

1. **사용자 설정을 건드리지 않는다.** 사내 PC의 기존 MCP 설정을 앱이 수정하지 않음
2. **`--strict-mcp-config`가 기존 서버를 격리한다.** 사내 HTTP MCP 서버가 502를 내든 말든
   우리 호출에 영향이 없음. 위 502 문제를 구조적으로 회피
3. **정책 차단 표면이 작다.** 전역 설정 쓰기 권한이 필요 없음
4. Vault마다 다른 서버를 붙일 수 있음 (개인 금고 / CO 영역)

---

## 비용 측정 재현 (항목 1·3)

실제 API 호출이 발생합니다. 측정값 (Linux, `claude-sonnet-5`, 4줄짜리 한국어 회의록):

| 조건 | 턴 | cache생성 | cache읽기 | 출력 | 비용 |
|---|---|---|---|---|---|
| 기본 (파일 탐색 허용) | 8 | 34,506 | 66,087 | 2,476 | $0.176 |
| 도구 차단 + 내용 인라인 | 2 | 29,747 | 0 | 1,054 | $0.130 |
| + 세션 재개 (`--resume`) | 2 | 1,713 | 29,747 | 3,605 | $0.049 |

고정 오버헤드가 약 3만 토큰. 세션 재개 시 cache 생성 → 읽기로 바뀌어 62% 절감.
자세한 내용은 [`../../docs/M0-RESULTS.md`](../../docs/M0-RESULTS.md) §1.3.


---

## Gemini 폴더 신뢰(folder trust) 게이트

Gemini CLI는 **신뢰되지 않은 폴더에서 MCP 서버를 끕니다.**

```
Warning: MCP servers are configured but disabled because this folder is untrusted.
User-level servers are also suppressed in untrusted folders to prevent accidental side-effects.
○ m0probe: node ... (stdio) - Disabled
```

우리 설계(`PLAN.md` §7.1)는 CLI를 **격리 임시 작업 디렉터리**에서 돌립니다. 매번 새로
만드는 폴더라 항상 untrusted입니다.

해결은 **`--skip-trust`**. 이 환경에서 게이트를 통과해 다음 단계(인증)로 넘어가는 것까지
확인했습니다. 인증이 없어 **연결 자체는 미검증**입니다(W3).

훅·프로젝트 에이전트도 같은 게이트에 걸립니다:
`Blocked execution of project hook in untrusted folder`,
`Skipping project agents due to untrusted folder`.

→ Gemini 어댑터는 모든 호출에 `--skip-trust`를 붙입니다.


---

## W3 — Gemini 스키마 안정성 (Gemini 인증이 있는 PC에서)

```bash
node gemini-schema-check.mjs 10
```

Gemini에는 `--json-schema`(Claude Code)·`--output-schema`(Codex)에 해당하는 플래그가
**없습니다.** 프롬프트 지시 + 앱 검증 + 1회 재시도로 가야 하는데, 그 성공률이
[`../../docs/PROVIDER-ROUTING.md`](../../docs/PROVIDER-ROUTING.md) §7 B등급 경로의 전제입니다.

같은 프롬프트를 n회 돌려 유효 JSON 비율을 잽니다. 출력은 3줄입니다.

```
===== 아래 3줄만 적어 주세요 =====
1 W3  n=10 json=90% schema=80% anchor=100%
2 형식 fenced=100% 파싱실패=1
3 위반 ops[0].path
==================================
```

`schema`가 **90% 미만이면** 재시도 비용이 절감분을 잠식할 수 있습니다.
그 경우 Gemini 라우팅 대상을 줄이거나(§3 표), 프롬프트를 더 강하게 잡아야 합니다.

---

## W2 · W3 · W3b — 회수 스크립트 `record.mjs`

사내 PC 에서 **이 파일 하나만** 돌립니다. 사내에서 개발하지 않습니다.
회수한 원시 응답으로 파서를 개발 쪽에서 완성합니다 ([`docs/ROADMAP.md`](../../docs/ROADMAP.md) §4).

```
node spikes/cli/record.mjs
```

의존성이 없어 `npm install` 없이 Node 만 있으면 됩니다.

| 옵션 | 기본 | 뜻 |
|---|---|---|
| `--only <cli>` | 전체 | `claude-code` · `gemini` · `codex` 중 하나만 |
| `--n <건수>` | 3 | 원본 사례 수 |
| `--timeout <초>` | 180 | 한 건당 대기 상한. 넘으면 포기하고 다음으로 |
| `--out <경로>` | `spikes/fixtures/cli` | 출력 폴더 |

### 무엇이 나오는가

```
claude-code  2.1.261 (Claude Code)  /opt/node22/bin/claude
  kickoff   PASS    35125ms  claude-code-kickoff.txt
  ...
3/3 PASS · 회수만 0건 · 없는 앵커 인용 0건
```

`--only` 로 나눠 돌려도 `summary.json` 에 이어 붙습니다. 앞 결과가 사라지지 않습니다.

- **PASS** — 유효한 ChangeSet 을 냈고 검사를 전부 통과
- **FAIL** — 검사에서 걸림. 없는 앵커를 인용하면 **종료 코드 1** (`CLAUDE.md` §9)
- **회수만** — 응답 봉투 형태를 아직 모르는 CLI. 원시 응답만 저장하고 실패로 세지 않는다
- **무응답** — 상한 안에 아무것도 못 받음. `*.stderr.txt` 에 사유가 있다

### 사내에서 확인해 줄 것

1. 실행 파일 경로 옆에 `[shell 경유 — 인용부호 주의]` 가 뜨는가.
   `claude --json-schema` 는 인라인 JSON 만 받아서(파일 경로 거부, 2026-09-05 실측)
   스키마 약 1.5KB 가 argv 로 나갑니다. 그 안에 `^` `|` `\` 가 있어 cmd 를 거치면 위험합니다
2. Codex 가 설치돼 있으면 `codex-*.txt` 가 나오는가 — **W3b 의 목적**
3. 기업계정 Gemini 도 개인 계정처럼 펜스 없는 순수 JSON 을 내는가

### 반출 안전

입력이 **전부 합성 데이터**입니다. 스크립트가 사내 문서를 읽지 않으므로 출력 폴더를
그대로 저장소에 커밋해도 됩니다. 사내 문서를 다루는 검증(W4 · W5)은 다른 스크립트이고
집계 수치만 회수합니다 ([`docs/ROADMAP.md`](../../docs/ROADMAP.md) §3).

### 개발 컨테이너 실측 (2026-09-05, Linux)

| CLI | 결과 |
|---|---|
| `claude` 2.1.261 | 3/3 PASS · 합계 $0.1859 |
| `gemini` 0.58.0 (개인 API 키) | 3/3 PASS · 3건 전부 펜스 없는 순수 JSON |
| `codex` 0.153.2 | 회수 불가 — `api.openai.com` 이 조직 정책으로 차단 |

회수한 6건은 `app/test/record.test.ts` 에서 앱의 관문 7개로 다시 검사합니다.
