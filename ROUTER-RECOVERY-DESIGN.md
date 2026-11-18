# Strataa 호출 실패 복구와 Router Wave 설계

상태: 설계안. 런타임 변경·설치·배포는 하지 않았다.
대상: Strataa 4.11.3, source commit `e7fdf7814ef516ff07c7a1a9dee9300044848a35`.

## 1. 사용자 동작과 선택한 구조

Strataa가 소유한 Router·Brain/Solo·Worker·Reviewer 호출 또는 결과 전달이 실패하면, 공개 자료를 먼저 보존한다. 사용할 수 있는 Router가 실패 원인과 자료의 완전성을 분석한다. 상위 오케스트레이터는 ARIS에서는 Brain, 일반 작업에서는 Solo다.

Router의 결정은 `deliver`, `retry`, `escalate` 중 하나다. 자료는 결정과 관계없이 상위 세션에 전달한다. `deliver`는 호출 성공 판정이 아니라, 남은 자료로 계속할 수 있는지 상위가 확인하라는 뜻이다. `retry`도 남은 자료를 함께 전달하고 누락된 작업만 다시 수행한다.

Router는 분석만 하고 도구 실행·파일 수정·task 생성·모델 변경을 하지 않는다. native task 재호출은 기존대로 메인 세션만 수행하며, 런타임이 허용한 복구 요청만 통과시킨다. 설계 자체는 실제 재호출이나 추가 모델 과금을 실행하지 않는다.

### 비교한 대안

- Router가 실패를 받자마자 직접 task를 재호출: 빠르지만 실행 소유자가 둘이 되고 재귀 금지·중복 실행 방지·예산 검사가 분산된다. 제외한다.
- Router가 복구 결정을 만들고 메인이 실행: 분석과 실행 권한을 분리하면서 기존 native task 경로를 유지한다. 채택한다.
- 오류를 메인에게만 전달: 구조는 작지만 Router 분석과 복구 Wave 요구를 충족하지 않는다. 제외한다.

### 기본 복구 한도

논리 작업 하나당 자동 재시도는 1회, 즉 최초 시도 포함 최대 2회다. 실행 하나당 자동 복구 Router 판단은 최대 2회다. 이 수치는 측정 결과가 아니라 중복 작업과 과금 확대를 제한하는 초기 정책이다. 사용자가 지정한 더 작은 호출·비용·시간 한도가 우선한다. 한도 소진 시 추가 분석 호출 없이 자료와 중단 사유를 전달한다.

## 2. 현재 코드의 변경 근거

기준 저장소: `/home/yhmin/orca/workspaces/Agent-Workspace/omp-rebuild/workspace/Dialogue-Harness`.

| 현재 동작 | 소스 | 설계에 필요한 변경 |
| --- | --- | --- |
| Router·준비 오류는 곧바로 Flow 종료 | `controller.js:438-468` | 종료 전 복구 판단과 자료 보존 경로를 둔다. |
| 메인 모델 error/length는 즉시 종료 | `controller.js:549-559` | 대기 중인 복구 결과가 있으면 조기 종료하지 않는다. |
| 배치 도구 오류가 연결된 모든 row를 실패 처리 | `controller.js:733-743` | 항목별 성공은 보존하고, 실패가 확인된 시도만 복구한다. 미확인 항목은 unknown으로 남긴다. |
| 실패 async delivery에서는 본문을 읽지 않음 | `controller.js:629-645` | 실패 상태와 별개로 관측한 공개 본문·허용된 결과 참조를 수집한다. |
| 실패 결과에는 UNAVAILABLE와 재시도 금지 안내 | `controller.js:829-862` | 실패 증거를 보존하면서 구조화된 복구 결정을 함께 전달한다. |
| 실패한 단계의 새 task를 무조건 거부 | `waves.js:64-69,83-86` | 원래 실패를 지우지 않고, 해당 논리 작업의 1회용 재시도 허가만 인정한다. |
| 과거 실패 row 하나라도 있으면 최종 failed | `flow.js:331-345` | 시도 이력과 논리 작업 충족 상태를 구분해 집계한다. |
| Router는 하나의 `router` row, Wave 0 | `flow.js:39-46,68-84` | 복구 Router마다 새로운 실행 row와 인과관계를 만든다. |
| UI가 stage 의존성과 parentId로 선행 관계 추정 | `flow-view.js:42-107` | 복구 실행의 명시적인 predecessor IDs를 렌더링한다. |
| transport 실패에서 공개 부분 출력·HTTP 상태가 오류 객체에 구조적으로 남지 않음 | `transport.js:51-105,127-160` | 기존 실패 의미는 유지하되 정제한 부분 출력·관측 상태를 복구 입력에 보존한다. |

