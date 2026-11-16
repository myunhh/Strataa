# Strataa workflow

Router selects ordinary work or research and review. Branches are optional, not mandatory stages. A review of a new artifact waits for its producer. A Worker does not automatically trigger a Reviewer.

```mermaid
flowchart TD
    request["Request"] --> router{"Router"}
    router -->|"Ordinary work"| solo["Solo + pstack as needed"]
    solo --> soloWork["Work directly or delegate"]
    soloWork --> answer["Verify and answer"]
    router -->|"Research or review"| brain["Brain + ARIS + selective pstack"]
    brain --> direct["Work directly"]
    brain --> worker["Worker if needed"]
    brain --> reviewer["Independent Reviewer if needed"]
    direct --> synthesis["Brain synthesis"]
    worker --> synthesis
    reviewer --> synthesis
```

[English README](../README.md) · [Raw Mermaid source](workflow-en.mmd)
