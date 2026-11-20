---
name: strataa-paper-orchestra
description: "Use only when the user chooses PaperOrchestra for literature or a draft, wants to prepare shared inputs, or wants Strataa to import and audit an existing PaperOrchestra run. Do not replace the default ARIS writer."
---

# Use PaperOrchestra with Strataa

Use one writer for each part of the paper. With `literature`, PaperOrchestra supplies the introduction, related work and candidate references; Strataa writes the rest. With `draft`, PaperOrchestra supplies the manuscript; Strataa checks it without regenerating the outline, figures or manuscript. For an existing run, start at **Import for review**. If the request is only to explain, compare designs or prepare materials, do not generate a paper.

Run the `bridge.py` beside this skill using its installed absolute path. The examples use `BRIDGE` for that path, `PO` for a trusted local [PaperOrchestra checkout](https://github.com/google-research/paper-orchestra/tree/d9bae997e793a015ed38bb1605be9eb58c00284f), and `python3` from the chosen environment. From the Strataa source tree you can use `npm run paper-orchestra --` instead of `python3 "$BRIDGE"`. `prepare` and `import` use Python 3.11+ and the standard library only. Every `--out` must be a new directory.

## Prepare the same inputs for both writers

1. Identify the idea, approved experimental log, template and year-month literature cutoff. Keep original measurement files and primary literature outside the writer inputs. If a claim has no supporting result, leave it out or label it as untested.
2. Pack the selected files. `figures/info.json` is a list of `{"name":"overview.png","caption":"..."}` entries with assets alongside it. Omit `--figures` to supply none. Unlisted files are not packed.

```sh
python3 "$BRIDGE" prepare --idea idea.md --log experimental_log.md --figures figures --out materials
```

For Google's public TSAM demo, use `prepare --example "$PO/frontend/examples/cvpr_example.json" --out materials` instead. The example JSON and its image must be together. This preserves the supplied narrative, table values and caption. The reconstructed log is suitable for judging *writing fidelity*, not for proving an experiment ran.

## Choose one external operation

Use a trusted checkout and template. The bridge executes that checkout as the local user; this is not a sandbox. The upstream environment needs its Python dependencies, provider credentials and literature search access. Draft generation also needs the upstream LaTeX tools. Never fetch dependencies, change a model or spend money as a fallback. Obtain explicit authorization to send these inputs and incur provider costs before passing `--allow-model-calls`. A topic mentioning Google, a prior comparison, permission to prepare files or permission to import does not authorize those calls.

```sh
# Literature only. No full writer, plotter or refinement loop.
python3 "$BRIDGE" literature --checkout "$PO" --materials materials --template "$PO/templates/cvpr2025" --cutoff 2024-11 --out lit-run --allow-model-calls

# Alternative: full external draft using the supplied figures.
python3 "$BRIDGE" draft --checkout "$PO" --materials materials --template "$PO/templates/cvpr2025" --cutoff 2024-11 --out draft-run --allow-model-calls
```

These are alternatives. `--writer-model` and, for `draft`, `--reflection-model` override specific upstream roles; the search agent still chooses its own model. The linked upstream draft writer allows three attempts in total. Treat those attempts as part of the cost authorization. Do not run with a hard call or spending limit that this provider path cannot enforce.

`strataa-generation.json` records the mode, cutoff, model overrides, elapsed time and generation status, not a review verdict or a bill. The bridge adds no retry or fallback. Inspect a failed run before authorizing another call.

## Import for review

`import` does not call models, execute TeX, or approve any claim. Use one of these commands from the research project:

```sh
python3 "$BRIDGE" import --mode literature --run lit-run --out literature-review
python3 "$BRIDGE" import --mode draft --run draft-run --out draft-review --raw-result results/metrics.csv --sources citation-sources.json
```

`--raw-result` repeats once per original CSV, TSV, JSON or JSONL file. Omit it when no original exists. Do not re-export a writer's table or prose as a new measurement. `--sources` is an optional JSON object keyed by the exact BibTeX cite key. Each value contains `id` (DOI, arXiv ID or primary HTTPS URL), `file` (local PDF, Markdown or text relative to this JSON) and `locator` (page, section or table). Supply actual primary sources, not the generated abstract registry. Do not send this file or raw results to PaperOrchestra. If evidence is unavailable, leave the key unresolved.

The citation scan follows literal `\input` and `\include` dependencies from the final manuscript. `unresolved_keys` lack local evidence; `missing_bib_keys` lack a matching entry in the manuscript bibliography. Macros and wildcards can leave the static scan incomplete. Even a matched key, identifier and local file do not establish that the paper supports the cited sentence.

1. **Literature:** read `HANDOFF.json` and the imported `literature/outline_v1.json`, `citation_map.json`, `references.bib` and `updated_template.tex`. Map candidates to the sections of the native paper plan. Treat generated text as a draft. Reuse the bibliography for `/paper-write`, retain only cited entries, and verify the supporting source for each use. Do not copy venue boilerplate or accept an unsupported novelty claim. Do not run a second literature search for the same material unless a gap warrants one.
2. **Draft:** use the imported `paper/main.tex`, `paper/references.bib`, assets and `paper/main.pdf`. Work from the new review directory, not the upstream directory containing obsolete iterations. The PDF is the upstream output; its presence is not a successful independent rebuild. If a rebuild is requested, use `/paper-compile` on the trusted source and report the actual result, including missing tools.
3. **Audit:** on a routed request to check the draft, use `paper-claim-audit` on the final TeX and original result files, and `citation-audit` on cited sentences and local primary documents. The Brain supplies absolute paths and a neutral brief to the native read-only Reviewer. Do not ask the Reviewer to search the network; authorized retrieval is the Brain's responsibility. Do not forward the writer's self-review as evidence. With missing originals, distinguish comparisons against the supplied log from verification against measurements. With missing citation evidence, report the affected keys as unresolved. A successful import, available source, or completed review is not a passing verdict. Retain required submission checks and report genuine findings and disagreements before choosing a final version.

For independent review use a natural-language request with `/strataa on`; a direct skill slash command alone does not activate the routing or reviewer contract. For a paired evaluation, give native and external writers the same materials, figures, template and cutoff in different output directories. Record actual models, elapsed time and provider-reported costs if available. Grade number/unit preservation, negative results, citation support and PDF rebuilds before choosing the writer. Do not claim a comparison was run if either side was skipped.
