#!/usr/bin/env bash
# windows-check.ps1 과 동일한 검사·동일한 출력. Linux/mac 에서 로직을 검증하려고 둔다.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; PROBE="$HERE/mcp-probe.mjs"
has(){ command -v "$1" >/dev/null 2>&1; }
ver(){ has "$1" || { echo X; return; }; v=$("$1" --version 2>&1 | head -1 | tr -cd '0-9.'); echo "${v:-OK}"; }
code(){ t="$*"
  case "$t" in *[45][0-9][0-9]*) echo "$t" | grep -oE '\b[45][0-9]{2}\b' | head -1; return;; esac
  case "$t" in *ENOENT*|*"not found"*) echo NOEXE;; *denied*|*permission*|*policy*|*정책*|*차단*) echo DENY;;
    *timeout*|*"timed out"*) echo TMO;; *Connected*|*연결됨*) echo OK;;
    *Failed*|*error*|*오류*|*실패*) echo ERR;; *) echo OK;; esac; }

CC=$(ver claude); GM=$(ver gemini); CX=$(ver codex)

CFG=SKIP
if has claude && [ -f "$PROBE" ]; then
  TMP=$(mktemp); printf '{"mcpServers":{"m0probe":{"command":"node","args":["%s"]}}}' "$PROBE" > "$TMP"
  O=$(timeout 180 claude -p "m0_ping 도구를 호출하고 결과만 말해라." --mcp-config "$TMP" --strict-mcp-config \
      --allowedTools "mcp__m0probe__m0_ping" --permission-mode dontAsk \
      --output-format json --disable-slash-commands </dev/null 2>&1)
  case "$O" in *pong*) CFG=OK;; *) CFG=$(code "$O");; esac
  rm -f "$TMP"
fi

ADD=SKIP; CONN=SKIP; OTHER='-'
if has claude && [ -f "$PROBE" ]; then
  A=$(claude mcp add m0probe -- node "$PROBE" 2>&1)
  case "$A" in *Added*|*추가*) ADD=OK;; *) ADD=$(code "$A");; esac
  L=$(timeout 120 claude mcp list 2>&1)
  if echo "$L" | grep -q 'm0probe.*\(Connected\|연결\)'; then CONN=OK
  elif echo "$L" | grep -q 'm0probe'; then CONN=$(code "$L"); else CONN=NONE; fi
  OTH=$(echo "$L" | grep -v m0probe | grep -E 'Failed|error|[45][0-9]{2}')
  [ -n "$OTH" ] && OTHER=$(code "$OTH")
  claude mcp remove m0probe >/dev/null 2>&1
fi

has mpm && MPM=O || MPM=X

echo
echo '===== 아래 4줄만 적어 주세요 ====='
echo "1 CLI   claude=$CC gemini=$GM codex=$CX"
echo "2 설정  cfg=$CFG add=$ADD"
echo "3 연결  probe=$CONN 기존=$OTHER"
echo "4 mpm   $MPM"
echo '=================================='
echo
echo '코드: OK=성공 X=없음 DENY=정책차단 4xx/5xx=HTTP오류'
echo '      NOEXE=실행파일없음 TMO=시간초과 ERR=기타 SKIP=건너뜀'
