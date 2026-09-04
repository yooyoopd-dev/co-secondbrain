# M0 W1~W3 — 사내 Windows PC에서 실행. 결과를 붙여넣어 주세요.
# 아무것도 설치하거나 변경하지 않습니다. MCP 등록 테스트만 등록 후 즉시 제거합니다.

$ErrorActionPreference = 'Continue'
function Head($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }

Head "1. CLI 설치 및 버전"
foreach ($c in 'claude','gemini','codex') {
  $p = (Get-Command $c -ErrorAction SilentlyContinue).Source
  if ($p) { Write-Host ("  {0,-8} {1}" -f $c, (& $c --version 2>&1 | Select-Object -First 1)) }
  else    { Write-Host ("  {0,-8} (설치 안 됨)" -f $c) -ForegroundColor Yellow }
}

Head "2. W1 — MCP 등록이 사내 정책상 허용되는가"
# 이것이 PLAN.md 7.2 안 A/B 결정의 유일한 남은 변수입니다.
foreach ($c in 'claude','gemini','codex') {
  if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { continue }
  Write-Host "  -- $c --"
  switch ($c) {
    'claude' { & claude mcp add m0probe -- node -e "0" 2>&1 | ForEach-Object { "    $_" }
               & claude mcp list 2>&1 | Select-String 'm0probe' | ForEach-Object { "    $_" }
               & claude mcp remove m0probe 2>&1 | Out-Null }
    'gemini' { & gemini mcp add m0probe node -e "0" 2>&1 | ForEach-Object { "    $_" }
               & gemini mcp list 2>&1 | Select-String 'm0probe' | ForEach-Object { "    $_" }
               & gemini mcp remove m0probe 2>&1 | Out-Null }
    'codex'  { & codex mcp add m0probe -- node -e "0" 2>&1 | ForEach-Object { "    $_" }
               & codex mcp list 2>&1 | Select-String 'm0probe' | ForEach-Object { "    $_" }
               & codex mcp remove m0probe 2>&1 | Out-Null }
  }
}
Write-Host "  → 'm0probe'가 목록에 보이면 허용됨(안 B 가능). 오류/차단 메시지면 안 A로 확정." -ForegroundColor Green

Head "3. W3 — 인증 상태"
if (Get-Command claude -ErrorAction SilentlyContinue) { & claude mcp list 2>&1 | Select-Object -First 3 | ForEach-Object { "    $_" } }
Write-Host "  gemini / codex 는 각자 login 상태를 확인해 주세요."

Head "4. W2 — 비대화형 스키마 강제 (실제 API 호출 발생)"
Write-Host "  실행하려면 아래 주석을 해제하세요."
# $schema = '{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}'
# & claude -p "ok를 true로 반환하라" --output-format json --json-schema $schema --permission-mode dontAsk

Head "완료"
Write-Host "  위 출력 전체를 복사해 주시면 PLAN.md 7.2를 확정하겠습니다."
