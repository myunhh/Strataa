"""Offline import of materialized PaperOrchestra outputs, not research approval."""

import csv
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
from urllib.parse import urlsplit

from artifacts import LITERATURE_FILES, bib_keys, load_json, reject_constant, validate_literature


STYLE_EXTENSIONS = {".sty", ".cls", ".bst", ".bbx", ".cbx", ".def", ".clo", ".cfg", ".fd", ".ist"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf", ".eps", ".svg", ".ps"}
HISTORIC_TEX = re.compile(r"(?:template|raw_draft_paper|initial_draft|final_refined_paper|refined_paper_v\d+|formatted_candidate_v\d+)\.tex$", re.I)
CITATION = re.compile(r"\\(?:[A-Za-z]*cite[A-Za-z]*|nocite)\*?(?:\s*\[[^\]]*\])*\s*\{([^{}]*)\}")
INCLUDE = re.compile(r"\\(?:input|include|subfile)\s*\{([^{}]*)\}")
GRAPHIC = re.compile(r"\\includegraphics\*?(?:\s*\[[^\]]*\])?\s*\{([^{}]*)\}")


def _safe_path(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"Symlinks are not allowed: {part}")
    return path


def _file(path, nonempty=False):
    path = _safe_path(path)
    if not stat.S_ISREG(path.stat().st_mode):
        raise ValueError(f"Expected a regular file: {path}")
    if nonempty and path.stat().st_size == 0:
        raise ValueError(f"Required output is empty: {path}")
    return path


def _relative(value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ValueError(f"Unsafe relative path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in value.split("/") or ":" in value:
        raise ValueError(f"Unsafe relative path: {value!r}")
    return Path(*path.parts)


def _tree(root):
    files = []
    def failed_walk(error):
        raise error

    for directory, dirs, names in os.walk(root, followlinks=False, onerror=failed_walk):
        for name in dirs + names:
            path = Path(directory) / name
            if path.is_symlink():
                raise ValueError(f"Symlinks are not allowed in imported trees: {path}")
        for name in names:
            files.append(_file(Path(directory) / name))
    return files


def _tex_text(path):
    text = path.read_text(encoding="utf-8")
    return re.sub(r"(?<!\\)%[^\n]*", "", text)


def _identifier(value):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError("Source id must be a DOI, arXiv identifier, or primary HTTPS URL")
    if re.fullmatch(r"(?:doi:)?10\.\d{4,9}/\S+", value, re.I):
        return
    if re.fullmatch(r"(?:arxiv:)?(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z.-]+/\d{7}(?:v\d+)?)", value, re.I):
        return
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or any(c.isspace() for c in value):
        raise ValueError(f"Source id is not a DOI, arXiv identifier, or HTTPS URL: {value}")


def import_run(mode, run, output, raw_results, sources):
    """Copy a completed run transactionally and return its honest audit handoff."""
    if mode not in {"draft", "literature"}:
        raise ValueError("Import mode must be draft or literature")
    run = _safe_path(run)
    if not run.is_dir():
        raise ValueError(f"Run directory does not exist: {run}")
    output = _safe_path(output)
    if output.exists():
        raise ValueError(f"Output must be a fresh directory: {output}")
    if output.is_relative_to(run) or run.is_relative_to(output):
        raise ValueError("Output and run directories must not overlap")
    if not output.parent.is_dir():
        raise ValueError(f"Output parent directory does not exist: {output.parent}")

    receipt = run / "strataa-generation.json"
    receipt_path = None
    if receipt.exists() or receipt.is_symlink():
        metadata = load_json(_file(receipt, True))
        if not isinstance(metadata, dict) or metadata.get("status") != "completed":
            raise ValueError("Generation receipt must record a completed run before import")
        if metadata.get("mode") not in {"draft", "literature"} or (mode == "draft" and metadata["mode"] != "draft"):
            raise ValueError("Generation receipt mode is incompatible with this import")
        receipt_path = str(receipt)

    copies = {}

    def add(source, destination, nonempty=False):
        source = _file(source, nonempty)
        destination = _relative(destination).as_posix()
        if destination in copies:
            raise ValueError(f"Artifact destination collision: {destination}")
        for existing in copies:
            if destination.startswith(existing + "/") or existing.startswith(destination + "/"):
                raise ValueError(f"Artifact path collision: {destination}")
        copies[destination] = source
        return destination

    artifacts = {}
    citation_gaps = []
    cited = set()
    missing_bib_keys = []
    literature = run / "literature_agent_output"
    if mode == "literature" or literature.exists():
        files = {kind: _file(literature / name, True) for kind, name in LITERATURE_FILES.items()
                 if mode == "literature" or (literature / name).exists()}
        if mode == "literature":
            validate_literature(files)
        if files:
            artifacts["literature"] = {kind: add(source, f"literature/{source.name}") for kind, source in files.items()}

    if mode == "draft":
        work = run / "content_refinement_workdir"
        final_tex = _file(work / "final_refined_paper.tex", True)
        if not final_tex.read_text(encoding="utf-8").strip():
            raise ValueError(f"Required output is blank: {final_tex}")
        final_pdf = _file(run / "final_paper.pdf", True)
        with final_pdf.open("rb") as stream:
            if not stream.read(8).startswith(b"%PDF-"):
                raise ValueError(f"Final PDF lacks a valid PDF signature: {final_pdf}")
        paper = {
            "tex": add(final_tex, "paper/main.tex"),
            "pdf": add(final_pdf, "paper/main.pdf"),
            "bibliography": add(work / "references.bib", "paper/references.bib"),
            "assets": [],
        }
        work_files = [p for p in work.iterdir() if p.suffix.lower() in STYLE_EXTENSIONS or p.suffix.lower() in IMAGE_EXTENSIONS - {".pdf"}]
        figures = work / "figures"
        if figures.exists() or figures.is_symlink():
            figures = _safe_path(figures)
            if not figures.is_dir():
                raise ValueError(f"Expected a figure directory: {figures}")
            work_files.extend(p for p in _tree(figures) if p.suffix.lower() in IMAGE_EXTENSIONS)
        for source in work_files:
            relative = source.relative_to(work)
            paper["assets"].append(add(source, f"paper/{relative.as_posix()}"))

        pending = [final_tex]
        seen = set()
        texts = []
        while pending:
            current = pending.pop()
            if current in seen:
                continue
            seen.add(current)
            text = _tex_text(current)
            texts.append(text)
            for match in CITATION.finditer(text):
                keys = [key.strip() for key in match.group(1).split(",") if key.strip()]
                if "*" in keys:
                    citation_gaps.append("Wildcard citation cannot be resolved by the static final-draft audit.")
                for key in keys:
                    if "\\" in key or "#" in key:
                        citation_gaps.append("Dynamic citation keys cannot be resolved by the static final-draft audit.")
                    elif key != "*":
                        cited.add(key)
            for match in INCLUDE.finditer(text):
                name = match.group(1).strip()
                if "\\" in name or "#" in name:
                    citation_gaps.append(f"Dynamic TeX dependency cannot be audited statically: {name}")
                    continue
                relative = _relative(name)
                if not relative.suffix:
                    relative = relative.with_suffix(".tex")
                source = _file(work / relative, True)
                if HISTORIC_TEX.fullmatch(source.name):
                    raise ValueError(f"Final draft includes a historic manuscript variant: {source.name}")
                destination = f"paper/{relative.as_posix()}"
                if destination in copies and copies[destination] != source:
                    raise ValueError(f"Artifact destination collision: {destination}")
                if destination not in copies:
                    paper["assets"].append(add(source, destination))
                pending.append(source)
            if re.search(r"\\(?:input|include|subfile)\b(?!\s*\{)", text):
                citation_gaps.append("Unbraced TeX dependency cannot be audited statically.")
            if re.search(r"\\(?:newcommand|renewcommand|def)\b", text):
                citation_gaps.append("TeX macros are not expanded by the static citation audit.")
        graphic_paths = [Path()]
        for text in texts:
            for declaration in re.findall(r"\\graphicspath\s*\{((?:\s*\{[^{}]*\}\s*)+)\}", text):
                for value in re.findall(r"\{([^{}]*)\}", declaration):
                    if "\\" in value or "#" in value:
                        citation_gaps.append("Dynamic figure search paths cannot be audited statically.")
                    else:
                        graphic_paths.append(_relative(value))
        for text in texts:
            for match in GRAPHIC.finditer(text):
                name = match.group(1).strip()
                if "\\" in name or "#" in name:
                    citation_gaps.append(f"Dynamic figure dependency cannot be audited statically: {name}")
                    continue
                relative = _relative(name)
                candidates = []
                for prefix in graphic_paths:
                    candidate = prefix / relative
                    if candidate.suffix:
                        candidates.append(candidate)
                    else:
                        candidates.extend(candidate.with_suffix(suffix) for suffix in sorted(IMAGE_EXTENSIONS))
                found = next((candidate for candidate in candidates if (work / candidate).is_file()), None)
                if found is None:
                    raise ValueError(f"Missing final-draft figure asset: {name}")
                source = _file(work / found, True)
                if HISTORIC_TEX.fullmatch(source.with_suffix(".tex").name):
                    raise ValueError(f"Final draft includes a historic manuscript PDF: {name}")
                destination = f"paper/{found.as_posix()}"
                if destination in copies and copies[destination] != source:
                    raise ValueError(f"Artifact destination collision: {destination}")
                if destination not in copies:
                    paper["assets"].append(add(source, destination))
        paper["assets"].sort()
        artifacts["paper"] = paper
        missing_bib_keys = sorted(cited - bib_keys(work / "references.bib"))

    raw_paths = []
    known_outputs = set(copies.values())
    known_names = ["outline.json", "strataa-generation.json"]
    if mode == "draft":
        known_names.extend([
            "content_refinement_workdir/content_refinement_worklog.json",
            "content_refinement_workdir/format_refinement_worklog.json",
        ])
    for name in known_names:
        generated = run / name
        if generated.exists():
            known_outputs.add(_file(generated))
    generated_inodes = {(p.stat().st_dev, p.stat().st_ino) for p in known_outputs}
    for raw in raw_results:
        raw = _file(raw, True)
        if raw.suffix.lower() not in {".csv", ".tsv", ".json", ".jsonl"}:
            raise ValueError(f"Raw evidence must be original CSV, TSV, JSON, or JSONL: {raw}")
        if raw.is_relative_to(run) or (raw.stat().st_dev, raw.stat().st_ino) in generated_inodes:
            raise ValueError(f"Run-generated files cannot be relabeled as raw evidence: {raw}")
        suffix = raw.suffix.lower()
        if suffix == ".json":
            load_json(raw)
        else:
            seen = False
            with raw.open(encoding="utf-8", newline="") as stream:
                if suffix == ".jsonl":
                    for line in stream:
                        if line.strip():
                            json.loads(line, parse_constant=reject_constant)
                            seen = True
                else:
                    for row in csv.reader(stream, delimiter="\t" if suffix == ".tsv" else ",", strict=True):
                        if not seen and any(cell.strip() for cell in row):
                            seen = True
            if not seen:
                raise ValueError(f"Raw evidence file is blank: {raw}")
        raw_paths.append(add(raw, f"results/{raw.name}"))

    source_map = {}
    if sources is not None:
        sources = _file(sources, True)
        registry = load_json(sources)
        if not isinstance(registry, dict):
            raise ValueError("Sources JSON must be an object keyed by citation key")
        documents = {}
        for key, item in registry.items():
            if not key.strip() or not isinstance(item, dict) or set(item) != {"id", "file", "locator"}:
                raise ValueError(f"Source {key!r} must have exactly id, file, and locator")
            _identifier(item["id"])
            if not isinstance(item["locator"], str) or not item["locator"].strip():
                raise ValueError(f"Source {key!r} requires a page or section locator")
            relative = _relative(item["file"])
            if relative.suffix.lower() not in {".pdf", ".txt", ".md"}:
                raise ValueError(f"Source document must be a local PDF, TXT, or Markdown file: {relative}")
            document = _file(sources.parent / relative, True)
            if document.suffix.lower() == ".pdf":
                with document.open("rb") as stream:
                    if not stream.read(8).startswith(b"%PDF-"):
                        raise ValueError(f"Source PDF lacks a valid PDF signature: {document}")
            else:
                if not document.read_text(encoding="utf-8").strip():
                    raise ValueError(f"Source document is blank: {document}")
            identity = (document.stat().st_dev, document.stat().st_ino)
            if identity not in documents:
                documents[identity] = add(document, f"sources/documents/{relative.as_posix()}")
            source_map[key] = {"id": item["id"], "file": documents[identity], "locator": item["locator"]}

    unresolved = sorted(cited - source_map.keys())
    claim_gaps = [] if raw_paths else ["No original raw result files supplied; narrative experimental logs are not raw evidence."]
    if mode == "literature":
        citation_state = "not_applicable"
        citation_gaps.append("Literature artifacts are reusable candidates, not a final manuscript or verified citations.")
    elif unresolved:
        citation_state = "missing_sources"
        citation_gaps.append("Final-draft citation keys lack supplied local primary-source documents: " + ", ".join(unresolved))
    elif citation_gaps:
        citation_state = "partial_static_scan"
    else:
        citation_state = "sources_supplied" if cited else "no_citations"
    if missing_bib_keys:
        citation_gaps.append("Final-draft citation keys missing from the manuscript bibliography: " + ", ".join(missing_bib_keys))
    if source_map:
        citation_gaps.append("Source identity, primary-source status, and claim support require independent review; local files and locators are not verification.")
    citation_gaps = list(dict.fromkeys(citation_gaps))
    review_gap = "Independent claim and citation review has not been performed; generated review scores are not evidence."
    handoff = {
        "schema_version": 1,
        "mode": mode,
        "run": str(run),
        "generation_receipt": receipt_path,
        "artifacts": artifacts,
        "raw_results": raw_paths,
        "sources": source_map,
        "audits": {
            "claims": {"status": "not_reviewed", "gaps": claim_gaps},
            "citations": {
                "status": "not_reviewed",
                "scope": "final_draft" if mode == "draft" else "literature_candidates_only",
                "evidence_state": citation_state,
                "cited_keys": sorted(cited),
                "unresolved_keys": unresolved,
                "missing_bib_keys": missing_bib_keys,
                "gaps": citation_gaps,
            },
        },
        "gaps": claim_gaps + citation_gaps + [review_gap],
    }

    stage = Path(tempfile.mkdtemp(prefix=f".{output.name}.import-", dir=output.parent))
    try:
        for destination, source in copies.items():
            target = stage / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(_file(source), target)
        if sources is not None:
            (stage / "sources").mkdir(exist_ok=True)
            (stage / "sources" / "index.json").write_text(json.dumps(source_map, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        (stage / "HANDOFF.json").write_text(json.dumps(handoff, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        # Claim a fresh name, then publish the complete staged tree in one rename.
        output.mkdir()
        try:
            stage.rename(output)
        except BaseException:
            output.rmdir()
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return handoff
