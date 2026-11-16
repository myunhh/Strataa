# Strataa workflow

Router selects ordinary work or research and review. Branches are optional, not mandatory stages. A review of a new artifact waits for its producer. Prose cleanup does not force a review. Dotted links show maintenance for projects with records enabled, only for actual changes; read-only requests do not modify records.

```mermaid
flowchart TD
    request["User request"] --> router{"Router<br/>Choose route and task dependencies"}

    router -->|Explanation, coding, prose cleanup| solo["Solo<br/>Select useful pstack skills"]
    solo --> soloWork["Work directly or delegate as needed"]
    soloWork --> soloAnswer["Verify the change and answer"]

    router -->|Research, experiments, independent review| brain["Brain<br/>ARIS procedure + useful pstack skills"]
    brain --> direct["Direct analysis, exploration, planning and writing"]
    brain -->|When concrete execution is needed| worker["Worker<br/>Implementation, collection, measurement + useful pstack"]
    brain -->|When review is needed| reviewer["Independent Reviewer<br/>Inspect original evidence"]

    direct --> synthesis["Brain<br/>Synthesize results and reviews"]
    worker --> synthesis
    reviewer --> synthesis
    synthesis --> researchAnswer["Final answer<br/>Conclusions, uncertainty and next action"]

    soloAnswer -. Projects with records enabled .-> records["strataa-project<br/>Update Top-down, BuildUp and evidence"]
    researchAnswer -. Projects with records enabled .-> records
```

[English README](../README.md) · [Raw Mermaid source](workflow-en.mmd)
