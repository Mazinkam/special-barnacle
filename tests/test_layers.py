"""Enforce (part of) the layer order from docs/architecture-review.md B2.

Parses every module under `orchestrator/` with `ast` (module-level AND function-level imports;
`ast.walk` finds `Import`/`ImportFrom` nodes anywhere in the tree, not just at module scope) and
builds a module -> {orchestrator modules it imports} graph. `FORBIDDEN_EDGES` is a data-driven map
of "this module must not import that module" so more edges can be added as later B2 steps land,
without touching the walking/resolution logic below.

This is a coarse, single-file stand-in for the fuller layer map/`import-linter` config B2 promises
("A fuller layer map comes later"); it only pins down the edges this step's refactor depends on.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

ORCHESTRATOR_ROOT = Path(__file__).resolve().parents[1] / 'orchestrator'

#: module dotted-name (relative to the `orchestrator` package) -> modules it must not import,
#: directly or transitively through a re-export. Extend this as later B2/B3 steps add layers.
FORBIDDEN_EDGES: dict[str, set[str]] = {
    'record_batch': {'dashboard', 'app'},
    'runtime': {'dashboard', 'app'},
    'state': {'dashboard', 'app'},
    'record_index': {'dashboard', 'app'},
    'records': {'dashboard', 'app'},
    'engine': {'dashboard', 'app'},
}

#: Only these module prefixes may import `orchestrator.app`; every other module must not.
ALLOWED_APP_IMPORTERS = {'app', 'cli'}


def _dotted_name(path: Path) -> str:
    rel = path.relative_to(ORCHESTRATOR_ROOT)
    parts = list(rel.parts)
    if parts[-1] == '__init__.py':
        parts = parts[:-1]
    else:
        parts[-1] = parts[-1][: -len('.py')]
    return '.'.join(parts)


def _package_of(dotted_name: str, is_package: bool) -> list[str]:
    bits = dotted_name.split('.') if dotted_name else []
    return bits if is_package else bits[:-1]


def _resolve_relative(dotted_name: str, is_package: bool, level: int, module: str | None) -> str:
    base = _package_of(dotted_name, is_package)
    if level > 1:
        cut = len(base) - (level - 1)
        base = base[:cut] if cut > 0 else []
    prefix = '.'.join(base)
    if module:
        return f'{prefix}.{module}' if prefix else module
    return prefix


def imported_modules(path: Path) -> set[str]:
    """Every `orchestrator.<x>` module `path` imports, at any nesting depth."""
    dotted_name = _dotted_name(path)
    is_package = path.name == '__init__.py'
    tree = ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    found: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                name = alias.name
                if name == 'orchestrator':
                    continue
                if name.startswith('orchestrator.'):
                    found.add(name[len('orchestrator.'):])
        elif isinstance(node, ast.ImportFrom):
            if node.level:  # relative import: `from . import x`, `from .x import y`, `from ..x import y`
                target = _resolve_relative(dotted_name, is_package, node.level, node.module)
                if target:
                    found.add(target)
            elif node.module == 'orchestrator':
                for alias in node.names:
                    found.add(alias.name)
            elif node.module and node.module.startswith('orchestrator.'):
                found.add(node.module[len('orchestrator.'):])
    return found


def _top_level(dotted: str) -> str:
    return dotted.split('.', 1)[0]


class LayerTests(unittest.TestCase):
    def setUp(self):
        self.graph: dict[str, set[str]] = {}
        for path in sorted(ORCHESTRATOR_ROOT.rglob('*.py')):
            self.graph[_dotted_name(path)] = imported_modules(path)

    def test_every_orchestrator_module_was_parsed(self):
        # A canary against a typo in the glob/resolution above silently checking nothing.
        self.assertIn('record_batch', self.graph)
        self.assertIn('engine', self.graph)
        self.assertIn('app.refresh', self.graph)
        self.assertIn('cli', self.graph)

    def test_forbidden_edges_are_absent(self):
        for module, forbidden in FORBIDDEN_EDGES.items():
            imported = self.graph[module]
            imported_tops = {_top_level(name) for name in imported}
            for target in forbidden:
                self.assertNotIn(target, imported_tops,
                                 f'{module}.py must not import {target} (imports: {sorted(imported)})')

    def test_only_app_and_cli_import_the_app_package(self):
        for module, imported in self.graph.items():
            top = _top_level(module)
            if top in ALLOWED_APP_IMPORTERS:
                continue
            imported_tops = {_top_level(name) for name in imported}
            self.assertNotIn('app', imported_tops,
                             f'{module}.py must not import orchestrator.app (imports: {sorted(imported)})')


if __name__ == '__main__':
    unittest.main()
