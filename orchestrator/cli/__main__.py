"""`python3 -m orchestrator.cli` (the bridge's exact invocation, `python3 -m orchestrator.cli ...`)
runs the package as a script through this module, which just calls the real entry point in
`orchestrator/cli/__init__.py`.
"""
from . import main

if __name__ == '__main__':
    main()
