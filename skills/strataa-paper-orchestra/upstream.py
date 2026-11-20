"""Opt-in adapter for a locally trusted Google PaperOrchestra checkout."""

import importlib
import json
import os
from pathlib import Path
import re
import sys
from time import monotonic

from artifacts import LITERATURE_FILES, json_object, validate_literature
from materials import pack_materials


def _nonempty_file(path):
    if not path.is_file() or not path.stat().st_size:
        raise ValueError(f"Required nonempty output is missing: {path}")
    return path


def _text(path):
    value = _nonempty_file(path).read_text(encoding="utf-8")
    if not value.strip():
        raise ValueError(f"Required output contains only whitespace: {path}")
    return value


def _module(name, checkout):
    module = importlib.import_module(name)
    origin = getattr(module, "__file__", None)
    if not origin or not Path(origin).resolve().is_relative_to(checkout):
        raise ValueError(
            f"{name} was not loaded from trusted checkout {checkout}; "
            "start a fresh bridge process and check the checkout's Python packages"
        )
    return module


def _literature(checkout, template, output, cutoff, writer_model):
    outline_class = _module("methods.agents.outline_agent", checkout).OutlineAgent
    literature_class = _module(
        "methods.agents.literature_review_agent", checkout
    ).HybridLiteratureAgent
    model = {} if writer_model is None else {"model_name": writer_model}
    raw = output / "raw_materials"
    outline = output / "outline.json"
    outline_class(cutoff_date=cutoff, **model).run(
        idea_file=str(raw / "idea_sparse.md"),
        experimental_log_file=str(raw / "experimental_log.md"),
        latex_template_file=str(template / "template.tex"),
        conference_guidelines_file=str(template / "guidelines.md"),
        output_filepath=str(outline),
    )
    json_object(outline)
    destination = output / "literature_agent_output"
    literature_class(
        idea_path=str(raw / "idea_sparse.md"),
        experimental_log_path=str(raw / "experimental_log.md"),
        latex_template_path=str(template / "template.tex"),
        conference_guidelines_path=str(template / "guidelines.md"),
        output_dir=str(destination),
        max_workers=3,
        **model,
    ).run(outline_path=str(outline), cutoff_date=cutoff)
    validate_literature({kind: destination / name for kind, name in LITERATURE_FILES.items()})


def _pdf(path):
    with _nonempty_file(path).open("rb") as stream:
        if stream.read(5) != b"%PDF-":
            raise ValueError(f"Expected PDF output: {path}")


def _draft(checkout, template, output, cutoff, writer_model, reflection_model):
    writer = _module("methods.paper_writer", checkout).write_single_paper
    kwargs = {
        "base_dir": str(output),
        "latex_template_dir": str(template),
        "idea_filename": "idea_sparse.md",
        "experimental_log_filename": "experimental_log.md",
        "research_cutoff": cutoff,
    }
    if writer_model is not None:
        kwargs["writer_model_name"] = writer_model
    if reflection_model is not None:
        kwargs["reflection_model_name"] = reflection_model
    if writer(**kwargs) is not True:
        raise ValueError("Upstream write_single_paper reported failure")
    _pdf(output / "final_paper.pdf")
    refined = output / "content_refinement_workdir"
    _text(refined / "final_refined_paper.tex")
    _pdf(refined / "final_refined_paper.pdf")
    _text(refined / "references.bib")


def generate(mode, checkout, materials, template, output, cutoff, allow_model_calls,
             writer_model=None, reflection_model=None):
    """Run one requested upstream pipeline; never authorize providers implicitly."""
    if not allow_model_calls:
        raise ValueError(
            "Model calls require explicit --allow-model-calls consent; "
            "only use a local checkout you trust to execute code and send approved inputs"
        )
    if mode not in {"draft", "literature"}:
        raise ValueError("Generation mode must be draft or literature")
    if not isinstance(cutoff, str) or not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", cutoff) or cutoff.startswith("0000-"):
        raise ValueError("--cutoff must be a valid YYYY-MM month")
    if mode == "literature" and reflection_model is not None:
        raise ValueError("--reflection-model is available only for draft")
    for label, model in (("writer", writer_model), ("reflection", reflection_model)):
        if model is not None and (not isinstance(model, str) or not model.strip()):
            raise ValueError(f"The {label} model must be a nonempty model name")

    checkout = Path(checkout).expanduser().resolve()
    materials = Path(materials).expanduser().resolve()
    template = Path(template).expanduser().resolve()
    requested_output = Path(output).expanduser()
    if requested_output.exists() or requested_output.is_symlink():
        raise ValueError(f"Output must be a fresh directory: {requested_output}")
    output = requested_output.resolve()
    for label, directory in (("checkout", checkout), ("materials", materials), ("template", template)):
        if not directory.is_dir():
            raise ValueError(f"--{label} must name an existing local directory: {directory}")
    for directory in (materials, template):
        if output.is_relative_to(directory):
            raise ValueError(f"Output cannot be nested inside an input directory: {directory}")
    required = ["methods/agents/outline_agent.py", "methods/agents/literature_review_agent.py"]
    if mode == "draft":
        required.append("methods/paper_writer.py")
    for relative in required:
        if not (checkout / relative).is_file():
            raise ValueError(f"Trusted checkout lacks upstream entrypoint: {checkout / relative}")
    for filename in ("template.tex", "guidelines.md"):
        _text(template / filename)
    for filename in ("idea_sparse.md", "experimental_log.md", "figures/info.json"):
        _nonempty_file(materials / filename)

    output.mkdir(parents=True, exist_ok=False)
    started = monotonic()
    receipt = {"mode": mode, "cutoff": cutoff, "plotting": False, "writerModelOverride": writer_model}
    if mode == "draft":
        receipt["reflectionModelOverride"] = reflection_model

    def record(status):
        receipt.update(status=status, elapsedSeconds=round(monotonic() - started, 3))
        temp = output / ".strataa-generation.tmp"
        temp.write_text(json.dumps(receipt) + "\n", encoding="utf-8")
        temp.replace(output / "strataa-generation.json")

    record("in_progress")
    finished = False
    try:
        pack_materials(
            materials / "idea_sparse.md", materials / "experimental_log.md",
            materials / "figures", output / "raw_materials",
        )
        original_cwd = Path.cwd()
        original_path = sys.path[:]
        try:
            os.chdir(checkout)
            sys.path.insert(0, str(checkout))
            if mode == "draft":
                _draft(checkout, template, output, cutoff, writer_model, reflection_model)
            else:
                _literature(checkout, template, output, cutoff, writer_model)
        finally:
            os.chdir(original_cwd)
            sys.path[:] = original_path
    except Exception as error:
        raise RuntimeError(
            f"PaperOrchestra {mode} failed; retained run at {output}: {error}. "
            "Inspect this run and the trusted checkout's dependencies/provider configuration; "
            "no bridge retry or model fallback was attempted"
        ) from error
    else:
        finished = True
    finally:
        record("completed" if finished else "failed")
    return {**receipt, "output": str(output)}
