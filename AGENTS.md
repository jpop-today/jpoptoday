# jpop.today 소스 작업

사용자는 스펙·재설계·수정·검증·통합·배포를 위임했다. 일상 작업에 같은 승인을 반복 요청하지 않는다. 기준은 https://github.com/jpop-today/docs 의 product/spec.md와 관련 ADR, 조직 규칙은 https://github.com/jpop-today/.github 의 AGENTS.md·CONTRIBUTING.md다. 공유 워크스페이스에서는 파일 범위·base SHA·담당을 공유하고 git 작업은 통합 담당자 한 명이 수행한다. 클라우드 기존 체크아웃을 사용하며 명시 요청 없이 worktree를 만들지 않는다.

현재 저장소는 독립 계약 하네스 단계다. 원본 kim75503/todayjpop의 dev/main 조사와 복사본 빌드가 가능해졌지만 운영 앱·실제 공개 데이터는 아직 이관되지 않았다. source SHA, 이력·라이선스·배포, 기존 곡 ID·URL·저장 키를 조사·보존한다. 기존 이력을 지우는 force push는 하지 않는다. 현재 동작을 검증한 증거 없이 기존 운영 사이트를 대체했다고 주장하지 않는다.

## 실행과 범위

Node.js >=22에서 npm test. 실제 카탈로그 검증은 node scripts/validate-catalog.mjs <경로>, 후보 승격은 node scripts/promote-catalog.mjs <후보> <정상스냅샷>. 출력 디렉터리는 기존 경로를 사용하고 합성 fixture는 운영 파일에 승격하지 않는다. 사이트 빌드·타입·브라우저·배포 검증은 해당 앱이 이관·구현된 뒤 별도 실행한다.

## 불변 조건

unknown과 unlisted를 구분한다. 번호 문자열·선행 0·안정 ID와 기존 URL/저장 데이터 호환성을 유지한다. 관측 번호는 raw staging에 보존하며 source/checkedAt를 만들어 v1을 통과시키지 않는다. 수집 실패·쓰기 실패·부분 결과가 마지막 정상 snapshot을 지우지 않게 한다. 근거 없는 난이도·음역·추천·가사·이미지 권리 상태를 생성하지 않는다. 공개 artifact는 검토된 데이터·콘텐츠만 포함한다.

각 작업은 Issue 또는 LOCAL ID, 스펙/ADR, 범위·담당·base/result SHA·검증·차단 사항을 남긴다. CI·preview·production SHA를 연결하고 복구를 확인한 후 위임 범위에서 배포한다. 문서 작성·검증·PR·병합·배포·AdSense 실제 심사 상태를 분리한다. 비밀 값·전체 환경·credential 파일은 출력하거나 커밋하지 않는다.
