# jpop.today 소스 작업

목표는 jpop.today를 애드센스 심사를 통과할 콘텐츠 사이트로 재구성하는 것이다. 성공 지표는 production 색인 가능 페이지 수 하나다.

## 작업 방식

- 작업 브랜치에서 커밋하고 PR로 올린다. main에 직접 커밋하지 않는다. 병합은 운영자가 한다.
- Node.js 24 이상. 확인 순서는 `npm test` → `npm run check` → `JPOP_BUILD_TARGET=preview npm run build` → `npm run verify:dist`.
- 새 테스트·검증 게이트·보고·알림을 추가하지 않는다. 기존 검사는 콘텐츠 작업에 맞게 고칠 수 있다.

## 배포

- 에이전트는 Cloudflare 토큰을 받지 않고 배포하지 않는다. preview 배포와 production 전환은 운영자가 한다.
- `deploy:production`, `manage:production`, `deploy:preview`(`scripts/deploy-preview.mjs`), `inspect:cloudflare`를 실행하지 않는다.
- Cloudflare 프로젝트 연결·자동 배포 토글·도메인·DNS를 바꾸지 않는다.

## 데이터와 콘텐츠 불변 조건

- 곡 ID·URL·구 URL 301·즐겨찾기 저장 형식을 유지한다. `data/staging/`은 고치지 않고 확인은 `data/reviewed/` ledger에 추가한다.
- 공식 근거 없는 곡은 noindex. `unknown`은 미수록을 뜻하지 않는다. preview는 전체 noindex·광고 없음.
- 표·목록·번호는 데이터에서 생성하고, 해설 문단은 사람이 쓴다. 해설이 없는 글은 `draft: true`(noindex).
- 가사 전문 금지. 광고 스크립트를 넣지 않는다. 비밀 값은 출력·커밋하지 않는다.

## 검색 노출 설정

- `sitemap.xml`은 `sitemap-pages.xml`(고정·가이드·가수)과 `sitemap-songs.xml`(곡)을 묶는 색인 파일이다. 가이드 피드는 `/guides/rss.xml`.
- Search Console·네이버 서치어드바이저 소유 확인 값은 production 빌드 환경변수 `GOOGLE_SITE_VERIFICATION`, `NAVER_SITE_VERIFICATION`으로 넣는다. preview에는 출력되지 않는다.
- 공유 이미지는 `scripts/og-template.html`을 고친 뒤 `node scripts/render-og.mjs`로 `public/og/default.png`를 다시 만들어 커밋한다.
