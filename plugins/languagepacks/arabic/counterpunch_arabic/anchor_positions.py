"""Anchor placement for the Arabic pack. Same metrics as Latin, plus i'jam anchors.

Each definition is a ``(vertical, horizontal)`` pair. Tokens may be wrapped in
arithmetic, for example ``"right - 0.05 * width"``.
"""

from __future__ import annotations

import ast
import math
from typing import Mapping

BASE_ANCHORS: dict[str, tuple[str, str]] = {
    "top": ("top", "center"),
    "bottom": ("baseline", "center"),
    "center": ("middle", "center"),
    "ogonek": ("baseline", "right"),
    "topright": ("top", "right"),
    "gaf": ("top", "center"),
    "ring": ("middle", "center"),
    "tail": ("baseline", "right"),
}

MARK_ANCHORS: dict[str, tuple[str, str]] = {
    "_top": ("xheight", "center"),
    "top": ("bbox_top", "center"),
    "_bottom": ("baseline", "center"),
    "bottom": ("bbox_bottom", "center"),
    "_center": ("middle", "center"),
    "_ogonek": ("baseline", "right"),
    "_topright": ("xheight", "left"),
    "_gaf": ("xheight", "center"),
    "_ring": ("middle", "center"),
    "_tail": ("baseline", "right"),
}

DEFINED_ANCHOR_NAMES = frozenset(BASE_ANCHORS) | frozenset(MARK_ANCHORS)

_ALLOWED_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.Constant,
    ast.Name,
    ast.Load,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.USub,
    ast.UAdd,
)


def evaluate_expression(expression: str, variables: Mapping[str, float]) -> float:
    """Evaluate a placement expression. Only names, numbers, and + - * / are allowed."""
    tree = ast.parse(expression, mode="eval")
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ValueError(f"Unsupported expression: {expression}")
        if isinstance(node, ast.Name) and node.id not in variables:
            raise ValueError(f"Unknown token {node.id} in {expression}")

    def walk(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return walk(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return float(node.value)
        if isinstance(node, ast.Name):
            return float(variables[node.id])
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = walk(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        if isinstance(node, ast.BinOp) and isinstance(
            node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div)
        ):
            left = walk(node.left)
            right = walk(node.right)
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            return left / right
        raise ValueError(f"Unsupported expression: {expression}")

    return walk(tree)


def position_anchor(
    name: str,
    role: str,
    metrics: Mapping[str, float],
    width: float,
    bbox: tuple[float, float, float, float] | None,
    band: str | None = None,
) -> tuple[float, float] | None:
    """Return ``(x, y)`` for one anchor, or ``None`` when the name is undefined."""
    table = MARK_ANCHORS if role == "mark" else BASE_ANCHORS
    definition = table.get(name)
    if definition is None:
        return None
    vertical, horizontal = definition
    case_height = _case_height(role, metrics)
    bounds = bbox if bbox is not None else _imaginary_bounds(role, width, metrics, case_height, band)
    left, bottom, right, top = bounds
    top_y = _resolve_top(role, case_height, metrics, bbox, top)
    variables = {
        "left": left,
        "right": right,
        "center": (left + right) / 2,
        "width": width,
        "top": top_y,
        "middle": case_height / 2,
        "baseline": 0.0,
        "bbox_top": top,
        "bbox_bottom": bottom,
        "xheight": float(metrics.get("xheight") or 0),
        "capheight": float(metrics.get("capheight") or 0),
        "ascender": float(metrics.get("ascender") or 0),
        "descender": float(metrics.get("descender") or 0),
        "upm": float(metrics.get("upm") or 0),
    }
    x = evaluate_expression(horizontal, variables)
    y = evaluate_expression(vertical, variables)
    angle = float(metrics.get("italic_angle") or 0)
    if angle:
        mid_y = (bottom + top) / 2
        x += math.tan(math.radians(angle)) * (y - mid_y)
    return (x, y)


def _case_height(role: str, metrics: Mapping[str, float]) -> float:
    if role == "lower":
        return float(metrics.get("xheight") or 0)
    return float(metrics.get("capheight") or metrics.get("xheight") or 0)


def _resolve_top(
    role: str,
    case_height: float,
    metrics: Mapping[str, float],
    bbox: tuple[float, float, float, float] | None,
    bounds_top: float,
) -> float:
    if role == "mark" or bbox is None:
        return case_height
    ascender = float(metrics.get("ascender") or case_height)
    xheight = float(metrics.get("xheight") or case_height)
    clearance = 0.25 * (ascender - xheight)
    if bbox[3] > case_height + clearance:
        return bounds_top
    return case_height


def _imaginary_bounds(
    role: str,
    width: float,
    metrics: Mapping[str, float],
    case_height: float,
    band: str | None,
) -> tuple[float, float, float, float]:
    xheight = float(metrics.get("xheight") or 0)
    capheight = float(metrics.get("capheight") or xheight)
    descender = float(metrics.get("descender") or 0)
    if role == "mark" and band == "above":
        return (0.0, xheight, width, capheight)
    if role == "mark" and band == "below":
        return (0.0, descender / 2, width, 0.0)
    if role == "mark" and band == "overlay":
        return (0.0, case_height * 0.25, width, case_height * 0.75)
    return (0.0, 0.0, width, case_height)
