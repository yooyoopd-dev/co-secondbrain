# CO-Hub — 사내 동기화 서버

설계는 [`docs/HUB.md`](../docs/HUB.md). 이 문서는 돌리는 법만 적는다.

**런타임 의존성이 없다.** `node:sqlite` 와 `node:http` 만 쓴다. 사내 오프라인 설치에서
의존성 하나가 곧 배포 비용이다.

## 돌리는 곳

최신 Ubuntu 리눅스 PC. 클라이언트(데스크톱 앱)만 Windows다.

## 배포

```
npm run build                       # dist/ 생성
sudo mkdir -p /srv/co-hub && sudo cp -r dist /srv/co-hub/
sudo cp deploy/config.example.json /srv/co-hub/config.json   # adminKey 를 채운다
sudo cp deploy/co-hub.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now co-hub
sudo ufw allow from 10.0.0.0/8 to any port 8787              # 사내 대역만
```

`adminKey` 는 **공백 없는 ASCII** 여야 한다. `X-Admin-Key` 헤더로 오는데 HTTP 헤더 값이 ASCII 만 받으므로 한글을 넣으면 클라이언트가 보내지도 못하며 그걸 배포한 뒤에 알게 되면 늦으니 시작할 때 걸러 준다.

## 첫 설정

관리 API 는 `X-Admin-Key` 로만 열린다. 토큰이 하나도 없는 상태에서 시작해야 하므로
부트스트랩 경로가 따로 있다.

```
curl -XPOST -H "X-Admin-Key: $KEY" -d '{"id":"ACME","title":"2026 ACME"}' \
     http://허브:8787/v1/admin/spaces
curl -XPOST -H "X-Admin-Key: $KEY" -d '{"spaceId":"ACME","userId":"hong@corp","role":"writer"}' \
     http://허브:8787/v1/admin/members
curl -XPOST -H "X-Admin-Key: $KEY" -d '{"userId":"hong@corp"}' \
     http://허브:8787/v1/admin/tokens
```

마지막 응답의 `token` 이 **평문으로 보이는 유일한 순간**이다. 서버는 sha256 해시만 갖는다.

## 확인

```
curl http://허브:8787/v1/health          # 토큰 없이 열려 있다. systemd 가 본다
npm run check                            # 타입 + 테스트 22건
node --experimental-strip-types ../spikes/hub/concurrent.ts   # 2프로세스 동시 쓰기 무손실
```

## 아직 없는 것

- **검토 큐** (`/v1/spaces/{s}/proposals`) — 서버가 ChangeSet 을 적용해야 해서
  동기화 클라이언트(ROADMAP 16번)와 같이 만든다
- **MCP HTTP 엔드포인트** ([`HUB.md`](../docs/HUB.md) §5.5) — 앱 내장 MCP 서버가 먼저다