기존 계약은 실패를 성공으로 보거나 자식이 재귀 실행하는 것을 금지한다. 이 제약은 유지한다. 조사한 커밋 메시지만으로는 기존의 전면 재시도 금지 정책을 선택한 세부 논거까지 확인되지 않았다.

## 3. 실패·자료·재시도 계약

### 복구 입력과 결정

개념적 데이터 계약이며 구현된 타입 선언은 아니다.

```text
FailureRecord
  runId, sessionId, generation, incidentId
  logicalTaskId, attemptId, stageId, parentId
  phase: route | orchestrate | spawn | execute | retrieve
  launch: not-started | started | unknown
  kind: transient | auth | approval | unavailable-model | invalid-output
        | interrupted | evidence-rejected | unknown
  observedError: sanitized public message, HTTP status if actually observed
  evidence[]: id, source attempt, public text or artifact reference,
              complete/partial/unknown, verified/unverified/rejected
  effectState: none-confirmed | idempotent-confirmed | unknown

RecoveryDecision
  incidentId
  action: deliver | retry | escalate
  evidenceIds[]            # 입력 목록에 있는 ID만 허용
  missingWork              # 원래 목표의 미충족 부분
  reason                   # 짧은 공개 근거

RetryPermit (런타임만 생성)
  incidentId, logicalTaskId, previousAttemptId, nextAttemptId
  originalPacketDigest, same model and effort
  allowedRemainingWork, consumed
```

Router가 증거 내용, task ID, artifact 경로, 모델, 도구 권한, 실행 예산을 새로 만들어 넣을 수 없게 한다. 구조화된 응답을 경계에서 검사한다. 알 수 없는 action·다른 incident·등록되지 않은 evidence ID·잘못된 JSON은 `escalate`이며, 응답 수정을 위한 무한 LLM 재호출은 없다.

오류 본문과 부분 출력은 신뢰할 수 없는 데이터다. 시스템 지시로 삽입하지 않고, harness 태그·터미널 제어 문자·인증 정보를 제거한다. private thinking, 토큰, 임의 파일 내용을 복구 입력으로 보내지 않는다.

### 자료 보존과 전달

1. `tool_execution_end`, `tool_result`, async delivery, lifecycle 실패를 동일한 incident로 합친다. 동일한 task ID의 중복 알림은 Router를 다시 호출하지 않는다. preflight에서 job ID가 생성되지 않았으면 실제 toolCallId와 배치 항목 인덱스로 식별한다. 존재하지 않는 agent ID를 만들지 않는다.
2. 이미 관측한 공개 출력, 항목별 성공 결과, 동일 작업의 `agent://` 공개 결과와 기존에 허용된 산출물 참조를 보존한다. 경로를 문자열로 언급했다는 이유만으로 파일을 읽거나 신뢰하지 않는다. 원본 오류와 공개 본문을 별도 필드로 저장한다.
3. Router에는 정제된 오류, 목표, 결과 요약, 증거 목록과 완전성만 전달한다. 초기 입력 한도는 24,000자이며 초과 부분을 명시하고 전체 자료 참조는 남긴다. 전체 본문은 기존 공개 결과 경로에 보존한다. 예산 내에서 분석하지 못한 자료는 unverified로 남긴다.
4. 상위에는 실패 사유, 보존한 자료 또는 읽을 수 있는 정확한 참조, 미충족 작업, Router 판단, 재시도 허가 여부를 한 묶음으로 전달한다. 메인이 실행 중이면 tool result 또는 다음 턴의 evidence로 합치고 별도 동시 메인 턴을 시작하지 않는다.
5. 자료 전달 완료는 작업 완료가 아니다. 실패한 Reviewer의 부분 평가는 유효 검토 라운드가 아니며, Worker의 초안도 검증된 산출물로 자동 승격하지 않는다. 메인의 검증 결과·성공한 대체 시도·명시적인 범위 변경이 없는 한 해당 의존 단계는 잠긴다.

