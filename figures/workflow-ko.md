# Strataa 실행 구조

Router가 일반 작업과 연구·검토 작업을 구분합니다. 위임과 검토는 필요한 경우에만 실행하며 문장 정리에 리뷰를 강제하지 않습니다. 선택한 ARIS 스킬에 필수 검토가 있으면 그 계약을 유지합니다. 새 산출물의 검토는 생산 완료 후 진행합니다. 점선은 기록이 활성화된 프로젝트의 유지 작업이며 실제 변경이 있을 때만 갱신합니다. 읽기 전용 요청에서는 기록도 수정하지 않습니다.

```mermaid
flowchart TD
    request["사용자 요청"] --> router{"Router<br/>경로·작업 의존성 결정"}

    router -->|일반 설명·코딩·문장 정리| solo["Solo<br/>필요한 pstack 스킬 선택"]
    solo --> soloWork["직접 수행 또는 필요한 작업 위임"]
    soloWork --> soloAnswer["변경에 맞게 검증 후 답변"]

    router -->|연구·실험·독립 검토| brain["Brain<br/>ARIS 절차 + 필요한 pstack 스킬"]
    brain --> direct["직접 분석·탐색·계획·글쓰기"]
    brain -->|구체 실행이 필요할 때| worker["Worker<br/>구현·수집·측정 + 필요한 pstack"]
    brain -->|검토가 필요할 때| reviewer["독립 Reviewer<br/>원본 근거 검토"]

    direct --> synthesis["Brain<br/>결과·검토 종합"]
    worker --> synthesis
    reviewer --> synthesis
    synthesis --> researchAnswer["최종 답변<br/>결론·불확실성·다음 행동"]

    soloAnswer -. 기록 활성화 프로젝트 .-> records["strataa-project<br/>Top-down · BuildUp · 근거 갱신"]
    researchAnswer -. 기록 활성화 프로젝트 .-> records
```

[Mermaid 원본](workflow-ko.mmd) · [한국어 README](../README.ko.md)
