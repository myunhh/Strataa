# Strataa — Project Research Workspace & OMP Harness

**에이전트가 프로젝트 근거·Top-down·BuildUp을 기록하고, 사람은 디렉터리를 연결해 요약과 다음 행동을 확인합니다.**

[ARIS](https://github.com/wanshuiyin/auto-claude-code-research-in-sleep)의 원본 스킬 87개를 OMP의 native 에이전트·도구·대화 UI에 연결하는 독립 플러그인입니다. **Router → Brain → Worker + 별도 세션 Reviewer → Brain 최종 종합**으로 연구 작업을 실행하고, 일반 작업은 Solo가 주도합니다. Router가 경로와 **단계별 종속성·목표·병렬도**를 결정하고, 같은 의존 깊이의 독립 단계들을 하나의 실행 Wave로 묶습니다. 모든 역할은 OMP 전체 모델 목록에서 선택하며 기존 조합을 추천 기본값으로 제공합니다. OMP 본체·공통 하네스·전역 기본값·인증·재귀 설정은 변경하지 않습니다.

- 저장소: [myunhh/Strataa](https://github.com/myunhh/Strataa)
- 플러그인 ID: `omp-agent-strataa` · 명령: `/strataa`
- 기반 프로젝트: ARIS 원본 스킬·보조 파일을 고정 commit으로 포함하며, 원본 MIT 라이선스는 [`ARIS-LICENSE`](ARIS-LICENSE)에 보존합니다. ARIS·OMP 공식 배포판과는 별개의 적용판입니다.

## 설치와 사용

Node.js 22.13 이상, OMP 18.15.0 이상이 필요합니다.

```sh
git clone https://github.com/myunhh/Strataa.git
cd Strataa
node install.mjs
```

**Dialogue에서 전환:** 새 설치가 성공한 뒤 `omp plugin uninstall omp-agent-dialogue`로 이전 플러그인 등록만 제거하세요. 이전 불변 설치본·연구 DB·세션 기록은 삭제하지 않습니다. 실행 중인 OMP 작업에는 reload를 보내지 말고 작업이 끝난 뒤 아래 명령을 실행하세요.

제품명은 Strataa, 명령은 `/strataa`로 전환하며 이전 명령 별칭은 제공하지 않습니다. 환경 변수도 `STRATAA_*`와 `OMP_STRATAA_FLOW_DIR`로 바뀝니다. 기존 데이터 경로와 세션 직렬화 ID는 유지합니다.

현재 OMP에서 진행 중인 작업을 마친 뒤:

```text
/reload-plugins
/strataa skills
/strataa models
/strataa on
```

- `/strataa skills`: 설치된 ARIS 스킬 87개, 원본 commit, 설치 경로와 모델·native task 준비 상태.
- `/strataa models`: **전체 역할에 같은 모델 / 역할별 선택 / 추천 기본 조합 복원**. 모델과 지원 추론 강도를 선택하며 취소하면 저장하지 않습니다.
- `/strataa models all <provider/model> [effort]`: 일곱 역할을 한 모델로 설정. 강도 생략 시 `auto`.
- `/strataa models default`: 기존 추천 조합 복원.
- `/strataa <router|brain|worker|reviewer|solo|summary|analysis> [provider/model] [effort]`: 역할별 변경. 모델 인자를 생략하면 선택창.
- `/strataa status`: 현재 모드·모델·설치 상태.
- `/strataa flow`: Wave 카드 그래프를 전체 화면으로 열고, 노드별 모델·native 작업 ID·작업 지시·공개 결과 원문을 확인.
- `/strataa watch`: 이 호스트의 여러 OMP 세션을 별도 터미널에서 실시간 추적하고, 요청 요약과 완료된 flow를 함께 표시.
- `/strataa stop`: 진행 중인 라우팅 또는 확장이 시작한 실행 중단.
- `/strataa off`: 다음 요청부터 자동 라우팅 해제. 이미 시작한 실행과 현재 모델은 유지.

새 세션은 기본 OFF입니다. 모델 선택은 `${XDG_CONFIG_HOME:-~/.config}/strataa/models.json`에 저장하며 같은 호스트의 새 Strataa 세션과 Dashboard가 공유합니다. 실행 시작 시 모델·강도를 고정하므로 변경은 **다음 요청/분석부터** 적용됩니다. 공유 파일이 없을 때만 구버전 세션 상태 v1–4의 모델을 역할별로 복원하며 ON/OFF와 과거 Flow는 유지합니다. 잘못된 공유 파일은 조용히 기본값으로 대체하지 않습니다. `/strataa models default`로 복구할 수 있습니다.

예시:

> ARIS research-review로 이 연구 초안을 검토해 줘. 먼저 한 라운드만 진행하고, 수용한 지적·반박·남은 이견을 구분해 줘.

> ARIS experiment-plan으로 이 가설을 구분할 실험을 설계해 줘. 실제 실험은 실행하지 마.

스킬 이름을 지정할 필요는 없습니다. `/strataa on` 상태에서 평소처럼 작업을 요청하면 Router가 내용과 최근 대화를 보고 선택합니다. 실험 실행·학습·평가·seed/config 배치·의존 작업 큐·밤샘 자율 개선은 명령이 단순해도 ARIS로 보냅니다. “그거 밤새 돌려줘” 같은 후속 요청도 앞선 작업을 이어받습니다.

| 요청 의도 | 기본 선택 |
| --- | --- |
| 지정된 실험·학습 실행 | `run-experiment` |
| 여러 seed/config, 의존 단계·작업 큐 | `experiment-queue` |
| 이미 실행 중인 작업 관찰 | `monitor-experiment` |
| 기존 연구를 검토·수정·재검토하며 자율 개선 | `auto-review-loop` |
| 아이디어 탐색부터 실험·검토까지 전체 자율 연구 | `research-pipeline` |

계획만 요청하면 실행 스킬을 선택하지 않습니다. 파일명·설명에 “실험”, “overnight”가 있다는 이유만으로 일반 코드 수정이나 설정 변경을 실험 실행으로 취급하지 않습니다. 환경 정보가 부족해도 ARIS 경로를 유지하며 실행자가 프로젝트의 실제 자원·권한·필수 입력을 확인합니다. 요청한 시간·라운드·비용 한도와 스킬의 종료 조건을 따르며, 밤샘 요청을 무한 반복이나 새 유료 자원 임대로 해석하지 않습니다.

OMP의 개별 스킬 slash command를 직접 실행하면 Strataa 입력 라우팅을 거치지 않으므로 아래 OMP 리뷰어 변환 계약이 자동 적용되는 경로와 구분해야 합니다.

## 실행 계약

1. **설치 검사:** `/strataa on`과 활성 입력에서 원본 스킬·공통 참조·도구·템플릿의 누락·잘림·실행 권한 손실을 확인합니다. 불완전하면 모델 호출 전에 차단합니다. 설치 파일 검사는 외부 서비스 인증이나 Python 의존성 검사가 아닙니다.
2. **Router 라우팅·Wave 설계:** 선택한 Router 모델·강도로 일반 작업 또는 ARIS 스킬 1–4개와 종속성 그래프를 선택합니다. 필수 JSON `waves`의 각 단계에는 ID·제목·목표·동시 작업 수(1–4)·`dependsOn` 단계 ID 목록을 담습니다. 빈 목록은 선행 단계 없음입니다. 런타임이 의존 깊이로 실제 Wave 번호를 계산하며, 누락·미등록·중복·자기 참조·순환 종속성은 실행 전에 거부합니다. 위임이 불필요하면 `[]`, 필요하면 최대 12단계입니다. 기존 ARIS 라우팅과 권한은 유지합니다.
3. **스킬 적용과 Brain:** 선택된 `SKILL.md` 원문 전체와 설치 경로를 로드하고, OMP 적용 계약을 뒤에 붙여 **사용자 요청 전달 전에** 제공합니다. 일반 작업은 Solo, ARIS 작업은 Brain을 실제 세션 모델로 선택합니다. Brain이 분석·아이디어 발산·가정과 판단 기준·작업 계획·최종 종합을 맡습니다. 분석·계획만 요청하면 Worker를 강제 호출하지 않습니다.
4. **실행과 별도 세션 검토:** 구체 실행은 native `task`의 `aris-worker`에 목표·파일·인터페이스·사용자 제약·완료 검사로 한정한 작업 패킷을 전달합니다. 원본 스킬의 전용 리뷰 호출은 native `aris-reviewer`로 바꾸며 각 역할의 선택 모델·강도를 고정합니다. 다른 native task도 Worker 모델을 사용합니다. 검토자는 `read`, `grep`, `glob`만 사용하고 원본 파일·중립 브리프를 직접 읽습니다. Worker는 재위임·검토·연구 주장 채택을 하지 않으며, Brain이 검토를 직접 요청하고 최종 답변을 작성합니다. **같은 모델의 별도 세션 검토는 교차 모델 검증이 아닙니다.**
5. **라운드 연속성:** native task는 새 스레드입니다. 이후 라운드에는 **같은 Router 단계 ID**의 검증된 이전 검토 출력 전체만 자동 첨부하며, 독립적인 병렬 검토 단계의 이력은 섞지 않습니다. 실행자가 근거 있는 응답과 변경 사항을 제공합니다. 원본 MCP threadId 재사용과 동일하다고 주장하지 않습니다. 라운드 수는 스킬과 사용자 범위를 따릅니다.
6. **완료 근거:** 실제 완료 결과, 일치하는 host 모델 메타데이터, 비어 있지 않은 공개 출력이 있어야 검토 라운드로 인정합니다. 직접 task 결과와 wait의 `resultText`, OMP의 `async-result` 자동 전달을 처리합니다. 자동 전달은 현재 실행에서 관측한 작업 ID·모델에 연결하고 같은 `agent://`의 게시된 최종 출력을 읽습니다. 긴 결과의 `<preview full-output="agent://…">`도 같은 작업의 원문 전체를 읽어 현재 Brain과 다음 검토 라운드에 전달합니다. 원문 수신 중에는 실행 중 상태를 유지합니다. 모델 불일치·빈 검토·읽기 실패·다른 원문은 실패이며 자동 재시도하지 않습니다. 상태만 있는 완료 알림은 결과를 대신하지 못합니다. 필요한 리뷰가 없으면 `incomplete`, 호출한 Worker나 리뷰가 실패하면 flow도 `failed`입니다.
7. **권한과 의미:** 스킬 선택은 무인 실행·실험·학습·설치·배포에 대한 추가 승인이 아닙니다. 사용자 요청과 프로젝트 권한을 유지합니다. 검토 완료는 주장 수용·과학적 입증이 아니며, 이견을 강제로 합의로 바꾸지 않습니다.

### Wave 실행 규칙

1. **Wave 0=Router, Wave 1=메인 조정자, Wave 2부터=의존 깊이별 실행 묶음.** 독립적인 `InspectCode`와 `InspectData`는 둘 다 `dependsOn: []`로 Wave 2에서 함께 실행합니다. 둘의 결과를 쓰는 `Check`는 `dependsOn: ["InspectCode", "InspectData"]`로 Wave 3에 놓입니다. 배열 순서나 모델 이름이 종속성을 대신하지 않습니다.
2. 메인이 준비된 독립 작업들을 native `task`의 한 `tasks[]` 배치로 호출합니다. 다른 단계 ID·모델도 같은 배치에 들어갈 수 있습니다. 작업 이름은 `<단계 ID>__<작업명>`(총 32자 이하)이며, 접두사 생략은 준비된 단계가 하나뿐일 때만 허용됩니다. 이름을 생략하면 확장이 충돌 없는 이름을 예약합니다.
3. 소비 작업은 선언된 선행 단계의 모든 작업이 성공하고 공개 결과 전문을 받은 뒤에만 시작합니다. 상태 알림만으로는 열리지 않으며, 무관한 실행 중 단계까지 기다리지는 않습니다. 선행 단계를 다시 실행하면서 그 결과를 소비하는 작업을 같은 배치에 넣을 수 없습니다.
4. 단계별 `parallel`과 실행 전체 동시 최대 **4개**를 적용합니다. 이름·슬롯은 배치 전체 검증 뒤 한 번에 예약합니다. 소비 단계가 시작되면 선행 단계는 닫힙니다. 실패·취소한 단계를 자동 재시도하거나 그 결과를 성공으로 넘기지 않습니다. 모든 계획 단계의 실제 성공 결과가 있어야 완료됩니다.
5. 같은 파일 수정, 공유 자원 충돌, 변경 중인 산출물 검토는 독립 작업이 아닙니다. Router는 종속성으로 분리하고 메인은 실제 입력·파일을 확인합니다. ARIS 역할·선택 모델·별도 세션 검토를 유지하며, 자식 재위임·`eval agent()`/`workpool` 우회·재귀 설정 변경은 금지합니다. 계획은 추가 비용·설치·배포·수정 권한이 아닙니다.


### 전체 모델 선택과 추천 기본 조합

```text
/strataa models all openai-codex/gpt-6-astra high
/strataa reviewer openai-codex/gpt-6-astra max
/strataa models default
```

첫 명령은 **라우팅·Brain·Worker·Reviewer·Solo·요청 요약·Dashboard 분석까지 전부 Astra/high**로 설정합니다. 두 번째는 Reviewer만 max로 변경하며, 마지막 명령은 아래 추천 조합을 복원합니다. 모델 계열 제한 없이 현재 호스트가 제공하는 전체 목록을 사용합니다.

| 역할 | 추천 기본 selector | 추론 강도 |
| --- | --- | --- |
| Router | `openai-codex/gpt-6.1-terra` | `xhigh` |
| Brain | `anthropic/claude-fable-5-2` | `high` |
| Worker | `anthropic/claude-opus-5-5` | `medium` |
| Reviewer / Solo | `openai-codex/gpt-6-astra` | `max` |
| 요청 요약 | `openai-codex/gpt-6-luna` | `low` |
| Dashboard 분석 | `openai-codex/gpt-6-astra` | `high` |

`auto`는 모델/호스트의 자동 추론 설정이며, 비추론 모델에도 사용할 수 있습니다. 명시 강도를 지원하지 않거나 선택 모델을 사용할 수 없으면 자동 대체하지 않습니다. 추천 조합은 이전 기본값의 보존이지 모델 간 우열의 검증이 아닙니다. 과거 `/strataa fable|opus|astra` 설정 명령 대신 역할 이름을 사용하세요.

설정은 **호스트별 Strataa 전용**입니다. aica-1에는 코드 설치와 별개로 원하는 프로필을 선택해야 합니다. Router·Worker·Reviewer·요청 요약에는 추가 모델 사용량이 발생하며 모두 큰 모델로 선택하면 요약 비용도 함께 바뀝니다. 라우팅에는 최근 텍스트 최대 24,000자와 요청·이미지가 전달됩니다. 선택한 공급자의 데이터 보존 조건을 확인하세요.

취소·세션 이동 시 늦게 도착한 결과로 새 작업을 실행하지 않습니다. 같은 세션의 compaction은 진행 중인 native 검토 추적을 보존합니다. 시각화는 UI 전용이며 추가 모델 응답을 만들지 않습니다. 이전 Flow의 모델 표시는 당시 기록 그대로 유지합니다.

## 프로젝트 디렉터리 연결

1. 기존 프로젝트에서 에이전트에게 **“strataa-project 스킬로 이 프로젝트의 기존 문서·코드·공개 실험 결과를 분석해 `.strataa/project.json`을 만들어 줘. Top-down과 BuildUp을 근거에 연결하고 모르는 내용은 비워 둬.”**라고 요청합니다. Strataa 프로젝트가 아니어도 같은 스킬을 사용할 수 있습니다.
2. 설치한 Strataa 폴더에서 `npm run dashboard`로 실행하고 **http://127.0.0.1:4310**을 엽니다.
3. 프로젝트의 절대 경로 또는 `~/…`를 입력해 연결합니다. 전체 요약·다음 행동·근거 누락부터 보고, Top-down·BuildUp·출처를 필요할 때 펼칩니다. 화면이 보이는 동안 5초마다 기록을 다시 읽습니다.

### 기록하는 쪽 / 읽는 쪽

- **작업 에이전트:** [`strataa-project`](skills/strataa-project/SKILL.md)로 기존 자료를 의미 분석하고 기록합니다. 이후 실제 결정·관측이 바뀔 때 같은 ID를 유지하며 갱신합니다. 사람이 논문마다 필드를 입력할 필요가 없습니다. 스킬을 쓰는 에이전트의 통상 모델 사용량은 발생합니다.
- **Dashboard:** 명시한 파일의 인용·ID·계층·참조를 로컬 검증하고 구조화된 기록을 표시합니다. 연결·새로고침은 LLM 호출이나 과금을 하지 않습니다. 기록이 없는 디렉터리를 임의로 전부 스캔하거나 내용을 추측하지 않습니다.
- **Strataa 자동 유지:** 프로젝트 루트의 `.strataa/project.json`이 있으면 Solo와 Brain handoff에 bundled 기록 스킬을 추가합니다. 읽기 전용 요청에서는 수정하지 않고 메인 에이전트가 기록을 통합합니다. 존재하지 않는 프로젝트에는 자동 기록을 강제하지 않습니다. 다른 호스트에서는 스킬을 명시적으로 적용하세요.

계약은 `.strataa/project.json`의 `schemaVersion: 1`, `project`, `sources`, `concepts`, `buildUps`입니다. 정확한 필드와 예시는 [스킬](skills/strataa-project/SKILL.md)과 [예제](skills/strataa-project/example.json)에 있습니다. 개념은 분야→문제→방법→기법, BuildUp은 질문·가설·결정·실험·결과를 부모와 근거에 연결합니다. **accepted는 기록된 선택이지 과학적 검증 통과가 아닙니다.** 불확실한 과거 의도·미실행 실험·비공개 추론을 만들어 쓰지 않습니다.

일반 프로젝트의 다른 에이전트에도 쓰려면 `skills/strataa-project/`를 해당 프로젝트의 `.agents/skills/strataa-project/` 또는 해당 호스트가 지원하는 스킬 경로에 복사하고 스킬 이름을 지정하세요. 전역 지침이나 모델 설정을 자동 변경하지 않습니다.

### 보안·저장·기존 서재

서버는 loopback 전용이며 다른 Origin/Host의 쓰기를 거부합니다. 연결 목록만 `STRATAA_RESEARCH_DIR`(기본 `${XDG_DATA_HOME:-~/.local/share}/omp-agent-dialogue/research`)에 저장하고 프로젝트 파일은 읽기 전용입니다. 연결 해제는 프로젝트 파일이나 논문을 삭제하지 않습니다. manifest 2 MiB, 출처별 2 MiB, 출처 총합 20 MiB 한도를 적용하고 심볼릭 링크·프로젝트 밖 경로·비밀 파일을 거부합니다. 일반 문서에 적힌 비밀 값까지 자동 판별하지는 못하므로 기록 전 제거하세요. 잘못된 갱신은 명시적으로 오류를 표시하며 이전 자료를 최신이라고 속이지 않습니다.

기존 논문 DB는 그대로 **[/library](http://127.0.0.1:4310/library)**에서 엽니다. PDF/text 업로드, 고정 소형 모델 `openai-codex/gpt-6-luna`/low 메타데이터 채우기, 명시적 전체 분석·내보내기를 유지합니다. 메타데이터는 PDF 앞 2쪽·최대 16,000자를 외부 모델에 전송하므로 끄기 옵션과 과금 안내를 확인하세요. 전체 분석은 공유 analysis 역할을 사용하며 별도 동의가 필요합니다. PDF 추출은 로컬 `pdftotext`; URL 자동 수집·OCR은 하지 않습니다.

환경 변수: `STRATAA_DASHBOARD_PORT`(4310), `STRATAA_RESEARCH_DIR`, `OMP_BIN`, `OMP_STRATAA_FLOW_DIR`. 저장소당 서버 하나를 실행하세요. 설치 후 작업이 끝난 OMP에서 `/reload-plugins`하면 `/strataa-project`를 사용할 수 있습니다. `node install.mjs`는 Dashboard와 자체 스킬을 배포하되 vendored ARIS 87개 원본은 바꾸지 않습니다.

## Agent Flow 그래프

- 입력창 위에는 **같은 의존 깊이의 작업 카드와 실제 선행 관계**를 표시합니다. 독립 단계의 모델은 같은 Wave 열에 나란히 놓이며 Wave는 재귀 깊이가 아닙니다. 인접 열의 종속성은 연결선으로, 전체 선행 단계 목록은 상세 화면으로 확인합니다. 실제 부모 ID와 위임 깊이도 별도로 보존합니다.
- 새 실행에서는 메인이 native `task`로 준비된 작업을 배치 호출합니다. 일반 에이전트의 자동 완료·게시된 결과를 추적하며 다른 실행의 이벤트는 섞지 않습니다. 종속성 필드가 없는 이전 순차 계획과 Wave 계획 자체가 없는 깊이 기반 기록은 당시 의미를 유지합니다.
- 카드에는 작업 이름·역할·모델·상태·관측 경과 시간·공개 요약을 표시합니다. 노드가 많으면 **카드 → 압축 카드 → 한 줄**로 밀도를 조절합니다. 같은 Wave에서 일부 단계만 시작했어도 나머지 단계의 `예정` 카드는 남으며 실제 완료 집계에 넣지 않습니다.
- **`/strataa flow` → 방향키/Tab으로 노드 선택 → Enter로 상세보기.** `←→`는 Wave, `↑↓`는 같은 Wave를 이동합니다. `PgUp/PgDn`은 화면 밖 노드로 페이지 이동하고 `Home/End`는 첫/마지막 노드로 이동합니다. 좁은 터미널은 전체 노드 목록을 사용합니다. 화면에 다 담지 못하면 현재 범위와 숨은 수를 표시하며, 모든 노드는 이동·상세보기가 가능합니다. 입력창 위 위젯은 높이를 제한합니다.
- 상세 화면에는 정확한 모델, 작업 ID, 부모 관계, 관측 시각, 공유 문맥·작업 지시, 공개 출력·오류 전문을 표시합니다. `↑↓`·`PgUp/PgDn`으로 스크롤하고 `Home/End`로 처음/끝을 봅니다. `Tab`은 다음 노드, `Enter`는 게시된 native 출력 다시 읽기, `Esc`는 카드로 복귀, `q`는 화면 닫기입니다. **화면을 닫아도 실행은 계속됩니다.**
- 실행 이벤트가 오면 열린 그래프와 상세 화면도 갱신합니다. 공개 텍스트만 저장하고 private thinking·도구 호출 본문은 표시하지 않습니다. 이전 기록에 없는 작업·원문·시각은 만들어 내지 않으며, 알려진 작업 ID의 게시된 출력은 필요할 때 읽습니다. 시간은 호스트가 관측한 구간이며 실제 작업의 내부 실행 시간을 보증하지 않습니다. 시각화·원문 읽기는 모델을 호출하지 않습니다.

## 여러 세션을 한 화면에서 보기

추가 터미널에서 `omp`를 열고 다음 명령을 실행합니다. 이미 열어 둔 **watcher만** `/reload-plugins` 후 다시 열면 됩니다. Linux에서는 실행 중인 작업 세션을 reload하거나 재시작하지 않아도 기존 저장 기록을 읽습니다.

```text
/strataa watch
```

- watcher는 `/strataa on`, 자체 flow, 모델 호출 없이 열 수 있습니다. 같은 OS 사용자·호스트에서 실행 중인 메인 세션들의 작업 공간·세션 ID·요청 요약을 표시합니다. **세션을 선택하거나 `Enter`를 누르지 않아도 기본 화면에 노드·연결선 그래프가 바로 보이며**, 약 0.5초마다 갱신합니다. 화면 크기에 맞춰 카드·축약 노드로 표시하고, 숨겨진 노드 수와 페이지 범위를 명시합니다.
- Linux에서는 같은 사용자의 실제 `omp` 프로세스가 열어 둔 세션 파일을 찾아, 구버전 세션도 **`저장 기록`**으로 표시합니다. 자식 세션과 닫힌 과거 기록은 제외합니다. 저장된 공개 Flow가 없으면 **`Flow 미관측`**과 원본 입력만 보여주며 실행 상태·노드·위임 관계는 추정하지 않습니다. `Enter`로 원문 전체를 확인할 수 있습니다.
- 저장 기록은 비동기로 읽고 파일 변화만 추가 반영합니다. 큰 파일은 끝에서 최신 Flow를 찾으며, Flow가 전혀 없는 세션은 최초 연결 시 기록을 한 번 탐색하므로 표시가 늦을 수 있습니다. 기존 세션에 요약 모델을 소급 호출하지 않습니다. Linux 이외 환경은 새 플러그인이 게시한 공유 스냅샷만 사용합니다.
- **완료된 flow는 해당 OMP 프로세스가 살아 있는 동안 시간 제한 없이 유지합니다.** 그 세션의 다음 라우팅 요청이 시작되면 교체하며, 다른 세션의 flow는 유지합니다. 종료된 프로세스는 목록에서 빠지고, 세션 이동 시 새로 선택한 세션의 기록으로 바뀝니다. 과거 세션 전체를 나열하는 기록 뷰어는 아닙니다.
- `↑↓←→`/`Tab`으로 세션 선택, `PgUp/PgDn`으로 페이지 이동, `Home/End`로 처음/끝, `Enter`로 전체 Flow·출력 상세 화면을 엽니다. 선택은 상세 대상을 바꿀 뿐 기본 그래프 표시 조건이 아닙니다. `Esc`는 세션 목록, `q`/`Ctrl-C`는 watcher만 닫습니다. 원래 실행은 중단하지 않습니다.
- 새 라우팅 요청마다 **선택한 요청 요약 모델(기본 `openai-codex/gpt-6-luna` · `low`)로 입력 요청을 한 번 요약**합니다. 라우팅과 별도로 실행하고, 생성한 한 줄을 모든 watcher가 공유합니다. watcher를 열거나 새로 고쳐도 추가 호출하지 않습니다. watcher가 없어도 새 요청당 요약 모델 호출 1회가 추가됩니다.
- 요약에는 원래 입력 텍스트와 이미지 개수만 보내며 이미지 내용·주변 대화·private thinking은 보내지 않습니다. 요약은 요청 식별용이며 실행 결과가 아닙니다. 대기·실패 시에는 상태와 원문을 표시하고, 실패해도 본 작업은 계속합니다. 자동 재시도나 다른 모델 대체는 없습니다.
- **원본 입력 전체는 상세 화면의 `원본 사용자 요청`에서 확인**합니다. 기존 저장 flow를 복원할 때는 요약을 새로 호출하지 않습니다. 다른 프로세스의 `agent://`는 조회하지 않고 저장된 공개 출력만 표시합니다.
- 공유 스냅샷은 `${XDG_STATE_HOME:-~/.local/state}/omp-agent-dialogue/flows/`에 사용자 전용 디렉터리·파일 권한으로 원자적으로 기록합니다. `OMP_STRATAA_FLOW_DIR`를 지정하면 **그 디렉터리의 게시 스냅샷만** 읽도록 격리하며, producer와 watcher에 같은 경로를 설정해야 합니다. 이 경우 기존 프로세스의 세션 파일 자동 탐색은 하지 않습니다. 네트워크 포트·인증 설정·OMP 본체·공통 하네스는 변경하지 않습니다.


## 설치 내용과 원본

- 원본: `wanshuiyin/auto-claude-code-research-in-sleep`
- 고정 commit: `2927b40b2ea37774de53763338c5e8f91a7601e6`
- `skills/`: 기본 스킬 87개와 `shared-references/`. Codex별 중복·legacy overlay는 제외.
- `tools/`, `templates/`: 원본 보조 파일. 설치 스크립트도 원본 자료로 포함되지만 이 설치 과정에서는 실행하지 않습니다.
- `ARIS-LICENSE`: 원본 MIT 라이선스. 스킬 내부 별도 라이선스도 보존.
- `aris-provenance.json`: 출처·commit·배포 파일 목록과 크기·실행 권한.

공식 plugin-root `skills/`·`agents/` 검색을 사용합니다. `install.mjs`는 코드·스킬·보조 파일을 `~/.local/share/omp-agent-strataa/4.9.0-<fingerprint>/`에 독립 복사한 뒤 `omp plugin link`로 연결합니다. 이 작업공간이나 다운로드 clone을 지워도 설치본은 유지됩니다. upstream 업데이트는 자동 반영하지 않습니다.

**OMP 적용판의 경계:** 원본 파일은 보존하지만 원본 Claude/Codex MCP 서버, `reviewer_route.py`/`review_gate.py`의 백엔드 승인, Copilot native 증명은 사용하지 않습니다. OMP 결과를 원본 ARIS의 인증된 acceptance로 기록하지 않습니다. 검색·LaTeX·GPU·외부 API 등 스킬별 선택적 의존성은 별도이며, 없으면 해당 작업에서 부족한 조건을 보고해야 합니다. `aris-fanout-leaf`는 설치하지 않았으므로 해당 스킬의 순차 실행 대안을 사용합니다. 모델·도구 API의 미래 호환성까지 보장하지 않습니다.

## 기존 에이전트 보존과 복구

RH 역할 24개와 `dialogue-review`, `dialogue-synthesis`, `dialogue-agreement`는 활성 `agents/`에서 제거했습니다. 이 확장이 등록하는 에이전트는 `aris-worker`와 `aris-reviewer`입니다. Brain은 메인 세션입니다. 다른 플러그인이나 프로젝트의 에이전트 정의는 변경하지 않습니다. ARIS 실행 안에서는 이전 `rh-*`·`dialogue-*` 역할 호출을 차단합니다.

이전 RH·paired 구현은 개발 작업공간의 `workspace/dialogue-legacy-3.1.1/`에만 보관하며 이 공개 저장소에는 포함하지 않습니다. 설치기는 이전 불변 설치본을 삭제하지 않습니다. 복구하려면 본인이 보유한 이전 설치 경로를 `omp plugin link`에 지정한 뒤 OMP에서 `/reload-plugins`를 실행하세요.

설치 명령은 실행한 호스트만 변경합니다. 다른 호스트에는 같은 배포 파일을 동기화한 뒤 그 호스트에서 `node install.mjs`를 실행합니다.

## 검증

```sh
node --test test/*.test.js
```

위 명령은 저장소 루트에서 실행합니다. 아래의 `runs/` 경로는 개발 작업공간의 검증 기록이며, 세션·실행 기록·인증 설정은 이 공개 저장소에 포함하지 않습니다.

역할·모델 선택·상태 복원·취소·완료 근거를 검증합니다. 4.2.0에서는 대상 모듈 테스트 60개를 통과했고 자동 전달 수정 후 controller 테스트 37개(새 회귀 3개 포함)를 통과했습니다. 실제 OMP 18.18.6에서 Terra → Fable 5.2 → Opus 5.5 Worker → Astra 독립 검토 → Fable 답변을 실행해 flow `completed`를 확인했습니다. 합성 입력의 산술 검사이며 실제 성능 실험이 아닙니다. 실제 TUI 예정·실행·실패·상세 화면과 20/40/80/120열 24개 렌더링 조합도 확인했습니다. 근거는 `runs/dialogue-brain-worker-verified.json`, `runs/dialogue-brain-worker-render.json`, `runs/dialogue-brain-worker-tui-*.txt`입니다. 최초 실행에서 발견한 자동 전달 미추적은 `runs/dialogue-brain-worker-native.json`에 그대로 보존합니다. 한 스킬의 성공이 모든 외부 연동 스킬의 실행 성공을 뜻하지 않습니다.

4.2.1에서는 controller/runtime 검사로 Astra 단독 실행의 `max`, 검토자 spawn의 `:max` 고정, `max` 미지원·지원 소실 시 호출 차단을 확인했습니다. Fable `high`, Opus `medium`, Terra `xhigh`는 유지합니다.

4.3.0에서는 flow/controller 검사 61개를 통과했습니다. 실제 OMP 18.18.8 TUI에서 합성 공개 이벤트로 Wave 카드, 노드 이동, 작업 지시·140행 결과의 끝까지 스크롤, 실행 중 실패 갱신, 닫기 후 실행 유지와 40열 리사이즈를 확인했습니다. 1/10/20/40/80/120/160열 × 6/12/24/42행의 28개 렌더 크기를 검사했습니다. 이 UI 검증은 새로운 모델 추론이나 연구 결과 검증이 아닙니다. 근거: `runs/dialogue-wave-runtime.json`, `runs/dialogue-wave-tui-*.txt`.

4.3.1에서는 일반 작업의 자동 완료, 이름 없는 eval, 중첩 부모 관계, 외부·취소·이전 실행 격리, 완료 알림 뒤 원문 도착을 포함한 flow/controller 69개 사례를 확인했습니다(최초 67개 통과, 실패 2개 수정 후 해당 2개 재검사 통과). 실제 OMP 18.18.8에서 합성 호스트 이벤트로 12개 형제·2개 하위 작업을 표시했고, 112개 렌더 크기/모드 조합의 폭·높이 경계를 통과했습니다. 이는 유료 서브 에이전트 14개의 실제 수행이나 연구 결과 검증을 뜻하지 않습니다. 근거: `runs/dialogue-all-agents-runtime.json`.

4.4.0에서는 protocol/Wave/controller/flow의 81개 사례를 확인했습니다. 최초 78개 통과 후 새 예약 계약에 맞게 기존 검토 fixture 두 개를 완료시키고 위치 의존 문자열 검사를 제거하여 나머지 3개도 대상 재검사에서 통과했습니다. 실제 Terra 한 번의 호출이 수집→대조→검사→문안 작성 4단계와 병렬도 2/1/1/1을 설계했습니다. 실제 OMP TUI에서 Wave 0–5, 예정·실행·완료, 단계 이동·상세·공개 결과 끝, 60열 목록을 확인했습니다. **작업자 결과는 UI 검증용 합성 이벤트이며 실제 작업자 모델 실행을 뜻하지 않습니다.** 근거: `runs/dialogue-terra-waves-runtime.json`, `runs/dialogue-terra-waves-*.txt`.

4.5.0에서는 controller/store/watch/protocol/transport 대상 77개 검사를 실행했습니다(최초 73개 통과, 세션 전환 격리·짧은 화면 표시 및 fixture/렌더 순서 수정 후 실패 4개와 관련 1개 재검사 통과). 실제 OMP 18.20.0 터미널 세 개에서 두 소스의 동시 표시, 완료 유지, 다음 요청 교체, 원문 상세, watcher 재개, 60열 리사이즈 및 소스 종료를 확인했습니다. 성공한 검증 실행의 Luna 요약은 실제 호출 3건(소스별 2/1)이며, watcher 재개는 호출 수를 늘리지 않았습니다. **라우터·실행 완료 이벤트는 UI 검증용 합성이며 실제 Worker 실행을 뜻하지 않습니다.** 근거: 개발 작업공간의 `runs/dialogue-watch-runtime.json`, `runs/dialogue-watch-*.txt`.

4.5.1에서는 기존 실행 세션 탐색·저장 기록 읽기·우선순위·watch 대상 38개 검사를 실행했습니다(최초 33개 통과, 원문 상세의 가상 노드/스크롤 수정 및 JSON fixture 비교 교정 후 실패 5개와 관련 2개 재검사 통과). 실제 aica-1의 OMP 18.19.0에서 실행 중인 두 작업을 중단·reload하지 않고 새 watcher에 연결했습니다. 한 세션의 저장된 6개 노드와 다른 세션의 Flow 미관측·원본 입력 상세를 확인했습니다. 추가 모델 호출이나 작업 재실행은 하지 않았습니다. 근거: 개발 작업공간의 `runs/dialogue-watch-aica-live-fix.json`.

4.5.2에서는 실제 aica-1의 OMP 18.20.0 터미널에서 `/dialogue watch`만 입력한 첫 화면을 확인했습니다. 160×36·60×24 모두 기존 세션의 6개 노드와 연결선이 표시되며, 기록이 없는 다른 세션은 원문·미관측 상태를 유지합니다. 세션 선택·상세 진입·모델 호출·producer reload 없이 확인했습니다. 근거: 개발 작업공간의 `runs/dialogue-watch-default-graph.json`.

4.6.0에서는 의존 DAG·ready 단계 배치·전체 동시성 예약·join 차단을 포함한 대상 검사 95개, 검토 보정 뒤 단계별 리뷰 이력·빈 결과 슬롯 해제 등을 포함한 선택 검사 22개를 통과했습니다(중복 포함). 실제 OMP 18.20.0의 160×36·60×24 Flow에서 같은 Wave의 독립 단계, 미실행 형제, 후속 join과 전체 선행 단계 목록을 확인했습니다. **UI 입력과 단위 검사 이벤트는 합성이며 실제 모델 동시 실행의 증거는 아닙니다.** 근거: `runs/dialogue-dependency-tests.txt`, `runs/dialogue-dependency-corrections-tests.txt`, `runs/dialogue-dependency-ui-*.txt`.

4.7.0에서는 전체 검사 177개 중 176개가 최초 통과했고, 예전 검토 라운드 문구만 검사하던 단언을 제거한 뒤 해당 동작 검사 1개가 통과했습니다. 실제 브라우저에서 Strataa 제목·탐색·자체 스킬 원문 로딩과 브라우저 오류 없음을 확인하고 검증 서버를 종료했습니다. 기존 데이터 경로·세션 형식은 유지합니다.

4.8.0에서는 전체 191개 중 190개가 최초 통과했고, 새 테스트의 라우터 응답에 필수 `waves`를 넣은 뒤 남은 1개가 통과했습니다. 모델 동의 변경 경계의 추가 수정은 Dashboard 검사 2개로 확인했습니다. 실제 OMP 18.20.3에서 전체 모델 선택창, 일곱 역할 Astra 일괄 적용, 추천 조합 복원과 `auto` selector를 확인했습니다. 격리 브라우저에서는 현재 분석 모델·강도 표시, 설정 변경 시 재동의, 이전 모델 동의로 보낸 요청의 추론 전 거부를 확인하고 서버를 종료했습니다. 이 검증은 유료 전체 워크플로 실행이나 교차 모델 검토의 증거가 아닙니다.