### 실패 종류별 처리

| 실패 조건 | 동작 |
| --- | --- |
| 429·일시적 5xx·연결 실패, 미실행 또는 중복 안전 확인 | Router가 retry를 선택하고 런타임 검사도 통과하면 동일 모델로 1회 재시도. 확인된 Retry-After와 남은 예산을 따른다. |
| 시간 초과, 종료 여부·외부 작업 상태 불명 | 자료를 전달하고 실행 생존·부작용부터 확인. timeout 자체를 재실행 허가로 보지 않는다. |
| 공개 자료는 있으나 출력 잘림·형식 오류·결과 회수 실패 | 먼저 deliver. 생성 task를 무조건 다시 돌리지 않고, 결과 회수/형식 복구 또는 누락 부분만 대상으로 한다. |
| 인증·모델 승인·모델 미지원·실제 모델 불일치 | 자료가 있으면 전달하되 권한·모델을 우회하거나 자동 교체하지 않는다. 설정 수정 전 동일 호출 재시도 금지. |
| 사용자 취소·세션 이동·새 실행·자동 복구 한도 소진 | 추가 호출 금지. 기록을 보존하고 해당 실행만 종료한다. |

자동 재실행의 안전성은 Router의 자연어 주장으로 승인하지 않는다. `not-started`는 호스트 preflight/수락 기록으로 확인하고, 읽기 전용은 실제 도구 권한으로, idempotent는 기존 실행 키·중복 제거 수단으로 확인한다. 일반 코딩 Worker는 파일 수정과 shell 부작용이 가능하므로 기본값은 unknown이다. 그러면 상위가 기존 산출물을 확인한 뒤 남은 범위를 명시해야 한다. 학습 제출·배포·결제·파일 덮어쓰기 등은 결과 불명 상태에서 전체 명령을 재전송하지 않는다.

기존 모델/effort·권한·단계별 parallel·전체 동시 작업 4개 제한을 재검사한다. 실행 중인 실패 시도가 남아 있으면 대체 시도를 허용하지 않는다. 한도는 호스트 내부 provider retry와 별도로 Strataa 논리 작업 재시도에 적용하며, 이미 관측 가능한 host 재시도도 기록한다.

### Router나 상위 자체가 실패하는 경우

- 초기 Router의 호출이 실패하면 부분 응답은 계획으로 실행하지 않는다. host가 재실행 안전을 확인한 일시 오류에 한해 동일 Router 호출 1회를 허용한다. 다시 실패하거나 설정 문제이면 기존 OMP 메인 문맥과 사용자에게 오류·부분 자료를 남기고 자동 작업은 시작하지 않는다.
- 복구 Router가 실패하면 또 다른 복구 Router를 만들지 않는다. 원래 오류, 보존 자료, Router 실패를 상위에 전달하고 중단한다.
- Brain/Solo 호출 실패는 이미 수행한 도구 작업을 재생하지 않는 새 continuation으로만 복구한다. continuation에도 기존 호출의 종료와 예산을 확인한다. 상위 모델 자체가 사용 불가하면 기록을 저장하고 사용자에게 노출한다. 도달하지 못한 상위에 전달했다고 표시하지 않는다.
- prompt-summary 같은 선택적 보조 호출 실패나 Worker 내부의 모든 shell nonzero를 독립 복구 대상으로 삼지 않는다. 전자는 기존 보조 실패 정책을 유지하고, 후자는 Worker가 처리한다. Worker 호출 자체가 종료 실패할 때 이 복구 경로를 적용한다.

