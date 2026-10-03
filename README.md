# POE2 시세 · 판매 계산기 (gol_dic)

POE2 아이템 시세를 한글로 보여주고, 카오스·디바인·엑잘 중 어떤 화폐로 팔아야
가장 많이 받는지(정수 버림 반영)와 추천 묶음 비율을 계산해 주는 비공식 사이트.

- 시세: poe.ninja (POE2 교환소 집계)
- 한글 이름: 카카오게임즈 POE2 공식 거래소 static 데이터 (poe.ninja와 같은 id로 매칭)

## 구조
| 파일 | 역할 |
|---|---|
| `src/worker.js` | Cloudflare Worker — 10분마다 시세 수집해 KV에 저장, `/api/snapshot`, `/api/item` 제공 |
| `src/auth.js` | Google 로그인(ID 토큰 검증 + 세션 쿠키), 즐겨찾기 동기화 `/api/me`, `/api/favs` |
| `migrations/` | D1(사용자·즐겨찾기) 테이블 정의 |
| `public/index.html` | 화면 (검색, 카테고리, 판매 계산기) |
| `wrangler.toml` | Worker 설정 (cron, KV, 수집 리그) |

## 로컬 실행
```
npm install
npx wrangler d1 migrations apply goldic --local
# .dev.vars 파일에 SESSION_SECRET=<임의의 긴 문자열>
npm run dev
# 다른 창에서 수집 1회 실행: curl http://localhost:8787/__scheduled
# 브라우저: http://localhost:8787
```

## 배포 (처음 한 번)
```
npx wrangler login
npx wrangler kv namespace create DATA   # 나온 id를 wrangler.toml의 REPLACE_WITH_KV_ID 자리에
npm run deploy
```
주소: `https://goldic.sickal.workers.dev` (Cloudflare 대시보드에서 도메인 연결 가능)

## 리그 변경
`wrangler.toml`의 `LEAGUES` 수정 후 재배포. 리그 1개당 poe.ninja 요청 13회,
무료 플랜은 실행 1회당 외부 요청 50회 제한이라 최대 3개.

## Google 로그인 설정
1. Google Cloud Console → Google 인증 플랫폼에서 OAuth 동의 화면(외부) 만들고 앱 게시
2. 클라이언트 만들기 → 웹 애플리케이션, 승인된 JavaScript 원본:
   `https://goldic.sickal.workers.dev`, `http://localhost:8787`
3. 나온 클라이언트 ID를 `wrangler.toml`의 `GOOGLE_CLIENT_ID`에 (클라이언트 보안 비밀번호는 필요 없음)
4. 처음 한 번:
```
npx wrangler d1 migrations apply goldic --remote
npx wrangler secret put SESSION_SECRET   # 임의의 긴 문자열
```
