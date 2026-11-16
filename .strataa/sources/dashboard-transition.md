# Dashboard 전환 근거

추출일: 2026-11-16. 방법: 현재 작업 대화와 로컬 저장 로그의 공개 텍스트를 직접 읽어 아래 구간만 옮겼다. 이 기록은 프로젝트 변경 이력이며 논문 연구 결과가 아니다.

## 사용자 요구
현재 작업 대화에서 사용자가 남긴 원문 일부:

> 일단 지금 문제점은 사람이 일일히 읽어야된다는거임.

> 기존 Human Learning처럼 skill하나 strataa에 넣고 원래 진행하던 프로젝트나, strataa로 진행하던 프로젝트에서 top down, build up 등을 구조를 맞추게 해서 디렉터리 연결하면 그거 맞게 분ㅅㄱ해주는걸로 가줘.

GitHub 처리 선택 질문의 실제 응답: `{"publish":"remove-first"}`. 선택 항목은 기존 Dashboard를 제거한 커밋을 먼저 push하고 새 버전은 로컬 완성 후 다시 게시하는 방식이었다.

## 기존 분석 실패
원본: `runs/analysis-status-verification.json`, JSON `actualJob.error` (12행). 이 파일의 실제 저장값:

> Paper analysis: OMP exceeded the 195-second analysis deadline

동일 로그에는 `actualJob.status`가 `failed`, `additionalInferenceInvoked`가 `false`로 기록되어 있다. 이 로그는 당시 요청의 시간 초과와 추가 추론 미호출만 뒷받침하며, 논문 분석 내용의 정확성이나 모델 성능을 평가하지 않는다.

## 공개 배포 제거
현재 작업의 실제 Git push 결과:

```text
To https://github.com/myunhh/Strataa.git
   af0f48c..73157b3  main -> main
```

커밋 `73157b32c62add363811e9291479dc97e593d515`는 기존 Dashboard 파일·전용 스킬·배포 연결을 제거했다. 사용자 논문 DB는 삭제하지 않았고 이전 로컬 코드를 보존해 `/library` 연결용으로 복원했다. 새 프로젝트 UI의 검증 결과는 별도 검증 기록이 생기기 전까지 미확인이다.
