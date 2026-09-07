# CO-Hub 설치 — Ubuntu PC

사내 동기화 서버를 리눅스 PC 한 대에 올리는 절차입니다. 설계는 [`HUB.md`](HUB.md),
돌리는 법 요약은 [`../hub/README.md`](../hub/README.md) 에 있습니다.

**런타임 의존성이 없습니다.** `node:sqlite` 와 `node:http` 만 씁니다. 오프라인 사내
설치에서 의존성 하나가 곧 배포 비용입니다.

---

## 0. 준비물

| | |
|---|---|
| 서버 | Ubuntu PC 한 대. 사내망 고정 IP |
| Node | **22.22.2 에서 플래그 없이 확인**했습니다. 그보다 낮은 판도, 24.x 도 안 재 봤습니다 |
| 인터넷 | 필요 없습니다. 빌드본을 옮겨 넣습니다 |
| 옮기는 길 | SSH (1번) 또는 USB. 허브 PC 앞에 앉지 않아도 됩니다 |
| 디스크 | 원본 500건 기준 blob 이 수 GB 까지 갑니다 ([`HUB.md`](HUB.md) §7) |

`node:sqlite` 는 Node 판에 따라 `--experimental-sqlite` 를 요구합니다. 22.22.2 는 안
요구합니다. 다른 판을 쓰신다면 먼저 이 한 줄로 보십시오.

```bash
node -e "require('node:sqlite'); console.log('ok')"
```

## 1. SSH 로 붙어서 하기

허브 PC 앞에 앉을 필요가 없습니다. 사내 개인 PC 에서 원격으로 다 됩니다.

Windows 10 · 11 에는 OpenSSH 클라이언트가 들어 있어 PowerShell 에서 `ssh` 와 `scp` 가
바로 됩니다. 따로 깔 것이 없습니다.

```powershell
ssh co-hub관리자@192.168.0.50
```

`192.168.0.50` 자리에 허브 PC 의 사내망 IP 를 넣습니다. 붙는 것만 확인하고 끊습니다.

### 파일 옮기기

릴리스에서 받은 `.tgz` 를 홈 폴더로 보냅니다. **`/srv` 로 바로 못 보냅니다** — scp 는
로그인 계정 권한으로 쓰고 그 자리는 root 것입니다. 홈에 두고 서버에서 옮깁니다.

```powershell
cd $env:USERPROFILE\Downloads
scp co-hub-0.9.1.tgz co-hub관리자@192.168.0.50:~/
```

Node 를 오프라인으로 깔아야 한다면(2번) tarball 도 같이 보냅니다.

```powershell
scp node-v22.22.2-linux-x64.tar.xz co-hub관리자@192.168.0.50:~/
```

### 명령 하나씩 보내기

붙어서 대화형으로 하는 편이 낫습니다. 한 줄씩 보내려면 `-t` 를 붙이십시오 —
`sudo` 가 비밀번호를 물을 때 터미널이 필요합니다.

```powershell
ssh -t co-hub관리자@192.168.0.50 "sudo systemctl status co-hub"
```

### 전체 순서

붙어서 아래를 차례로 붙여 넣으면 끝납니다. 각 줄이 무엇을 하는지는 2번부터 자세히
적어 뒀습니다.

```bash
# 0) 확인 — Node 가 있고, sudo 로도 보이고, node:sqlite 가 열리는가
node --version
readlink -f "$(command -v node)"           # /home 이나 .nvm 이면 2번을 먼저 본다
sudo -u root "$(command -v node)" -e "require('node:sqlite'); console.log('ok')"

# 1) 계정과 폴더
sudo useradd --system --home /srv/co-hub --shell /usr/sbin/nologin co-hub
sudo mkdir -p /srv/co-hub

# 2) 홈에 올려 둔 묶음을 푼다
sudo tar -xzf ~/co-hub-0.9.1.tgz -C /srv/co-hub

# 3) 설정
sudo cp /srv/co-hub/deploy/config.example.json /srv/co-hub/config.json
openssl rand -hex 24                       # 이 값을 adminKey 에 넣는다
sudo nano /srv/co-hub/config.json
sudo chmod 600 /srv/co-hub/config.json
sudo chown -R co-hub:co-hub /srv/co-hub

# 4) 손으로 한 번 띄워 본다 — node 는 절대 경로로 부른다 (sudo 가 PATH 를 갈아 끼운다)
NODE=$(command -v node)
sudo -u co-hub $NODE /srv/co-hub/dist/main.js /srv/co-hub/config.json
#    다른 창에서: curl http://127.0.0.1:8787/v1/health
#    확인했으면 Ctrl+C

# 5) systemd
sudo cp /srv/co-hub/deploy/co-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now co-hub
systemctl status co-hub

# 6) 방화벽 — 사내 대역만
sudo ufw allow from 10.0.0.0/8 to any port 8787 proto tcp
sudo ufw enable
```