### 실행 상태와 중복 방지

시도 상태는 단방향이다. `failed` 시도를 `running` 또는 `completed`로 되돌리지 않는다. 새 시도는 새 attemptId를 받고 `retryOf`로 이전 시도를 참조한다.

논리 작업에는 시도 목록과 별개로 `pending`, `recovering`, `satisfied`, `blocked` 상태를 둔다. `satisfied`에는 성공한 시도 또는 상위가 검증한 산출물 근거가 반드시 필요하다. Reviewer 완료 요구는 기존 검토 검증을 통과한 성공 시도로만 충족한다.

Flow는 복구가 진행 중이면 종료하지 않는다. 실패 기록이 있어도 모든 필수 논리 작업이 근거를 갖고 충족되면 `completed`가 가능하며, 별도 복구 건수와 원래 실패 카드는 유지한다. 자료를 전달했지만 미충족 범위가 남으면 `incomplete`, 복구 불가능한 필수 작업이면 `failed`다.

복구 coordinator는 메인 run 하나에 하나다. incident 예약 → Router 분석 → 결정 저장 → 메인 전달 → 재시도 허가 소비를 run 세대와 함께 관리한다. 느린 분석 중 stop/session switch가 발생하면 결과를 무시하고 어떤 호출도 추가하지 않는다. 독립 작업의 성공과 결과 수집은 복구 분석 중에도 계속된다.

재시도 허가는 dispatch 직전에 저장하고 한 번만 소비한다. 호스트 수락 여부가 불명확하면 새 요청으로 재전송하지 않는다. 호스트 작업 ID로 상태를 확인할 수 없으면 blocked다. 세션 복원은 기록만 복원하며 자동 재호출하지 않는다. 기존 세션 restore의 보수적 정책을 유지한다.

## 4. 추가 Router Wave 표시

기존 Wave 0의 초기 Router는 그대로 둔다. 실패 분석이 실제 시작될 때마다 별도 `router-recovery:<incidentId>` row를 추가한다. 계획 중인 복구를 실행 완료로 미리 표시하지 않는다.

`parentId`는 상위 오케스트레이터 소유 관계로 유지한다. 새 `predecessorIds`는 인과관계를 나타낸다. 실패 시도 → 복구 Router → 실제 메인 복구 턴 → 재시도 순서다. Router가 Worker의 자식 에이전트인 것처럼 표현하지 않는다.

Wave 번호는 이 확장 실행 DAG의 선행 노드 깊이로 계산한다. 원래 stage ID와 task 의존 조건은 바꾸지 않는다. 같은 깊이의 독립 실패 분석은 같은 Wave에 놓일 수 있다. 이미 실행한 노드의 번호는 유지하고, 아직 실행하지 않은 소비 단계는 복구 뒤의 실제 선행 노드 기준으로 배치한다. 전역 최대 Wave + 1을 붙여 무관한 작업까지 직렬화하지 않는다.

예시: Wave 2 Worker 실패 → Wave 3 Router 복구 분석 → Wave 4 Brain 복구 턴 → Wave 5 Worker 재시도. 자료만 전달하면 Wave 5는 생성하지 않는다. 메인이 복구 패킷을 아직 처리하지 않았으면 Wave 4는 예정 상태이며, 실제 턴을 관측해야 실행 카드로 인정한다. 직접 작업에서도 초기 Router Wave 0은 보인다.

복구 Router 카드에는 모델/effort, 대상 작업과 시도, 실패 분류, 보존 자료 수, deliver/retry/escalate, 공개 판단 근거, 시작/종료 상태를 표시한다. 상세 화면에서 원래 오류와 공개 자료 참조를 볼 수 있다. retry 카드에는 `attempt 2/2`와 원래 실패 카드 연결을 표시한다.

