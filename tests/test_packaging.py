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

import os
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
    # Check installed distributions via metadata: importing or `find_spec`-ing
    # `setuptools` trips its `_distutils_hack` (assertion if stdlib distutils is
    # already loaded; KeyError('__file__') under pytest-xdist's execnet frames).
    # The pip subprocess below does the real import in a clean interpreter.
    from importlib import metadata

    for dist in ("pip", "setuptools", "wheel"):
        try:
            metadata.version(dist)
        except metadata.PackageNotFoundError:
            return False, f"{dist} is not installed in this interpreter"
    need = _required_setuptools()
    have = metadata.version("setuptools")
    if need and _vtuple(have) < _vtuple(need):
        return False, (
            f"setuptools {have} is older than pyproject.toml's build-system "
            f"requirement setuptools>={need}; it would build an empty UNKNOWN-0.0.0 wheel"
        )
    return True, ""


def _vtuple(v: str) -> tuple[int, ...]:
    # No `packaging` dependency (py3.9 CI has only pip + pytest): leading ints only.
    return tuple(int(n) for n in re.findall(r"\d+", v)[:3])


def _required_setuptools() -> str:
    """Minimum setuptools from [build-system].requires (regex; tomllib is 3.11+)."""
    block = re.search(
        r"\[build-system\].*?requires\s*=\s*\[(.*?)\]", PYPROJECT.read_text(), re.DOTALL
    )
    m = re.search(r"setuptools\s*>=\s*([\d.]+)", block.group(1)) if block else None
    return m.group(1) if m else ""


def _skip_or_fail_unavailable(reason: str) -> None:
    # Skip locally, but fail under CI so packaging tests cannot be silently skipped.
    msg = f"packaging tools unavailable: {reason}"
    if os.environ.get("CI"):
        pytest.fail(msg)
    pytest.skip(msg)


def _build_wheel(dest_dir: Path) -> Path:
    """Build a wheel into dest_dir from a staged copy of the repo.

    Only `orchestrator/` (minus __pycache__) and `pyproject.toml` are staged, so
    pip neither copies the whole checkout (bench/, bridge/, node_modules, .git)
    nor leaves build artefacts in it. Uses --no-build-isolation (no network) and
    --ignore-requires-python for robustness across interpreters.
    """
    stage = dest_dir / "src"
    stage.mkdir()
    shutil.copytree(
        REPO_ROOT / "orchestrator", stage / "orchestrator",
        ignore=shutil.ignore_patterns("__pycache__"),
    )
    shutil.copy2(PYPROJECT, stage / "pyproject.toml")
    out = dest_dir / "out"
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            str(stage),
            "--no-deps",
            "--no-build-isolation",
            "--ignore-requires-python",
            "-w",
            str(out),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PIP_DISABLE_PIP_VERSION_CHECK": "1"},
    )
    if result.returncode != 0:
        pytest.fail(
            f"wheel build failed (exit {result.returncode})\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    wheels = list(out.glob("*.whl"))
    assert len(wheels) == 1, f"expected exactly one wheel, found {wheels}"
    return wheels[0]


@pytest.fixture(scope="module")
def built_wheel(tmp_path_factory: pytest.TempPathFactory) -> Path:
    available, reason = _packaging_tools_available()
    if not available:
        _skip_or_fail_unavailable(reason)
    return _build_wheel(tmp_path_factory.mktemp("wheel-out"))


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
        env={**os.environ, "PIP_DISABLE_PIP_VERSION_CHECK": "1"},
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


def test_packaging_tools_available_checks_setuptools_version(monkeypatch) -> None:
    from importlib import metadata

    need = _required_setuptools()
    assert need, "could not parse setuptools requirement from pyproject.toml"

    def fake(setuptools_version: str):
        return lambda d: setuptools_version if d == "setuptools" else "1.0"

    monkeypatch.setattr(metadata, "version", fake("1.0"))
    ok, reason = _packaging_tools_available()
    assert not ok and "older than" in reason and f">={need}" in reason

    monkeypatch.setattr(metadata, "version", fake(need))
    assert _packaging_tools_available() == (True, "")

    monkeypatch.delenv("CI", raising=False)
    with pytest.raises(pytest.skip.Exception):
        _skip_or_fail_unavailable(reason)
    monkeypatch.setenv("CI", "1")
    with pytest.raises(pytest.fail.Exception):
        _skip_or_fail_unavailable(reason)