4번에서 손으로 먼저 띄우는 이유가 있습니다. 잘못된 설정을 systemd 로 감싸면 사유가
`journalctl` 안으로 들어가 버립니다.

### 판을 올릴 때도 같은 길

```powershell
scp co-hub-<새판>.tgz co-hub관리자@192.168.0.50:~/
ssh -t co-hub관리자@192.168.0.50
```

```bash
sudo systemctl stop co-hub
sudo tar -xzf ~/co-hub-<새판>.tgz -C /srv/co-hub    # dist 만 덮인다
sudo chown -R co-hub:co-hub /srv/co-hub
sudo systemctl start co-hub
curl http://127.0.0.1:8787/v1/health
```

`hub.sqlite` 와 `blobs/` 는 안 건드립니다.

### 막히면

| 증상 | 볼 곳 |
|---|---|
| `Connection refused` | 허브 PC 에 sshd 가 없습니다. `sudo apt install openssh-server` |
| `Permission denied` | 계정이나 비밀번호. 키를 쓰신다면 `ssh-copy-id` 로 먼저 넣습니다 |
| `scp` 가 `Permission denied` | `/srv` 로 바로 보내셨습니다. 홈(`:~/`)으로 보내십시오 |
| `sudo: a terminal is required` | `ssh -t` 를 씁니다 |


## 2. Node 설치

인터넷이 되면 그냥 받습니다.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

인터넷이 안 되면 tarball 을 옮겨 넣습니다.

```bash
# 인터넷 되는 곳에서 받아 USB 로 옮긴다
# https://nodejs.org/dist/v22.22.2/node-v22.22.2-linux-x64.tar.xz
sudo tar -xJf node-v22.22.2-linux-x64.tar.xz -C /usr/local --strip-components=1
node --version
```

이 방식은 `/usr/local/bin/node` 에 깝니다. 그러면 7번의 systemd 유닛에서 `ExecStart`
경로를 고쳐야 합니다.

### nvm 으로 깔면 안 됩니다

`nvm` 은 Node 를 **자기 홈 폴더 안에만** 깝니다. 그러면 두 곳에서 막힙니다.

- `sudo` 가 PATH 를 `secure_path` 로 갈아 끼웁니다. 거기에 홈 폴더가 없어
  `sudo: node: command not found` 가 납니다
- 절대 경로로 불러 그 줄을 넘겨도 다음 줄에서 막힙니다. 서비스는 `co-hub` 계정으로
  도는데 그 계정은 남의 홈을 못 읽습니다. `sudo: unable to execute
  /home/.../.nvm/versions/node/vXX/bin/node: Permission denied` 가 이것입니다

두 오류는 원인이 같습니다. 절대 경로는 첫 번째만 넘기고 두 번째는 못 넘깁니다.
`node --version` 이 되는데 `sudo -u co-hub node ...` 가 안 되면 이 경우입니다.
어디 깔렸는지 봅니다.

```bash
command -v node
readlink -f "$(command -v node)"
sudo -u co-hub env | grep ^PATH
```

두 번째 줄이 `/home/...` 이나 `.nvm` 을 가리키면 위의 tarball 방식으로 **시스템 전체에**
다시 깝니다. nvm 쪽은 지워도 되고 그대로 두어도 됩니다. nvm 이 `.bashrc` 에서 자기 경로를
PATH 앞에 붙이므로 로그인 셸에서는 계속 nvm 판이 잡힙니다. `sudo` 와 서비스는
`/usr/local/bin` 판을 씁니다. 둘이 부딪히지 않습니다.

