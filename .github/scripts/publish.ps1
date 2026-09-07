# 묶은 exe 를 릴리스에 올리고 이전 판 exe 를 지운다.
#
# 지우는 이유는 하나다. 받는 사람이 목록에서 옛 파일을 집어 가는 일을 막는다.
# 릴리스와 태그 자체는 남긴다 — 어느 판이 언제 나갔는지는 기록이다.
$ErrorActionPreference = 'Stop'
# PowerShell 7.4 부터 외부 명령의 0 아닌 종료 코드도 위 설정에 걸려 던진다. 여기서는
# `gh release view` 가 "없다"는 뜻으로 1 을 준다. 그것까지 던지면 첫 릴리스를 못 만든다.
$PSNativeCommandUseErrorActionPreference = $false

$version = (Get-Content app/package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$repo = $env:GITHUB_REPOSITORY

# Windows 앱과 Ubuntu 허브를 같이 올린다. 허브 PC 는 인터넷이 없어 여기서 받아 옮긴다.
# 맨 위만 본다. `-Recurse` 를 쓰면 `win-unpacked/co-secondbrain.exe` 210MB 까지 집는다.
$assets = @(Get-ChildItem app/release -File | Where-Object { $_.Extension -in '.exe', '.tgz' })
if ($assets.Count -eq 0) { throw 'app/release 에 올릴 것이 없습니다' }
foreach ($a in $assets) { Write-Host "올릴 것: $($a.Name)  $([math]::Round($a.Length / 1MB, 1)) MB" }

gh release view $tag *> $null
if ($LASTEXITCODE -ne 0) {
  $notes = @"
## Windows 앱

``co-secondbrain-<판>-portable.exe`` 하나를 받아 두 번 누르십시오. 설치하지 않습니다.
설치 권한이 없어도 됩니다. 대상은 Windows x64 입니다.

내용은 이 컴퓨터를 떠나지 않습니다. 개인 Vault 는 동기화가 없습니다.

## CO-Hub (Ubuntu)

``co-hub-<판>.tgz`` 는 사내 동기화 서버입니다. **런타임 의존성이 없어** 인터넷 없는
Ubuntu PC 에 풀어서 바로 돌립니다. Node 22.22.2 에서 확인했습니다.

    sudo tar -xzf co-hub-<판>.tgz -C /srv/co-hub

절차는 ``docs/HUB-SETUP.md`` 에 있습니다.

## 검사

묶은 것을 실제로 띄워 스모크를 통과시킨 뒤에만 올립니다.
"@
  gh release create $tag --title $tag --notes $notes
  if ($LASTEXITCODE -ne 0) { throw "릴리스를 만들지 못했습니다: $tag" }
}

foreach ($a in $assets) {
  gh release upload $tag $a.FullName --clobber
  if ($LASTEXITCODE -ne 0) { throw "올리지 못했습니다: $($a.Name)" }
}

# 이전 판의 배포물을 지운다. per_page 를 채워 한 번에 받는다 — --paginate 는 페이지마다
# 배열을 따로 뱉어서 ConvertFrom-Json 이 못 읽는다.
$releases = gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json
foreach ($r in $releases) {
  if ($r.tag_name -eq $tag) { continue }
  foreach ($a in $r.assets) {
    if (($a.name -notlike '*.exe') -and ($a.name -notlike '*.tgz')) { continue }
    gh api -X DELETE "repos/$repo/releases/assets/$($a.id)" *> $null
    Write-Host "이전 판 삭제: $($r.tag_name) / $($a.name)"
  }
}

Write-Host "배포 완료: $tag"
