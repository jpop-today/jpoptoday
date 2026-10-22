# 공식 번호 승인 큐

`review-queue` workflow(Actions → review-queue → Run workflow)가 하루 50곡을 골라 TJ·금영 공식 번호 검색 결과를 모으고 `review: YYYY-MM-DD` PR을 엽니다.
곡 선정 순서는 "5곡 이상 가수가 확인곡 3곡에 가장 빨리 닿는 순서"입니다.

항목마다 `catalog`(관리 목록 표기)와 `official`(공식 검색 표기)을 비교해 `approve`를 채웁니다.

| match | 뜻 | 할 일 |
| --- | --- | --- |
| `exact` | 제목·가수가 같음. `reason` 초안이 채워져 있음 | 일괄 승인 가능(아래 `--approve-exact`) |
| `variant` | 표기 차이(ノ/の, 구두점, 부제 등) | 같은 곡이면 `approve: true`, `reason`에 차이를 한 문장으로 적기 |
| `mismatch` | 다른 곡으로 보임. `action`이 `suppress`로 제안됨 | 관측 번호가 틀렸으면 `approve: true` + `reason`, 판단이 어려우면 `false` |
| `error` | 조회 실패(결과 없음·여러 개 등) | 그대로 두기 |

승인한 뒤 ledger로 옮기기:

```sh
node scripts/promote-reviewed.mjs data/review-queue/YYYY-MM-DD.json --approve-exact
```

`--approve-exact`는 `approve: false`로 거절하지 않은 `exact` 항목을 모두 승인합니다. 빼면 `approve: true`인 항목만 옮깁니다.
같은 명령을 다시 실행해도 이미 옮긴 항목은 건너뜁니다. ledger 전체 검증에 실패하면 아무것도 바뀌지 않습니다.

promote는 그 `review/YYYY-MM-DD` 브랜치에서 실행해 큐와 ledger를 한 커밋으로 올린 뒤 PR을 병합합니다. 직접 실행하기 어려우면 Claude에게 "review PR 승인했어"라고 알려 주세요.