```bash
# 인터넷이 되면 — /usr/bin/node 에 깔립니다
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 안 되면 tarball — /usr/local/bin/node 에 깔립니다
# 개인 PC 에서 scp 로 보내 두었다면 그 경로를 씁니다
sudo tar -xJf ~/node-v22.22.2-linux-x64.tar.xz -C /usr/local --strip-components=1
```

**둘은 깔리는 자리가 다릅니다.** 어느 쪽을 쓰셨든 경로를 직접 찍지 말고 물어봅니다.
`co-hub` 계정으로 물으므로 나오는 답이 곧 `sudo` 와 서비스가 쓸 경로입니다.

```bash
sudo -u co-hub sh -c 'command -v node; node --version'
```

경로 한 줄과 판 한 줄이 나오면 끝입니다. 그 경로를 적어 둡니다 — 6번의 손띄우기도,
7번의 `ExecStart` 도 이 경로입니다.

아무것도 안 나오면 아직 시스템 전체에 안 깔린 것입니다. 어디 있는지 봅니다.

```bash
ls -l /usr/bin/node /usr/local/bin/node
```

## 3. 계정과 폴더

서버는 전용 계정으로 돕니다. 로그인은 막습니다.

```bash
sudo useradd --system --home /srv/co-hub --shell /usr/sbin/nologin co-hub
sudo mkdir -p /srv/co-hub
sudo chown co-hub:co-hub /srv/co-hub
```

## 4. 빌드본 옮기기

**서버에서 빌드하지 않습니다.** 서버에 소스나 `node_modules` 를 둘 이유가 없습니다.

### 받아서 옮기기 (권장)

