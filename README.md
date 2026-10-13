# jpop.today

한국어로 JPOP 곡을 찾아 TJ·금영 노래방 번호를 비교하고 선곡을 준비하는 서비스.

[운영 사이트](https://jpop.today) · [제품 스펙·설계·운영 문서](https://github.com/jpop-today/docs) · [조직 규칙](https://github.com/jpop-today/.github)

## 현재 단계

이 저장소는 프레임워크 독립 데이터 계약, 원본 staging 및 ID/URL/저장 호환 어댑터다. 운영 앱과 실제 검증된 공개 카탈로그는 아직 이관되지 않았다.

개인 원본 `kim75503/todayjpop`은 2026-10-13 Git 읽기·별도 복사본 로컬 빌드 조사를 진행했다. 기본 `dev`와 `main`은 다른 이력·차트 스냅샷이며 실제 Cloudflare 운영 브랜치와 배포 SHA는 별도 확인이 필요하다. 이전 README의 원본 접근 오류 기록을 현재 상태로 갱신했다. [조사 결과](https://github.com/jpop-today/docs/blob/main/discovery/current-state.md), [이관 절차](https://github.com/jpop-today/docs/blob/main/operations/migration.md)를 따른다.

## 실행

Node.js 22 이상, 외부 패키지 설치·DB·비밀 값이 필요 없다.

```sh
npm test
npm run validate:catalog -- tests/fixtures/catalog.json
```

실제 후보를 검사하고 마지막 정상 파일을 교체할 때:

```sh
node scripts/validate-catalog.mjs /absolute/path/to/candidate.json
node scripts/promote-catalog.mjs /absolute/path/to/candidate.json /absolute/path/to/snapshot.json
```

출력 디렉터리는 미리 있어야 하며 입력과 출력은 다른 파일이어야 한다. 검증 실패·깨진 JSON·빈 입력·쓰기 실패·교체 실패에서 기존 snapshot을 보존한다. 원본 수집기에 아직 연결되지 않았고, 기존 snapshot의 ID가 빠지거나 확인된 제공사 상태가 unknown으로 사라지는 전체 수집 후보도 거부한다. 번호의 진위·최신성·증거의 실질은 별도 검토 대상이다. [하네스 범위](https://github.com/jpop-today/docs/blob/main/engineering/harness.md)를 확인한다.

합성 fixture의 곡·번호·출처는 운영 데이터가 아니다. 테스트 성공은 실제 데이터 출처 확인, 앱 빌드, 배포 또는 AdSense 승인과 구분한다.

## 기준

- [제품 스펙과 수용 기준](https://github.com/jpop-today/docs/blob/main/product/spec.md)
- [목표 아키텍처](https://github.com/jpop-today/docs/blob/main/architecture/overview.md)
- [DATA-001 계약](https://github.com/jpop-today/docs/blob/main/data/catalog-contract.md)
- [협업과 작업 인계](https://github.com/jpop-today/docs/blob/main/operations/collaboration.md)
- [배포·복구](https://github.com/jpop-today/docs/blob/main/operations/deployment.md)
- [작업 큐](https://github.com/jpop-today/docs/blob/main/operations/roadmap.md)

실행 코드는 이 저장소, 기준 문서는 docs, 조직 공통 규칙은 .github에 둔다. 새 UI·정적 상세·ID 어댑터·검토된 데이터는 스펙/ADR를 연결한 후속 구현으로 진행한다. 기존 조직 이력을 지우거나 새 앱 검증 전 운영 사이트를 대체하지 않는다.

## 원본 이관과 호환 어댑터

운영 Cloudflare project는 todayjpop, 개인 원본의 dev SHA6dbe5a65d1bd729c09393f746f715f4363089a43이다. 현재 source 연결·도메인은 변경하지 않았다. 토큰/Account ID 값은 환경 binding에서 읽고 출력하지 않는다.

```sh
npm run inspect:cloudflare -- --project todayjpop
node scripts/import-legacy-staging.mjs /path/to/original-checkout 6dbe5a65d1bd729c09393f746f715f4363089a43 data/legacy-identity-baseline.json data/staging/legacy-catalog.json --check
```

`--check`는 고정 원본 Git 객체와 완성된 기준선으로 재생성한 바이트가 같은지 확인한다. 일반 `npm test`는 외부 원본 checkout 없이 committed staging·ID 기준선도 검사한다. staging의3,317개는 등록3,299·현재차트전용14·이전차트보존4개이며 번호는 `observed-unverified` 또는 `unknown`이다. 가사·이미지·광고·번호 확인일은 복제/생성하지 않았다. 이것은 v1 공개 카탈로그 검증·앱 이관·배포 완료와 다르다.

`contracts/legacy-compatibility.mjs`는 Node 의존성이 없는 브라우저 모듈이다. ID resolver와 옛 URL 변환, 기존 storage key를 읽는 즐겨찾기/최근 필터 어댑터를 제공한다. 읽기에는 쓰기가 없고 명시 migration은 원본 backup 이후 진행한다. 저장 실패는 session 상태와 진단을 반환하므로 앱에서 직전 session 결과를 이어 전달해야 한다. 실제 공개 화면 연결은 후속 앱 구현이다.

[호환성 실행 계약](https://github.com/jpop-today/docs/blob/main/engineering/legacy-compatibility.md) · [Cloudflare 실제 기준선](https://github.com/jpop-today/docs/blob/main/operations/cloudflare-baseline.md)
