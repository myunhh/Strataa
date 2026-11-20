"""File contracts shared by PaperOrchestra generation and offline import."""

import json
import re


LITERATURE_FILES = {
    "outline": "outline_v1.json",
    "citation_map": "citation_map.json",
    "bibliography": "references.bib",
    "template": "updated_template.tex",
}


def reject_constant(value):
    raise ValueError(f"Invalid JSON constant: {value}")


def load_json(path):
    def unique_keys(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key in {path}: {key}")
            result[key] = value
        return result

    with path.open(encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=unique_keys, parse_constant=reject_constant)


def json_object(path):
    value = load_json(path)
    if not isinstance(value, dict) or not value:
        raise ValueError(f"Expected a nonempty JSON object: {path}")
    return value


def bib_keys(path):
    return set(re.findall(r"(?im)^\s*@(?!comment\b|string\b|preamble\b)\w+\s*[{(]\s*([^\s,{}()]+)\s*,", path.read_text(encoding="utf-8")))


def validate_literature(files):
    json_object(files["outline"])
    candidates = json_object(files["citation_map"])
    keys = bib_keys(files["bibliography"])
    for key, paper in candidates.items():
        title = paper.get("title") if isinstance(paper, dict) else None
        if not isinstance(title, str) or not title.strip():
            raise ValueError(f"Unusable citation candidate {key!r} in citation_map.json")
        if key not in keys:
            raise ValueError(f"Citation {key!r} has no entry in references.bib")
    if "\\" not in files["template"].read_text(encoding="utf-8"):
        raise ValueError("updated_template.tex contains no LaTeX commands")