[릴리스](https://github.com/yooyoopd-dev/co-secondbrain/releases/latest)에 Windows exe 와
같이 `co-hub-<판>.tgz` 가 올라갑니다. 인터넷 되는 곳에서 받아 SSH 나 USB 로 옮기십시오.
원격으로 하는 절차는 **1번**에 있습니다.

```bash
sudo tar -xzf ~/co-hub-0.9.1.tgz -C /srv/co-hub
sudo chown -R co-hub:co-hub /srv/co-hub
```

`dist/` 와 `deploy/` 와 `README.md` 가 들어 있습니다. 12 KB 입니다 — 런타임 의존성이
없어서 이만큼입니다.

### 직접 빌드하기

```bash
cd hub
npm ci
npm run check          # 타입 + 테스트 22건
npm run build          # dist/ 가 생긴다
tar -czf co-hub-dist.tgz dist deploy README.md
```

`tsc` 만 돌아서 어디서 빌드해도 결과가 같습니다. 리눅스에서 안 만들어도 됩니다.

## 5. config.json

```bash
sudo cp /srv/co-hub/deploy/config.example.json /srv/co-hub/config.json
sudo nano /srv/co-hub/config.json
```

```json
{
  "bind": "0.0.0.0",
  "port": 8787,
  "dataDir": "/srv/co-hub",
  "adminKey": "여기에-공백-없는-ASCII-비밀을-넣으십시오"
}
```

**`adminKey` 는 공백 없는 ASCII 여야 합니다.** `X-Admin-Key` 헤더로 오는데 HTTP 헤더
값이 ASCII 만 받습니다. 한글을 넣으면 클라이언트가 보내지도 못합니다. 서버가 켜질 때
걸러 주므로 배포한 뒤에 알게 되는 일은 없습니다.

```bash
openssl rand -hex 24      # 이런 값을 씁니다
sudo chmod 600 /srv/co-hub/config.json
sudo chown co-hub:co-hub /srv/co-hub/config.json
```

## 6. 먼저 손으로 한 번 띄웁니다

systemd 에 넣기 전에 됩니다. 잘못된 설정을 서비스로 감싸면 사유가 안 보입니다.

**`co-hub` 계정에게 물어서 나온 경로를 씁니다.** `sudo` 는 PATH 를 `secure_path` 로 갈아
끼우기 때문에 로그인 셸에서 되던 `node` 가 여기서는 안 될 수 있습니다 (2번).

```bash
sudo -u co-hub sh -c 'command -v node'
```

`/usr/bin/node` 나 `/usr/local/bin/node` 가 나와야 합니다. 아무것도 안 나오거나
`/home/...` · `.nvm` 이 나오면 여기서 멈추고 2번으로 돌아갑니다. 홈 안의 경로를 그대로
쓰면 `Permission denied` 가 납니다 — `co-hub` 계정이 남의 홈을 못 읽습니다.

```bash
NODE=$(sudo -u co-hub sh -c 'command -v node')
sudo -u co-hub $NODE /srv/co-hub/dist/main.js /srv/co-hub/config.json
```

`EADDRINUSE: address already in use 0.0.0.0:8787` 이 나오면 8787 을 이미 누가
잡고 있습니다. 대개 앞서 켠 허브가 그대로 살아 있는 것입니다. 누구인지 봅니다.

```bash
sudo ss -ltnp | grep 8787
systemctl status co-hub --no-pager
```

`co-hub` 서비스면 이미 떠 있는 것이니 이 절은 건너뛰고 아래 `curl` 로 확인만 하고
8번으로 갑니다. 앞서 손으로 띄운 것이 안 죽은 것이면 그 PID 를 끕니다. 남이면
`config.json` 의 `port` 를 바꾸고 방화벽(8번)도 같이 고칩니다.

이렇게 나오면 뜬 것입니다.

```
(node:3336) ExperimentalWarning: SQLite is an experimental feature and might change at any time
co-hub 0.0.0.0:8787 · /srv/co-hub
```

**`ExperimentalWarning` 은 정상입니다.** Node 22 가 `node:sqlite` 에 붙이는 경고이고
동작에 지장이 없습니다. 보기 싫으면 `--no-warnings` 를 붙입니다.

다른 창에서 확인합니다.

```bash
curl http://127.0.0.1:8787/v1/health
# {"ok":true,"at":"..."}
```

확인했으면 `Ctrl+C` 로 끕니다.

## 7. systemd 등록

```bash
sudo cp /srv/co-hub/deploy/co-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now co-hub
systemctl status co-hub
```

유닛의 `ExecStart` 가 `/usr/bin/node` 를 가리킵니다. 6번에서 확인한 경로가 그것이면
그냥 둡니다. `/usr/local/bin/node` 였으면 고칩니다.

```bash
sudo -u co-hub sh -c 'command -v node'
sudo sed -i 's|/usr/bin/node|/usr/local/bin/node|' /etc/systemd/system/co-hub.service
sudo systemctl daemon-reload
```

**홈 폴더 안의 경로를 넣으면 안 됩니다.** 서비스는 `co-hub` 계정으로 도는데 그 계정은
남의 홈을 못 읽습니다 (2번).

유닛은 `ProtectSystem=strict` 로 돕니다. 쓸 수 있는 자리가 `/srv/co-hub` 하나뿐입니다.
`dataDir` 를 다른 곳으로 옮기셨다면 `ReadWritePaths` 도 같이 고칩니다.

## 8. 방화벽

**인터넷에 열지 않습니다.** 사내 대역만 엽니다.

```bash
sudo ufw allow from 10.0.0.0/8 to any port 8787 proto tcp
sudo ufw enable
sudo ufw status
```

`10.0.0.0/8` 자리에 실제 사내 대역을 넣으십시오. 모르면 IT 에 물어봅니다.

## 9. 첫 공간과 토큰

**공간 id 는 Vault 의 `id` 와 글자까지 같아야 합니다.** 앱은 Vault 의
`.sb/config.json` 에 적힌 `id` 를 그대로 공간 id 로 씁니다 (`core/sync/engine.ts`).
아래에서 공간을 `ACME` 로 만들었으면 붙일 Vault 도 `id` 가 `ACME` 여야 합니다.
다르면 붙기는 붙는데 동기화가 404 로 떨어집니다.

```bash
# 윈도우 PC 에서, 붙일 Vault 폴더에서
type .sb\config.json
```

`id` 는 Vault 를 만들 때 정해집니다. 이미 다른 이름으로 만들었으면 그 이름으로 공간을
만드는 쪽이 빠릅니다. `id` 가 `personal` 인 Vault 는 아예 허브에 안 붙습니다.

관리 API 는 `X-Admin-Key` 로만 열립니다.

```bash
KEY=$(sudo grep -oP '"adminKey"\s*:\s*"\K[^"]+' /srv/co-hub/config.json)
HUB=http://127.0.0.1:8787

curl -XPOST -H "X-Admin-Key: $KEY" -d '{"id":"ACME","title":"2026 ACME"}' \
     $HUB/v1/admin/spaces

curl -XPOST -H "X-Admin-Key: $KEY" \
     -d '{"spaceId":"ACME","userId":"hong@corp","role":"writer"}' \
     $HUB/v1/admin/members

curl -XPOST -H "X-Admin-Key: $KEY" -d '{"userId":"hong@corp"}' \
     $HUB/v1/admin/tokens
```

마지막 응답의 `token` 이 **평문으로 보이는 유일한 순간**입니다. 서버는 sha256 해시만
갖고 있어 다시 볼 수 없습니다. 잃어버리면 새로 발급합니다.

받은 토큰이 실제로 그 공간을 여는지 여기서 한 번 봅니다.

```bash
TOKEN=<위에서 받은 토큰>
curl -H "Authorization: Bearer $TOKEN" $HUB/v1/spaces
```

목록에 `ACME` 가 있어야 합니다. 비어 있으면 `members` 를 안 넣었거나 `userId` 가 다릅니다.

그 값을 받은 사용자는 앱의 **[설정] → [허브 연결]** 에서 URL 과 함께
넣습니다. 토큰은 Windows 자격 증명 저장소에 암호문으로 들어가고 Vault 폴더에는 안
씁니다.

## 10. 백업

두 가지를 받습니다.

```bash
sudo systemctl stop co-hub
sudo tar -czf /backup/co-hub-$(date +%F).tgz -C /srv/co-hub hub.sqlite blobs
sudo systemctl start co-hub
```

`hub.sqlite` 는 WAL 모드라 돌고 있는 채로 복사하면 어긋납니다. 멈추고 받으십시오.
`blobs/` 가 커지므로 증분 백업을 쓰신다면 `rsync` 가 낫습니다.

## 11. 막혔을 때

```bash
journalctl -u co-hub -n 50 --no-pager
```

| 증상 | 볼 곳 |
|---|---|
| `adminKey 는 공백 없는 ASCII` | config.json 의 `adminKey` 에 한글이나 공백이 있습니다 |
| `sudo: node: command not found` | `sudo` 가 PATH 를 갈아 끼웁니다. Node 를 시스템 전체에 깝니다 (2번) |
| 시스템 전체에 깔았는데도 `command not found` | 경로를 찍은 것이 틀렸습니다. apt 는 `/usr/bin`, tarball 은 `/usr/local/bin` 입니다. `sudo -u co-hub sh -c 'command -v node'` 로 물어봅니다 |
| `sudo: unable to execute .../node: Permission denied` | Node 가 남의 홈(nvm) 안에 있습니다. `co-hub` 계정이 못 읽습니다. 시스템 전체에 다시 깝니다 (2번) |
| 바로 죽는다 | Node 판을 봅니다. `node -e "require('node:sqlite')"` |
| `EADDRINUSE ... 0.0.0.0:8787` | 8787 을 이미 누가 잡고 있습니다. `sudo ss -ltnp \| grep 8787` 로 봅니다 (6번) |
| 켜지는데 못 붙는다 | 방화벽과 `bind`. `0.0.0.0` 이어야 밖에서 붙습니다 |
| `ExperimentalWarning: SQLite` | 정상입니다. Node 22 가 `node:sqlite` 에 붙이는 경고입니다 |
| 쓰기가 실패한다 | `ReadWritePaths` 와 `/srv/co-hub` 소유자 |
| 클라이언트가 401 | 토큰이 다릅니다. 새로 발급합니다 |

## 12. 판 올리기

```bash
sudo systemctl stop co-hub
sudo tar -xzf co-hub-dist.tgz -C /srv/co-hub    # dist 만 덮인다
sudo chown -R co-hub:co-hub /srv/co-hub
sudo systemctl start co-hub
curl http://127.0.0.1:8787/v1/health
```

`hub.sqlite` 와 `blobs/` 는 안 건드립니다. 스키마가 바뀌는 판이면 릴리스 노트에 적습니다.

## 13. 안 하는 것

- **인터넷에 안 엽니다.** 사내망 전용입니다
- TLS 를 안 씁니다. 사내망 안이고 붙이려면 앞에 리버스 프록시를 둡니다
- LLM 도 비즈니스 로직도 없습니다. 저장하고 판을 세고 이벤트를 쌓습니다
- 서버가 죽어도 각자 로컬 미러로 계속 일합니다
