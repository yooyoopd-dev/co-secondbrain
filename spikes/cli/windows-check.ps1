# M0 W1 검증 — 사내 Windows PC용.
#
# 사내에서 텍스트 복사가 안 되므로 결과를 손으로 옮겨 적을 수 있게 4줄만 출력한다.
# 중간 과정은 전부 숨긴다.
#
# 하는 일: 설정을 영구 변경하지 않는다. mcp add 로 만든 항목은 끝에 제거한다.
# 실행:  powershell -ExecutionPolicy Bypass -File windows-check.ps1

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$probe = Join-Path $here 'mcp-probe.mjs'

function Has($n) { [bool](Get-Command $n -ErrorAction SilentlyContinue) }
function Ver($n) {
  if (-not (Has $n)) { return 'X' }
  $v = (& $n --version 2>&1 | Select-Object -First 1) -replace '[^0-9.]', ''
  if ($v) { return $v } else { return 'OK' }
}
# 긴 오류 메시지를 손으로 적을 수 있는 짧은 코드로 줄인다.
function Code($text) {
  if (-not $text) { return 'OK' }
  $t = ($text | Out-String)
  if ($t -match '\b([45]\d\d)\b') { return $Matches[1] }          # HTTP 상태코드
  if ($t -match 'ENOENT|not found|없') { return 'NOEXE' }
  if ($t -match 'denied|permission|policy|정책|차단') { return 'DENY' }
  if ($t -match 'timeout|timed out') { return 'TMO' }
  if ($t -match 'Connected|연결됨') { return 'OK' }
  if ($t -match 'Failed|error|오류|실패') { return 'ERR' }
  return 'OK'
}

# ---------- 1. CLI ----------
$cc = Ver 'claude'; $gm = Ver 'gemini'; $cx = Ver 'codex'

# ---------- 2. --mcp-config (비침습: 설정 파일을 건드리지 않는다) ----------
$cfgRes = 'SKIP'
if (Has 'claude' -and (Test-Path $probe)) {
  $tmp = Join-Path $env:TEMP 'm0probe.json'
  $p = $probe -replace '\\', '\\\\'
  "{""mcpServers"":{""m0probe"":{""command"":""node"",""args"":[""$p""]}}}" |
    Out-File -FilePath $tmp -Encoding ascii -NoNewline
  # --strict-mcp-config: 이 파일의 서버만 쓴다. 사내에 이미 등록된 서버는 건드리지 않는다.
  $o = & claude -p "m0_ping 도구를 호출하고 결과만 말해라." --mcp-config $tmp --strict-mcp-config `
        --allowedTools "mcp__m0probe__m0_ping" --permission-mode dontAsk `
        --output-format json --disable-slash-commands 2>&1
  if ($o -match 'pong') { $cfgRes = 'OK' } else { $cfgRes = Code $o }
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

# ---------- 3. mcp add (설정 파일에 기록 — 끝에 제거) ----------
$addRes = 'SKIP'; $connRes = 'SKIP'; $otherRes = '-'
if (Has 'claude' -and (Test-Path $probe)) {
  $a = & claude mcp add m0probe -- node $probe 2>&1
  if ($a -match 'Added|추가') { $addRes = 'OK' } else { $addRes = Code $a }

  # mcp list 는 등록된 **모든** 서버를 health-check 한다.
  # 사내에 이미 있던 HTTP MCP 서버가 502를 내면 여기서 잡힌다 — 우리 프로브 탓이 아니다.
  $l = (& claude mcp list 2>&1 | Out-String)
  if ($l -match 'm0probe.*(Connected|연결)') { $connRes = 'OK' }
  elseif ($l -match 'm0probe') { $connRes = Code $l } else { $connRes = 'NONE' }

  $others = ($l -split "`n") | Where-Object { $_ -notmatch 'm0probe' -and $_ -match 'Failed|error|[45]\d\d' }
  if ($others) { $otherRes = Code $others }

  & claude mcp remove m0probe 2>&1 | Out-Null
}

# ---------- 4. mpm (사내 플러그인 로더) ----------
$mpm = if (Has 'mpm') { 'O' } else { 'X' }

# ---------- 출력 ----------
Write-Host ''
Write-Host '===== 아래 4줄만 적어 주세요 ====='
Write-Host ("1 CLI   claude={0} gemini={1} codex={2}" -f $cc, $gm, $cx)
Write-Host ("2 설정  cfg={0} add={1}" -f $cfgRes, $addRes)
Write-Host ("3 연결  probe={0} 기존={1}" -f $connRes, $otherRes)
Write-Host ("4 mpm   {0}" -f $mpm)
Write-Host '=================================='
Write-Host ''
Write-Host '코드: OK=성공 X=없음 DENY=정책차단 4xx/5xx=HTTP오류'
Write-Host '      NOEXE=실행파일없음 TMO=시간초과 ERR=기타 SKIP=건너뜀'
