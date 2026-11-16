# Strataa 실행 구조

Router가 일반 작업과 연구·검토 작업을 구분합니다. 위임과 검토는 필요한 경우에만 실행합니다. 선택한 ARIS 스킬에 필수 검토가 있으면 그 계약을 유지합니다. 산출물을 검토하는 작업은 생산 작업이 끝나고 공개 결과를 받은 뒤 시작합니다.

```mermaid
flowchart TD
    request["사용자 요청"] --> router{"Router"}
    router -->|일반 작업| solo["Solo<br/>필요할 때 pstack"]
    solo --> soloChoice{"직접 수행 또는 위임"}
    soloChoice -->|직접| soloDirect["직접 작업"]
    soloChoice -->|필요할 때| soloDelegate["작업 위임"]
    soloDirect --> soloAnswer["검증 후 답변"]
    soloDelegate --> soloAnswer
    router -->|연구 또는 검토| brain["Brain + ARIS<br/>선택적으로 pstack"]
    brain --> brainDirect["Brain 직접 작업"]
    brain -->|필요할 때| worker["범위를 정한 Worker"]
    brain -->|필요할 때| reviewer["독립적인 Reviewer<br/>산출물 검토는 생산 완료 후"]
    brainDirect --> synthesis["Brain 최종 종합"]
    worker --> synthesis
    reviewer --> synthesis
```

[Mermaid 원본](workflow-ko.mmd) · [한국어 README](../README.ko.md)
