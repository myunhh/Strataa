---
name: strataa-dashboard
description: "논문을 공통 Top-down 개념에 연결하고, 연구 질문·가설·대안·의사결정·검증을 Strataa Dashboard의 BuildUp으로 누적한다. 사용자가 연구 Dashboard에 논문/결정을 저장하거나 연결 지도를 갱신할 때 사용한다."
---

# Strataa Dashboard

이 스킬은 Strataa 자체 추가 스킬이며 vendored ARIS 원본의 일부가 아니다. Human-Learning의 근거 문서·개념 지도·결정 기록을 연구 자료에 적용한다.

## 시작

Dashboard 패키지 루트에서 `npm run dashboard`를 실행한다. 기본 주소 `http://127.0.0.1:4310`, 변경은 `STRATAA_DASHBOARD_PORT`. 기본 저장소는 `${XDG_DATA_HOME:-~/.local/share}/omp-agent-dialogue/research/dashboard.sqlite`; `STRATAA_RESEARCH_DIR`로 분리한다. 기존 OMP 모델·인증·전역 설정을 바꾸지 않는다.

1. `GET /api/state`로 현재 논문·개념·BuildUp·revision·실제 skill·공개 flow를 읽는다. 사용자가 명시한 Dashboard 주소만 쓴다.
2. 논문은 `POST /api/papers`로 `{revision,title,authors,year,sourceUrl,text,notes}`를 저장한다. 파일은 `file:{name,base64}`로 PDF/Markdown/UTF-8 text를 보낸다. URL은 출처이며 원문 자동 수집이 아니다.
3. 사용자가 분석을 요청하면 `POST /api/analyze`에 `{revision,paperIds}`를 보낸다. 선택 원문과 개념이 표시된 모델 제공자에게 전송된다. 과금·공유 범위의 동의를 추정하지 않는다. 도구 없는 OMP 추론이며 기존 Strataa 연구 실행/독립 검토를 대체하지 않는다.
4. 원문 인용과 상위 분야→문제→방법→기법 연결을 확인한다. 공통 이름만으로 논문들의 방법을 동등하다고 선언하지 않는다. 모델 연결은 draft이며 사용자 확인 전 accepted로 바꾸지 않는다.
5. 선택이 생기면 BuildUp에 Context, Options, Decision, Evidence, Next를 기록한다. 가설·결정·관측을 구분하며, 증거가 없는 결과를 만들지 않는다.

## BuildUp 저장 계약

`POST /api/buildup` 또는 `PUT /api/buildup/:id`:

```json
{
  "revision": 0,
  "title": "연구 질문 또는 결정",
  "kind": "hypothesis",
  "status": "draft",
  "body": "문제와 가설",
  "alternatives": "비교한 대안과 차이",
  "rationale": "현재 선택 이유와 반례",
  "evidence": "관측한 근거, 확인 못 한 부분",
  "nextStep": "가설을 구분할 다음 검증",
  "parentId": null,
  "paperIds": [],
  "conceptIds": [],
  "skillNames": [],
  "flowKey": ""
}
```

위 JSON의 revision·ID·skillNames는 실제 state 값으로 채운다. kind는 question/hypothesis/decision/experiment/result, status는 draft/active/accepted/rejected/superseded. accepted는 사용자의 채택 표시이지 연구 주장의 입증이 아니다. 흐름 캡처는 실제 `flows[].key`만 사용한다. 편집에서 flowKey를 생략하면 기존 캡처를 보존한다. 수정 전 버전은 history에 남는다.

새 개념은 `POST /api/concepts`, 편집은 `PUT /api/concepts/:id`에 `{revision,name,description,level,parentId,review}`를 보낸다. 계층 순서를 건너뛰지 않는다. 논문별 연결은 `PUT /api/papers/:id`의 `conceptLinks:[{conceptId,quote,note}]`에 기록한다. quote는 해당 논문의 실제 원문 부분 문자열이어야 한다. 원문은 업로드 뒤 불변이며 잘못된 자료는 새 논문으로 추가한다.

## 불변식

- 모든 저장은 최신 revision을 요구한다. 409이면 state를 다시 읽고 사용자의 변경을 비교한 후 저장한다. 무조건 덮어쓰지 않는다.
- 스킬 선택은 실행·설치·실험 권한이 아니다. 기존 `/strataa on`의 권한과 독립 검토 계약을 유지한다.
- 공개 Flow만 캡처한다. private thinking·인증 정보·추측한 실행 결과를 저장하지 않는다.
- 분석 실패는 명시적으로 남는다. 모델 대체·자동 재시도·조용한 원문 잘라내기·스캔 PDF의 가짜 추출은 하지 않는다.
- 논문별 `GET /api/papers/:id/export`, BuildUp별 `/api/buildup/:id/export`는 Markdown, `/api/export`는 전체 JSON을 반환한다. 원본 PDF는 `/api/papers/:id/pdf`. 백업에는 연구 원문이 있으므로 공유 전 확인한다.
