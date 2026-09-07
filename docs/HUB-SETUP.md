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
| Node | **22.22.2 에서 플래그 없이 확인**했습니다. 그보다 낮은 판은 안 재 봤습니다 |
| 인터넷 | 필요 없습니다. 빌드본을 옮겨 넣습니다 |
| 디스크 | 원본 500건 기준 blob 이 수 GB 까지 갑니다 ([`HUB.md`](HUB.md) §7) |

`node:sqlite` 는 Node 판에 따라 `--experimental-sqlite` 를 요구합니다. 22.22.2 는 안
요구합니다. 낮은 판을 쓰신다면 먼저 이 한 줄로 보십시오.

```bash
node -e "require('node:sqlite'); console.log('ok')"
```

## 1. Node 설치

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

이 방식은 `/usr/local/bin/node` 에 깝니다. 그러면 6번의 systemd 유닛에서 `ExecStart`
경로를 고쳐야 합니다.

## 2. 계정과 폴더

서버는 전용 계정으로 돕니다. 로그인은 막습니다.

```bash
sudo useradd --system --home /srv/co-hub --shell /usr/sbin/nologin co-hub
sudo mkdir -p /srv/co-hub
sudo chown co-hub:co-hub /srv/co-hub
```

## 3. 빌드본 옮기기

**서버에서 빌드하지 않습니다.** 개발 PC 에서 만들어 `dist/` 만 옮깁니다. 서버에 소스나 `node_modules` 를 둘 이유가 없습니다.

개발 PC 에서

```bash
cd hub
npm ci
npm run check          # 타입 + 테스트 22건
npm run build          # dist/ 가 생긴다
tar -czf co-hub-dist.tgz dist deploy
```

서버에서

```bash
sudo tar -xzf co-hub-dist.tgz -C /srv/co-hub
sudo chown -R co-hub:co-hub /srv/co-hub
```

## 4. config.json

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

## 5. 먼저 손으로 한 번 띄웁니다

systemd 에 넣기 전에 됩니다. 잘못된 설정을 서비스로 감싸면 사유가 안 보입니다.

```bash
sudo -u co-hub node /srv/co-hub/dist/main.js /srv/co-hub/config.json
```

**성공하면 아무 말도 안 합니다.** 다른 창에서 확인합니다.

```bash
curl http://127.0.0.1:8787/v1/health
# {"ok":true,"at":"..."}
```

확인했으면 `Ctrl+C` 로 끕니다.

## 6. systemd 등록

```bash
sudo cp /srv/co-hub/deploy/co-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now co-hub
systemctl status co-hub
```

Node 를 `/usr/local` 에 넣으셨다면 먼저 유닛을 고칩니다.

```bash
sudo sed -i 's|/usr/bin/node|/usr/local/bin/node|' /etc/systemd/system/co-hub.service
```

유닛은 `ProtectSystem=strict` 로 돕니다. 쓸 수 있는 자리가 `/srv/co-hub` 하나뿐입니다.
`dataDir` 를 다른 곳으로 옮기셨다면 `ReadWritePaths` 도 같이 고칩니다.

## 7. 방화벽

**인터넷에 열지 않습니다.** 사내 대역만 엽니다.

```bash
sudo ufw allow from 10.0.0.0/8 to any port 8787 proto tcp
sudo ufw enable
sudo ufw status
```

`10.0.0.0/8` 자리에 실제 사내 대역을 넣으십시오. 모르면 IT 에 물어봅니다.

## 8. 첫 공간과 토큰

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

그 값을 받은 사용자는 앱의 **[설정] → 허브 연결** 에서 URL 과 함께
넣습니다. 토큰은 Windows 자격 증명 저장소에 암호문으로 들어가고 Vault 폴더에는 안
씁니다.

## 9. 백업

두 가지를 받습니다.

```bash
sudo systemctl stop co-hub
sudo tar -czf /backup/co-hub-$(date +%F).tgz -C /srv/co-hub hub.sqlite blobs
sudo systemctl start co-hub
```

`hub.sqlite` 는 WAL 모드라 돌고 있는 채로 복사하면 어긋납니다. 멈추고 받으십시오.
`blobs/` 가 커지므로 증분 백업을 쓰신다면 `rsync` 가 낫습니다.

## 10. 막혔을 때

```bash
journalctl -u co-hub -n 50 --no-pager
```

| 증상 | 볼 곳 |
|---|---|
| `adminKey 는 공백 없는 ASCII` | config.json 의 `adminKey` 에 한글이나 공백이 있습니다 |
| 바로 죽는다 | Node 판을 봅니다. `node -e "require('node:sqlite')"` |
| 켜지는데 못 붙는다 | 방화벽과 `bind`. `0.0.0.0` 이어야 밖에서 붙습니다 |
| 쓰기가 실패한다 | `ReadWritePaths` 와 `/srv/co-hub` 소유자 |
| 클라이언트가 401 | 토큰이 다릅니다. 새로 발급합니다 |

## 11. 판 올리기

```bash
sudo systemctl stop co-hub
sudo tar -xzf co-hub-dist.tgz -C /srv/co-hub    # dist 만 덮인다
sudo chown -R co-hub:co-hub /srv/co-hub
sudo systemctl start co-hub
curl http://127.0.0.1:8787/v1/health
```

`hub.sqlite` 와 `blobs/` 는 안 건드립니다. 스키마가 바뀌는 판이면 릴리스 노트에 적습니다.

## 12. 안 하는 것

- **인터넷에 안 엽니다.** 사내망 전용입니다
- TLS 를 안 씁니다. 사내망 안이고 붙이려면 앞에 리버스 프록시를 둡니다
- LLM 도 비즈니스 로직도 없습니다. 저장하고 판을 세고 이벤트를 쌓습니다
- 서버가 죽어도 각자 로컬 미러로 계속 일합니다
