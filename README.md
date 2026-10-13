# jpop.today

한국어로 JPOP 곡을 찾아 TJ·금영 노래방 번호를 확인하고 선곡을 준비하는 서비스.

[운영 사이트](https://jpop.today) · [스펙·설계·운영 문서](https://github.com/jpop-today/docs) · [조직 규칙](https://github.com/jpop-today/.github)

## 현재 단계

운영 기반과 독립 데이터 검증 하네스를 구성했다. 원본 kim75503/todayjpop은 연결 접근 오류(404)로 아직 전체 조사·이관하지 못했다. 이 저장소에는 현재 운영 앱과 실제 곡 카탈로그가 없다. Cloudflare 운영 프로젝트 연결은 앱 이관·빌드·미리보기 검증 뒤 진행한다.

## 검증

Node.js 22 이상. 외부 패키지 설치나 비밀 값이 필요 없다.

```sh
node --test
node scripts/validate-catalog.mjs path/to/catalog.json
```

첫 명령은 합성 픽스처로 계약을 검증한다. 두 번째는 실제 입력 카탈로그를 검증하며 오류·빈 카탈로그에서 종료 코드 1을 반환한다. fixtures의 번호는 실제 노래방 데이터가 아니다.

- [데이터 검증 계약](contracts/catalog.mjs)
- [스펙의 데이터 설명](https://github.com/jpop-today/docs/blob/main/data/catalog-contract.md)
- [환경 복구](https://github.com/jpop-today/docs/blob/main/operations/environment-recovery.md)
- [이관·배포 절차](https://github.com/jpop-today/docs/blob/main/operations/deployment.md)

원본 조사 후 안정 ID·URL·즐겨찾기를 보존하는 어댑터, 정적 곡 상세, 검색·선곡 UI를 차례로 구현한다.
