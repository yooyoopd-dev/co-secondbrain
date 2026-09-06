# 묶은 exe 를 릴리스에 올리고 이전 판 exe 를 지운다.
#
# 지우는 이유는 하나다. 받는 사람이 목록에서 옛 파일을 집어 가는 일을 막는다.
# 릴리스와 태그 자체는 남긴다 — 어느 판이 언제 나갔는지는 기록이다.
$ErrorActionPreference = 'Stop'

$version = (Get-Content app/package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$repo = $env:GITHUB_REPOSITORY

$exe = Get-ChildItem app/release -Filter '*.exe' | Select-Object -First 1
if ($null -eq $exe) { throw 'app/release 에 exe 가 없습니다' }
Write-Host "올릴 것: $($exe.Name)  $([math]::Round($exe.Length / 1MB, 1)) MB"

gh release view $tag *> $null
if ($LASTEXITCODE -ne 0) {
  $notes = @"
설치하지 않고 그대로 실행하는 포터블 한 개 파일입니다. 받아서 두 번 누르십시오.

- 대상: Windows x64
- 검사: 묶은 것을 실제로 띄워 스모크 20건 통과

내용은 이 컴퓨터를 떠나지 않습니다. 개인 Vault 는 동기화가 없습니다.
"@
  gh release create $tag --title $tag --notes $notes
  if ($LASTEXITCODE -ne 0) { throw "릴리스를 만들지 못했습니다: $tag" }
}

gh release upload $tag $exe.FullName --clobber
if ($LASTEXITCODE -ne 0) { throw "올리지 못했습니다: $($exe.Name)" }

# 이전 판의 exe 를 지운다. per_page 를 채워 한 번에 받는다 — --paginate 는 페이지마다
# 배열을 따로 뱉어서 ConvertFrom-Json 이 못 읽는다.
$releases = gh api "repos/$repo/releases?per_page=100" | ConvertFrom-Json
foreach ($r in $releases) {
  if ($r.tag_name -eq $tag) { continue }
  foreach ($a in $r.assets) {
    if ($a.name -notlike '*.exe') { continue }
    gh api -X DELETE "repos/$repo/releases/assets/$($a.id)" *> $null
    Write-Host "이전 판 exe 삭제: $($r.tag_name) / $($a.name)"
  }
}

Write-Host "배포 완료: $tag"
