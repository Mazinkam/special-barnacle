"""HTML rendering: serialize `dashboard_data.build_data`'s payload and splice it into the page.

The head/CSS/JS/tail markup lives in `dashboard_template.html` (package data, see
`pyproject.toml`), loaded lazily on first render rather than at import time — it is read once per
`render()` call, so a change to the template on disk (e.g. during development) takes effect on the
next render without restarting the process. The template is split on `_PLACEHOLDER`, which is not
valid JSON and appears nowhere else in the file, into the exact `(head, tail)` strings the old
`_HEAD`/`_TAIL` module constants held.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .. import records

_TEMPLATE_PATH = Path(__file__).with_name('dashboard_template.html')
#: Splice point for the JSON payload (`const D=<payload>`). Not valid JSON and not present
#: anywhere else in the template, so a single `str.split(..., 1)` finds exactly one boundary.
_PLACEHOLDER = '{{DASHBOARD_DATA}}'
_LONE_SURROGATE = re.compile('[\ud800-\udfff]')


def safe(data) -> str:
    """Embed `data` in HTML as JSON, with `NO_DATA` becoming `null`.

    `records.to_json` rewrites the sentinel throughout the nested structure and `json_default` is the
    backstop for anything a nested producer adds later, so a `NO_DATA` can never be silently coerced
    to `0` on its way to the browser — the whole point of having a sentinel.
    """
    payload = json.dumps(records.to_json(data), ensure_ascii=False, default=records.json_default)
    # Historical escaped lone surrogates must not break UTF-8 atomic publication.
    payload = payload.replace('</', '<\\/')
    return _LONE_SURROGATE.sub(lambda m: '\\u%04x' % ord(m.group()), payload)


def _load_template() -> tuple[str, str]:
    text = _TEMPLATE_PATH.read_text(encoding='utf-8')
    head, tail = text.split(_PLACEHOLDER, 1)
    return head, tail


def render(data: Any) -> tuple[str, str, str]:
    """The three chunks `publish.generate_dashboard` writes: head, the JSON payload, tail.

    Kept as three chunks rather than one concatenated string to avoid an extra copy of the payload.
    """
    head, tail = _load_template()
    return head, safe(data), tail
