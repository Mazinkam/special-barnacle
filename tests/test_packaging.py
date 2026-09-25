"""Bug 7: a built wheel must be importable/runnable without a git checkout.

`pyproject.toml`'s `[tool.setuptools.package-data]` used to list files that live
*outside* the `orchestrator` package (`../bridge/**/*.ts`, `../bridge/**/*.md`,
`../install.sh`), which setuptools cannot ship inside the package, and it omitted
the package's own runtime data files (`method.json`, `config.json`,
`feature_schema.json`) read via `Path(__file__).with_name(...)` in
`orchestrator/method.py`, `orchestrator/cli.py`, `orchestrator/dashboard.py`,
`orchestrator/engine.py` and `orchestrator/pricing.py` — and `contract.json`, read the
same way by `orchestrator/contract.py`. An installed wheel would
therefore fail on import. These tests build a real wheel, inspect its contents,
and install+import it from an isolated target directory.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = REPO_ROOT / "pyproject.toml"

#: Data files every currently-shipped module reads at import/run time via
#: `Path(__file__).with_name(...)` (method.py, cli.py, dashboard.py, engine.py,
#: pricing.py, contract.py), plus feature_schema.json (the only other non-.py file in the
#: package) and presentation/dashboard_template.html (read lazily by
#: `orchestrator.presentation.dashboard_html`, B3). If a new data file is added under
#: `orchestrator/`, add it here too.
REQUIRED_DATA_FILES = (
    "orchestrator/method.json",
    "orchestrator/config.json",
    "orchestrator/feature_schema.json",
    "orchestrator/contract.json",
    "orchestrator/presentation/dashboard_template.html",
)


def _packaging_tools_available() -> tuple[bool, str]:
    # Use find_spec rather than actually importing: importing `setuptools` in
    # this test process (which may already have imported stdlib `distutils`
    # via pytest/other plugins) can trip setuptools' `_distutils_hack`
    # consistency assertion. A subprocess build below does the real import
    # in a clean interpreter.
    import importlib.util

    for mod in ("pip", "setuptools", "wheel"):
        if importlib.util.find_spec(mod) is None:
            return False, f"{mod} is not importable in this interpreter"
    return True, ""


def _build_wheel(dest_dir: Path) -> Path:
    """Build a wheel for the repo into dest_dir, returning its path.

    Uses --no-build-isolation (no `build` module / network-isolated build env
    available) and --ignore-requires-python, since the repo's
    `requires-python = ">=3.10"` is unmet by the Python 3.9.6 interpreter this
    suite runs under; that is a test-environment accommodation only, not a
    metadata change.
    """
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            str(REPO_ROOT),
            "--no-deps",
            "--no-build-isolation",
            "--ignore-requires-python",
            "-w",
            str(dest_dir),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        pytest.fail(
            f"wheel build failed (exit {result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    wheels = list(dest_dir.glob("*.whl"))
    assert len(wheels) == 1, f"expected exactly one wheel, found {wheels}"
    return wheels[0]


@pytest.fixture(scope="module")
def built_wheel(tmp_path_factory: pytest.TempPathFactory) -> Path:
    available, reason = _packaging_tools_available()
    if not available:
        pytest.skip(f"packaging tools unavailable: {reason}")
    dest_dir = tmp_path_factory.mktemp("wheel-out")
    wheel_path = _build_wheel(dest_dir)
    # Guard against build artefacts leaking into the checkout (pip wheel with
    # --no-build-isolation copies the source tree into a temp dir first, but
    # be defensive in case that behaviour changes).
    for leftover in ("build", *(p.name for p in REPO_ROOT.glob("*.egg-info"))):
        leftover_path = REPO_ROOT / leftover
        if leftover_path.exists():
            shutil.rmtree(leftover_path, ignore_errors=True)
    return wheel_path


def test_wheel_contains_package_data_and_no_bridge_paths(built_wheel: Path) -> None:
    with zipfile.ZipFile(built_wheel) as zf:
        names = set(zf.namelist())

    for required in REQUIRED_DATA_FILES:
        assert required in names, f"{required} missing from wheel contents: {sorted(names)}"

    bridge_paths = [n for n in names if n.startswith("bridge/") or "/bridge/" in n]
    assert not bridge_paths, f"wheel must not contain bridge/ paths, found: {bridge_paths}"


def test_wheel_installs_and_imports_without_checkout(
    built_wheel: Path, tmp_path: Path
) -> None:
    target = tmp_path / "install-target"
    target.mkdir()
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--no-deps",
            "--ignore-requires-python",
            "--target",
            str(target),
            str(built_wheel),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"pip install into --target failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )

    # Run from a neutral cwd (not the repo checkout) with PYTHONPATH set to
    # ONLY the install target, so the test can't accidentally pass by falling
    # back to the checkout's `orchestrator` package.
    neutral_cwd = tmp_path / "neutral-cwd"
    neutral_cwd.mkdir()
    import_check = subprocess.run(
        [
            sys.executable,
            "-c",
            "import orchestrator.method, orchestrator.cli; "
            "orchestrator.method.load_method()",
        ],
        cwd=str(neutral_cwd),
        env={"PYTHONPATH": str(target), "PATH": "/usr/bin:/bin"},
        capture_output=True,
        text=True,
    )
    assert import_check.returncode == 0, (
        f"import from installed wheel failed\nstdout:\n{import_check.stdout}\n"
        f"stderr:\n{import_check.stderr}"
    )


def _load_pyproject_text() -> str:
    return PYPROJECT.read_text(encoding="utf-8")


def _package_data_entries() -> list[str]:
    """Extract the string list values under [tool.setuptools.package-data].

    Tries `tomllib`/`tomli` first (proper TOML parsing); falls back to a
    line-oriented regex scan of the `[tool.setuptools.package-data]` table
    since Python 3.9 has no stdlib TOML parser and `tomli` may not be
    installed.
    """
    text = _load_pyproject_text()

    parser = None
    try:
        import tomllib as _toml  # type: ignore[import-not-found]

        parser = _toml
    except ImportError:
        try:
            import tomli as _toml  # type: ignore[import-not-found]

            parser = _toml
        except ImportError:
            parser = None

    if parser is not None:
        data = parser.loads(text)
        package_data = (
            data.get("tool", {}).get("setuptools", {}).get("package-data", {})
        )
        entries: list[str] = []
        for values in package_data.values():
            entries.extend(values)
        return entries

    # Fallback: regex scan for the package-data table body.
    match = re.search(
        r"\[tool\.setuptools\.package-data\]\s*(.*?)(?:\n\[|\Z)", text, re.DOTALL
    )
    assert match, "could not locate [tool.setuptools.package-data] table in pyproject.toml"
    body = match.group(1)
    return re.findall(r'"([^"]*)"', body)


def test_pyproject_package_data_has_no_parent_relative_entries() -> None:
    entries = _package_data_entries()
    assert entries, "expected at least one package-data entry"
    escaping = [e for e in entries if e.startswith("..")]
    assert not escaping, f"package-data entries must not escape the package: {escaping}"
