# jpop.today 소스 작업

사용자는 스펙·재설계·수정·검증·통합·배포를 위임했다. 일상 작업에 같은 승인을 반복 요청하지 않는다. 기준은 https://github.com/jpop-today/docs 의 product/spec.md와 관련 ADR, 조직 규칙은 https://github.com/jpop-today/.github 의 AGENTS.md·CONTRIBUTING.md다. 공유 워크스페이스에서는 파일 범위·base SHA·담당을 공유하고 git 작업은 통합 담당자 한 명이 수행한다. 클라우드 기존 체크아웃을 사용하며 명시 요청 없이 worktree를 만들지 않는다.

현재 저장소는 Astro/TypeScript 정적 앱·독립 계약 하네스·원본 staging·호환 어댑터를 포함한다. 공개 read model은 ADR-004의 관측 번호이며 검증 카탈로그 v1과 다르다. Cloudflare todayjpop 운영은 개인 원본 dev SHA6dbe5a65d1bd729c09393f746f715f4363089a43, npm run build→dist임을 API로 확인했다. 조직 앱의 미리보기와 기존 운영 전환을 구분한다. 기존 source 연결·도메인, 이력·ID·URL·저장 키를 보존한다. 기존 이력을 지우는 force push는 하지 않는다. 실제 preview/production 상태는 docs의 실행·릴리스 기록으로 확인한다.

## 실행과 범위

앱은 Node.js24 이상과 npm ci로 설치한다. npm test → npm run check → npm run build → npm run verify:dist → npm run test:e2e 순서다. 시스템 Chromium은 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH로 지정하고 CI는 설치한 Playwright Chromium을 쓴다. 실제 카탈로그 검증은 node scripts/validate-catalog.mjs <경로>, 후보 승격은 node scripts/promote-catalog.mjs <후보> <정상스냅샷>. 합성 fixture와 관측 read model을 v1 운영 파일로 승격하지 않는다. npm run deploy:preview는 clean HEAD와 같은 sourceSha의 artifact만 별도 jpoptoday-preview 프로젝트로 배포한다. 모든 preview noindex·광고 없음은 현재 구현 단계의 계약이며 production 전환과 혼동하지 않는다.

## 불변 조건

unknown과 unlisted를 구분한다. 번호 문자열·선행 0·안정 ID와 기존 URL/저장 데이터 호환성을 유지한다. 관측 번호는 raw staging에 보존하며 source/checkedAt를 만들어 v1을 통과시키지 않는다. 수집 실패·쓰기 실패·부분 결과가 마지막 정상 snapshot을 지우지 않게 한다. 근거 없는 난이도·음역·추천·가사·이미지 권리 상태를 생성하지 않는다. 공개 artifact는 검토된 데이터·콘텐츠만 포함한다.

각 작업은 Issue 또는 LOCAL ID, 스펙/ADR, 범위·담당·base/result SHA·검증·차단 사항을 남긴다. CI·preview·production SHA를 연결하고 복구를 확인한 후 위임 범위에서 배포한다. 문서 작성·검증·PR·병합·배포·AdSense 실제 심사 상태를 분리한다. 비밀 값·전체 환경·credential 파일은 출력하거나 커밋하지 않는다.

## 매일 운영

매일09시 Asia/Seoul에 관리자와 새 작업자3명을 구성하는 실제 Codex 예약을 등록했다. [일일 기준](https://github.com/jpop-today/docs/blob/main/operations/daily-development.md)에 따라 각 결과는 다른 두 담당이 파일·검증 근거로 평가하고, 관리자는 최저 품질 담당의 active roster 제외·interrupt·신규 spawn을 기록한다. 삭제 API가 없으므로 물리 삭제를 주장하지 않는다. Git·package·workflow와 최종 통합은 root 한 명이 수행한다.

오전 전일/계획과 완료 개선/차단은 reports/daily/YYYY-MM-DD.json 및 docs 일일 기록에 남긴다. GitHub Actions의 보고 cron은 AI 개발 예약과 별개다. DISCORD_WEBHOOK_URL은 Actions secret/안전한 binding으로만 입력하고 값은 어디에도 기록하지 않는다. missing secret은 skipped이며 sent가 아니다. 실제 전송은 Node24.5+ 송신기로 기존 proxy/CA를 유지한다. 사용자 승인 범위의 Discord 보고는 반복 확인 없이 진행한다.

기존 파랑·분홍 브랜드와 파스텔 그라데이션을 유지한다. 의미 있는 검증된 변경만 버전을 올리며 태그·GitHub release·preview·기존 jpop.today 운영·AdSense 승인 상태를 구분한다.