`/strataa flow`와 `/strataa watch`는 같은 snapshot 데이터를 사용한다. 저장 스키마는 v2로 올리고 명시적 v1 reader migration을 둔다. 과거 기록에 존재하지 않았던 recovery를 추정해서 추가하지 않는다. renderer의 이전 Wave 전체를 선행으로 취급하는 fallback은 v1에만 한정한다.

## 5. 구현 경계와 수용 기준

### 모듈 책임

| 파일 | 책임 |
| --- | --- |
| 새 `recovery.js` | incident 중복 제거, 증거 목록과 엄격한 Router 결정 검사, 복구 한도, 1회용 허가. 반환값은 관측 상태와 허용된 결정이며 직접 native task를 호출하지 않는다. |
| `controller.js` | 모든 실패 진입점 연결, 메인 run 소유권, 안전한 결과 전달·continuation, 취소와 session fence. 기존 UNAVAILABLE 경로를 대체해 이중 알림·이중 판단을 없앤다. |
| `transport.js`·`protocol.js` | 정제된 부분 응답/오류 메타데이터 보존, 설정된 Router로 도구 없는 복구 판단 호출. 성공 라우팅의 엄격한 JSON 계약은 유지한다. |
| `flow.js`·`waves.js` | 논리 작업과 attempt 이력, 재시도 허가 검사, 필수 작업 충족 집계, 인과 DAG. 과거 실패를 숨기거나 전면 retry 금지를 단순 삭제하지 않는다. |
| `flow-view.js`·`flow-store.js`·`saved-flow.js` | 복구 Wave·retry 관계 렌더링, snapshot v2 저장/검사, v1 기록 읽기. `flow-watch.js` 소비 경로도 새 snapshot 계약으로 확인한다. |

`recovery.js`의 외부 계약은 실패 관측과 허가 소비 두 동작으로 제한한다. 호출자는 세부 dedupe·budget 필드를 직접 수정하지 않는다. Flow 상태는 `flow.js`, 활성 run과 외부 호출은 `controller.js`가 소유한다. 서로 다른 모듈이 동일한 복구 상태를 각각 복제해 관리하지 않는다.

### 검증 시나리오

1. 자료 보존: Worker가 본문을 내고 실패하거나 async 회수에 실패해도 원본 오류와 partial 자료가 남고 상위에 한 번 전달된다. 부분 Reviewer 결과는 검토 성공으로 집계되지 않는다. 부분 성공 배치의 성공 작업은 재실행되지 않는다.
2. 안전한 재시도: 미실행 429는 허가된 동일 모델로 1회, 미확인 외부 작업·인증·승인·사용 불가 모델은 0회. 같은 incident가 세 종류의 이벤트로 도착해도 분석과 재호출은 중복되지 않는다. 한도 초과와 잘못된 Router JSON은 중단한다.
3. 실행 생명주기: 메인 agent_end가 분석보다 먼저 와도 복구가 유실되지 않는다. stop·새 요청·세션 이동 중 늦은 판단은 아무것도 실행하지 않는다. 복원/수락 불명 상태에서는 자동 재전송하지 않는다.
4. 의존성: 재시도 성공 후 해당 논리 작업의 소비 단계만 열린다. 자료 전달만으로 열리지 않는다. 원래 실패 이력은 남고, 독립 작업은 불필요하게 기다리지 않는다. 필수 검토와 모델 검증은 기존 조건을 유지한다.
5. 실제 UI: TUI를 띄워 Wave 0 → 실패 작업 → 추가 Router → 상위 복구 턴 → retry 흐름, 오류 상세, 작은 화면 탐색, 별도 watch의 일치 표시를 확인한다. v1 세션은 원래 기록대로 렌더링한다.

첫 구현 단위는 실패 자료 보존과 incident 중복 제거다. 그 다음 Router 판단·허가 경로, 논리 작업 집계, 추가 Wave UI 순서로 연결한다. 이 설계의 검증 목록은 아직 실행한 테스트 결과가 아니다.
