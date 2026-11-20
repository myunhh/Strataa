"""Local Strataa bridge. Only draft and literature may call a model provider."""

import argparse
from contextlib import redirect_stdout
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True


def main():
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    commands = parser.add_subparsers(dest='action', required=True)
    prepare = commands.add_parser('prepare', help='Pack shared writing inputs offline', allow_abbrev=False)
    inputs = prepare.add_mutually_exclusive_group(required=True)
    inputs.add_argument('--idea', type=Path)
    inputs.add_argument('--example', type=Path, help='The public demo JSON; keep its figure beside it')
    prepare.add_argument('--log', type=Path)
    prepare.add_argument('--figures', type=Path, help='Directory with info.json listing approved name/caption pairs')
    prepare.add_argument('--out', required=True, type=Path)
    for name, help_text in [('draft', 'Generate a manuscript with supplied figures'), ('literature', 'Generate the literature section and bibliography only')]:
        run = commands.add_parser(name, help=help_text, allow_abbrev=False)
        run.add_argument('--checkout', required=True, type=Path, help='Trusted local PaperOrchestra checkout')
        run.add_argument('--materials', required=True, type=Path, help='Directory produced by prepare')
        run.add_argument('--template', required=True, type=Path, help='Trusted conference template directory')
        run.add_argument('--cutoff', required=True, metavar='YYYY-MM', help='Literature cutoff passed to PaperOrchestra')
        run.add_argument('--out', required=True, type=Path, help='New run directory, never reused')
        run.add_argument('--writer-model', help='Override the upstream writer, not its fixed search model')
        if name == 'draft':
            run.add_argument('--reflection-model', help='Override the upstream revision model')
        run.add_argument('--allow-model-calls', action='store_true', help='Authorize external transmission of writing inputs and provider costs')
    ingest = commands.add_parser('import', help='Prepare offline review inputs from an existing run', allow_abbrev=False)
    ingest.add_argument('--mode', choices=('draft', 'literature'), required=True)
    ingest.add_argument('--run', type=Path, required=True)
    ingest.add_argument('--out', type=Path, required=True, help='New directory, not an existing project')
    ingest.add_argument('--raw-result', type=Path, action='append', default=[], help='Original machine-readable result; repeat per file')
    ingest.add_argument('--sources', type=Path, help='JSON mapping citation keys to id, file and locator')
    args = parser.parse_args()
    if args.action == 'prepare':
        from materials import pack_example, pack_materials
        if args.example is not None:
            if args.log is not None or args.figures is not None:
                parser.error('--example already supplies its log and figures')
            result = pack_example(args.example, args.out)
        else:
            if args.log is None:
                parser.error('--idea requires --log')
            result = pack_materials(args.idea, args.log, args.figures, args.out)
    elif args.action == 'import':
        from handoff import import_run
        result = import_run(args.mode, args.run, args.out, args.raw_result, args.sources)
    else:
        from upstream import generate
        with redirect_stdout(sys.stderr):
            result = generate(args.action, args.checkout, args.materials, args.template, args.out, args.cutoff,
                              args.allow_model_calls, args.writer_model, getattr(args, 'reflection_model', None))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, ImportError, RuntimeError) as exc:
        sys.exit(f'PaperOrchestra bridge: {exc}')
