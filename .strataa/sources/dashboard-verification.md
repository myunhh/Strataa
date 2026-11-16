# 프로젝트 연결 검증 — 2026-11-16

이 문서는 현재 로컬 구현에서 직접 실행한 확인 결과의 공개 기록이다. 연구 논문의 정확성, 사용성 개선량 또는 독립 교차모델 검토 통과를 주장하지 않는다.

## 명령 결과

`node --test test/dashboard-projects.test.js test/dashboard.test.js test/dashboard-metadata.test.js test/dashboard-analysis.test.js`

```text
tests 49
pass 49
fail 0
```

`node --test --test-name-pattern='project opt-in' test/controller.test.js`

```text
tests 1
pass 1
fail 0
```

디렉터리 연결·재시작·변경·stale 복구, 위조 인용·잘못된 계층·경로 탈출·symlink 거부, API 연결 해제와 기존 논문 DB 보존, Solo/Brain의 opt-in handoff를 검사했다. 일반 Node 프로세스에서 plugin entry를 import하는 별도 시도는 OMP 호스트 전용 패키지 부재로 실패했다. 위 controller 검사는 호스트 시뮬레이션이며 전체 OMP 세션 실행의 증거는 아니다.

## 실제 브라우저

현재 Strataa 코드 디렉터리를 UI로 연결했다. 개념 4개·BuildUp 4개·출처 2개가 표시되었고 Top-down 계층, BuildUp 부모 연결, 출처의 실제 인용을 확인했다.

1440px 데스크톱 화면과 390px 모바일의 Overview·Top-down·BuildUp·Sources를 확인했다. 모바일 네 화면 모두 document width가 390px로 가로 넘침이 없었다.

UI 연결 해제 후 manifest가 없는 `/tmp` 연결을 시도했으며 오류와 해당 경로용 초기화 요청을 확인했다. 실제 프로젝트를 다시 연결했다. 브라우저 검사 중 입력 선택과 dialog 추적 도구 사용을 수정했으며 이를 제품 결함으로 기록하지 않는다.

검증 동안 유료 모델 추론은 추가 호출하지 않았다. 사람의 읽기 부담 감소 효과는 아직 측정하지 않았다.
