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
