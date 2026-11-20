"""Prepare only the writing inputs explicitly selected for both writers."""

import json
import shutil
from pathlib import Path


def _regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Expected a regular file, not a link: {path}")
    return path


def _text(path):
    if path.suffix.lower() not in {'.md', '.txt'}:
        raise ValueError(f"Select a Markdown or text writing input: {path}")
    data = _regular(path).read_bytes()
    if not data.decode('utf-8').strip():
        raise ValueError(f"Empty writing input: {path}")
    return data


def _figures(directory, entries):
    if directory.is_symlink() or not isinstance(entries, list):
        raise ValueError('Expected a figure directory and a list of {name, caption} entries')
    assets, seen = [], set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError('Expected a figure entry with a filename and caption')
        name, caption = entry.get('name'), entry.get('caption', '')
        if not isinstance(name, str) or not name or name.startswith('.') or '/' in name or '\\' in name or not isinstance(caption, str):
            raise ValueError(f'Invalid figure name or caption: {name!r}')
        file = Path(name)
        suffix = file.suffix.lower()
        if suffix not in {'.pdf', '.png', '.jpg', '.jpeg'}:
            raise ValueError(f'Unsupported figure format: {name}')
        # The upstream section writer recognizes only lowercase .pdf, .png and .jpg.
        target = file.with_suffix('.jpg' if suffix == '.jpeg' else suffix).name
        if target.casefold() in seen:
            raise ValueError(f'Duplicate packed figure name: {target}')
        seen.add(target.casefold())
        assets.append((_regular(directory / name), target, caption))
    return assets


def _pack(idea, log, assets, output):
    output.mkdir(parents=True, exist_ok=False)
    try:
        (output / 'idea_sparse.md').write_bytes(idea)
        (output / 'experimental_log.md').write_bytes(log)
        figures = output / 'figures'
        figures.mkdir()
        manifest = []
        for source, name, caption in assets:
            shutil.copyfile(source, figures / name)
            manifest.append({'name': name, 'caption': caption})
        (figures / 'info.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    except BaseException:
        shutil.rmtree(output)
        raise
    return {'mode': 'prepare', 'materials': str(output.resolve()), 'figureCount': len(assets)}


def pack_materials(idea, log, figures, output):
    assets = []
    if figures is not None:
        if figures.is_symlink() or output.resolve().is_relative_to(figures.resolve()):
            raise ValueError('Use a real figure directory and a separate output')
        entries = json.loads(_regular(figures / 'info.json').read_text(encoding='utf-8'))
        assets = _figures(figures, entries)
    return _pack(_text(idea), _text(log), assets, output)


def pack_example(example, output):
    data = json.loads(_regular(example).read_text(encoding='utf-8'))
    if not isinstance(data, dict) or any(not isinstance(data.get(k), str) or not data[k].strip() for k in ('idea', 'log')):
        raise ValueError('The PaperOrchestra example must contain nonempty idea and log strings')
    name = data.get('figure_path')
    assets = _figures(example.parent, [{'name': name, 'caption': data.get('figure_caption', '')}]) if name is not None and name != '' else []
    return _pack(data['idea'].encode('utf-8'), data['log'].encode('utf-8'), assets, output)
