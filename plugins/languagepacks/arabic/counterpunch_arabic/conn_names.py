"""Parse ``.conn-<id>-<step>`` glyph names. No catalog of connection ids."""

from __future__ import annotations

import re

_CONN = re.compile(
    r"^(?P<source>.+)\.conn-(?P<id>[A-Za-z0-9]+)-(?P<step>[0-9]+)$"
)


def parse_conn_name(name: str) -> tuple[str, str, int] | None:
    match = _CONN.match(name)
    if not match:
        return None
    return match.group("source"), match.group("id"), int(match.group("step"))


def class_name(conn_id: str, step: int, side: str) -> str:
    return f"conn_{conn_id}_{step}_{side}"


def target_name(source: str, conn_id: str, step: int) -> str:
    return f"{source}.conn-{conn_id}-{step}"
