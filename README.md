# jpop.today

한국어로 JPOP를 찾아 TJ·금영 관측 번호를 비교하고 나만의 선곡 목록을 준비하는 정적 앱입니다.

[운영 사이트](https://jpop.today) · [제품 스펙과 운영 문서](https://github.com/jpop-today/docs) · [조직 규칙](https://github.com/jpop-today/.github)

## 한 장 요약

한국어로 JPOP를 찾아 TJ·금영 노래방 번호를 비교하는 정적 사이트(Astro)입니다.

데이터 신뢰성 정책은 [`contracts/publication.mjs`](contracts/publication.mjs) 한 파일이 정합니다.

1. 곡 화면은 현재 수록곡이면서 TJ·금영 중 한 곳 이상이 공식 확인(`provider-confirmed`, 제공사 조회 근거 있음, 충돌 없음)일 때만 `index, follow`이고, 나머지 곡은 `noindex, follow`입니다.
2. 가수·가이드 화면은 검토를 마친 것(`indexable: true`)만, 고정 화면은 정해 둔 9개 경로만 색인합니다.
3. 미리보기 빌드는 전부 `noindex`이고, 검색 엔진 소유 확인 값은 운영 빌드에만 넣으며 형식이 틀리면 빌드를 멈춥니다.

2026-10-22 운영 빌드(`JPOP_BUILD_TARGET=production npm run build`, 커밋 a68df00) 기준으로 곡 화면 3,317개 중 91개가 색인 대상이고, 사이트맵에는 곡 91개와 고정 화면 9개·가수 25개·가이드 11개가 들어갑니다. 이 정책을 문제·결정·결과로 정리한 글은 [devlog 포트폴리오 사례 5](https://devlog.life/portfolio#jpop)입니다.

## 현재 구현

Astro + TypeScript 정적 페이지, 브라우저 검색·번호 복사·즐겨찾기, 데이터 계약·실패 보존 하네스를 포함합니다. 기존 3,317개 ID를 유지하며 현재 검색 3,313개와 보관 4개를 구분합니다. 각 곡 상세와 가이드는 JavaScript 없이 본문을 읽을 수 있습니다. 이전 `/song?id=`, `/filter`, `.html`, `/#favorites-view`와 `jpop_today_favorites` 문자열·객체 저장 형식을 지원합니다.

번호는 관측값과 공식 대조 결과를 구분합니다. 원본 staging은 그대로 두고 검토한 correction ledger를 공개 v2 read model에 적용합니다. 공식 확인에는 제목·가수·확인일·제공사 조회 링크를 표시하고, 반증되거나 버전이 불명확한 번호는 검색·복사에서 제외합니다. 빈 값은 `unknown`이며 미수록으로 단정하지 않습니다. 모든 3,317 ID와 저장 키는 유지합니다. 가사·외부 이미지·광고 요청을 발행하지 않습니다.

기존 Cloudflare `todayjpop` 프로젝트와 `jpop.today` origin을 유지하는 운영 전환을 지원합니다. Git 연결 metadata는 개인 원본에 남을 수 있지만 자동 배포를 가역적으로 중지하고 조직의 검증된 artifact를 직접 배포합니다. 별도 `jpoptoday-preview`는 전체 noindex이며 production은 검토된 콘텐츠와 근거가 있는 상세만 색인합니다. 실제 현재 SHA·자동 배포 설정·복구·AdSense 상태는 [운영 기록](https://github.com/jpop-today/docs/blob/main/operations/status.md)에서 재확인합니다.

## 개발과 검증

앱 Node.js 24 이상, npm lockfile을 사용합니다. 기존 독립 계약은 Node22 CI도 유지합니다.

```sh
npm ci
npm test
npm run check
npm run build
npm run verify:dist
npx playwright install chromium
npm run test:e2e
npm run dev
```

시스템 Chromium이 있는 클라우드에서는 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e`를 사용할 수 있습니다. Browser plugin이 없는 세션의 Playwright fallback이며 WebKit 검증과 실제 필드 Core Web Vitals는 별도 작업입니다.

`npm run build`는 고정 staging·검토 ledger·보관 차트로 dist만 생성하며 외부 수집을 하지 않습니다. 기본 target은 preview, `JPOP_BUILD_TARGET=production npm run build`는 운영 artifact를 생성합니다. build-info는 target·소스 SHA·catalog/ledger/chart hash·원본 revision·개수·dirty를 연결합니다. `verify:dist`는 상세·canonical·mode별 robots/sitemap·허용 공개 필드·비공개 원본/도구/이미지/광고 제외를 검사합니다.

`npm run verify:deployment -- <HTTPS URL> <동일 target dist 경로> <새 receipt.json>`은 실제 응답을 고정 artifact와 비교합니다. 전후 진단 metadata의 같은 SHA/입력 hash뿐 아니라 query 없는 본문·카탈로그·crawler 파일·대표 상세도 확인하며, 제한된 재시도의 실패와 최종 결과를 보존합니다. `EXPECTED_SOURCE_SHA`와 `EXPECTED_TARGET`으로 대상도 고정할 수 있습니다. [배포 응답 계약](https://github.com/jpop-today/docs/blob/main/adr/007-deployment-response-verification.md)을 따르며 API canonical 변경만을 실제 사이트 검증으로 쓰지 않습니다.

```sh
npm run deploy:preview
```

clean HEAD와 동일 SHA로 빌드·검증한 dist만 `jpoptoday-preview`에 배포합니다. 미리보기 프로젝트는 먼저 생성되어 있어야 합니다. CLOUDFLARE_API_TOKEN과 CLOUDFLARE_ACCOUNT_ID는 환경의 안전한 binding에서 사용하고 값은 출력·커밋하지 않습니다. 운영은 `JPOP_BUILD_TARGET=production npm run build` 후 `npm run deploy:production`으로 기존 todayjpop/dev에 배포합니다. 반드시 동일 SHA CI·noindex preview·복구 게이트를 먼저 검증하고 개인 원본 자동 배포를 중단해야 합니다. `manage:production`의 inspect/pause/restore/rollback은 복구 설정과 실제 API 확인을 지원합니다. Actions 운영 workflow는 입력 SHA의 main 이력·CI·같은 reviewed input preview를 확인하며 CF secret 미설정은 explicit skipped로 기록합니다. cloud binding을 Actions에 복사하지 않습니다.

## 매일 개발·Discord·릴리스

Codex 관리자는 매일 09:00 Asia/Seoul 예약에서 새 하위 에이전트 3명을 배정합니다. 중간 한도 중단을 이어가기 위한 매시간 재개 점검도 같은 채팅에 등록했습니다. 활성 실행 중에는 중복 수정하지 않습니다. 토큰 초기화 이벤트나 24시간 연속 실행을 보장하지 않습니다. 실제 지원 도구·환경·원격 기록을 확인하고 개발·검증·두 동료의 평가·교체·통합을 수행합니다. 운영 기준과 실제 예약 상태는 [일일 개발](https://github.com/jpop-today/docs/blob/main/operations/daily-development.md)에 있습니다. 원본의 파랑·분홍 및 파스텔 그라데이션을 유지합니다.

GitHub Actions `discord-report`는 오전 09시(KST, UTC 00시) 전날 저장된 완료 결과·오늘 계획, CI 완료, 게시된 릴리스, 관리자 수동 보고를 알립니다. GitHub 예약은 지연될 수 있습니다. Actions가 AI 개발을 수행하는 것은 아니며, 기록 없는 전날 결과를 만들어내지 않습니다.

운영자는 [소스 저장소 Actions secret 입력](https://github.com/jpop-today/jpoptoday/settings/secrets/actions/new)에서 **DISCORD_WEBHOOK_URL**을 추가하세요. 값은 Discord 채널의 연동 → 웹후크에서 복사하고 채팅·코드·보고 파일에 넣지 마세요. secret이 없으면 명시적으로 skipped이며 실제 전송은 확인되지 않습니다. CI 완료 알림은 trusted default branch의 송신기를 실행하고 fork의 코드를 secret과 함께 실행하지 않습니다.

```sh
npm run report:morning -- /tmp/jpop-morning.json
npm run report:completed -- /tmp/jpop-completed.json
npm run notify:discord -- /tmp/jpop-completed.json
```

송신기의 실전송은 Node24.5 이상을 사용하며 기존 proxy/CA와 TLS 검증을 유지합니다. CLI 종료 0은 sent 또는 missing-secret skipped, 종료 1은 failed입니다. webhook 목적지를 검증하고 비밀값·멘션을 제거하며, 429만 짧게 재시도합니다. POST timeout/5xx는 중복 방지를 위해 자동 재송신하지 않습니다.

관리자는 의미 있는 검증된 변경에 `package.json`과 `releases/vX.Y.Z.md`를 갱신하고, PR 병합·CI·미리보기 확인 후 같은 main 소스에 `vX.Y.Z` 태그를 올립니다. `version-release`는 버전·main 이력·노트·전체 하네스를 확인한 뒤 실제 GitHub Release를 게시합니다. 배포·AdSense 상태는 릴리스 노트와 일일 보고에서 따로 확인합니다.

## 데이터 계약과 원본 복구

```sh
npm run validate:catalog -- tests/fixtures/catalog.json
node scripts/validate-catalog.mjs /absolute/path/to/candidate.json
node scripts/promote-catalog.mjs /absolute/path/to/candidate.json /absolute/path/to/snapshot.json
npm run inspect:cloudflare -- --project todayjpop
node scripts/import-legacy-staging.mjs /path/to/original-checkout 6dbe5a65d1bd729c09393f746f715f4363089a43 data/legacy-identity-baseline.json data/staging/legacy-catalog.json --check
```

합성 fixture와 공개 관측 read model을 검증 카탈로그로 승격하지 않습니다. 검증된 whole-catalog에서 기존 ID 누락과 registered/unlisted→unknown 퇴행을 거부합니다. JSON 파싱·쓰기·rename 실패는 마지막 정상 snapshot을 보존합니다. importer --check에는 정확한 원본 Git 객체가 필요하며 일반 npm test는 외부 원본 없이 committed baseline/staging을 검사합니다.

## 문서와 다음 작업

- [제품 스펙](https://github.com/jpop-today/docs/blob/main/product/spec.md), [아키텍처와 ADR](https://github.com/jpop-today/docs/blob/main/architecture/overview.md)
- [관측 read model 결정](https://github.com/jpop-today/docs/blob/main/adr/004-observed-preview-read-model.md), [공식 공유번호 대조](https://github.com/jpop-today/docs/blob/main/data/provider-evidence-20261013.md)
- [앱 하네스](https://github.com/jpop-today/docs/blob/main/engineering/app-harness.md), [기존 URL/storage 계약](https://github.com/jpop-today/docs/blob/main/engineering/legacy-compatibility.md)
- [지속 개발과 세션 재개](https://github.com/jpop-today/docs/blob/main/operations/continuous-development.md), [작업 큐](https://github.com/jpop-today/docs/blob/main/operations/roadmap.md)
- [배포·복구](https://github.com/jpop-today/docs/blob/main/operations/deployment.md), [AdSense 공식 정책 조사](https://github.com/jpop-today/docs/blob/main/operations/adsense-policy-review-20261013.md)

실행 코드는 이 저장소, 제품·설계·운영 기록은 docs, 조직 공통 규칙은 .github에서 관리합니다. 번호 정정·행별 근거 보강·콘텐츠 검토와 운영 전환 게이트를 다음 작업으로 이어갑니다. 개발·CI·미리보기 성공과 Google 심사 승인은 서로 다른 상태입니다.
