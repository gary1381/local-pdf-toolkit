"""Grounding extracted values: where in the PDF each value of a JSON document is.

pdf_extract gets a JSON Schema and the values an agent (or the client's model,
through MCP sampling) read from the document. Every leaf value is looked up in
the PDF: exactly (find-text: case and line breaks ignored), in the other ways
the same value is commonly written (1,234.50 / 1234.5; 2026-10-13 / October 13,
2026), or approximately (OCR'd text). The answer says, per field, whether it
was found, on which page, where (a box in points from the top-left, the units
of the other tools) and the text it matched.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher
from typing import Any

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
          "November", "December"]
ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
FUZZY_MIN = 0.85
MAX_LEAVES = 500


@dataclass
class Leaf:
    path: str
    value: Any
    schema: dict
    terms: list[str] = field(default_factory=list)


def _resolve(schema: dict, root: dict) -> dict:
    """Follow a local $ref (#/$defs/... or #/definitions/...)."""
    seen = 0
    while isinstance(schema, dict) and "$ref" in schema and seen < 20:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            return {}
        node: Any = root
        for part in ref[2:].split("/"):
            node = node.get(part.replace("~1", "/").replace("~0", "~"), {}) if isinstance(node, dict) else {}
        schema, seen = node, seen + 1
    return schema if isinstance(schema, dict) else {}


def leaves(value: Any, schema: dict, root: dict | None = None, path: str = "") -> list[Leaf]:
    """The scalar values of a JSON document, with the schema that describes each."""
    root = root if root is not None else schema
    schema = _resolve(schema, root)
    out: list[Leaf] = []
    if isinstance(value, dict):
        props = schema.get("properties", {}) if isinstance(schema.get("properties"), dict) else {}
        extra = schema.get("additionalProperties") if isinstance(schema.get("additionalProperties"), dict) else {}
        for key, item in value.items():
            out.extend(leaves(item, props.get(key, extra), root, f"{path}.{key}" if path else key))
    elif isinstance(value, list):
        items = schema.get("items", {}) if isinstance(schema.get("items"), dict) else {}
        for i, item in enumerate(value):
            out.extend(leaves(item, items, root, f"{path}[{i}]"))
    elif value is not None:
        out.append(Leaf(path or "$", value, schema))
    return out[:MAX_LEAVES]


def _number_forms(text: str) -> list[str]:
    """4500 -> 4500, 4,500, 4 500, 4.500, 4500.00, 4,500.00, 4.500,00 ...; 38.2 -> 38.2, 38.20 ..."""
    try:
        d = Decimal(text)
    except InvalidOperation:
        return [text]
    sign = "-" if d < 0 else ""
    d = abs(d)
    exp = max(0, -d.normalize().as_tuple().exponent)
    forms = {text}
    for places in {exp} | ({2} if exp <= 2 else set()):
        whole, _, dec = f"{d:.{places}f}".partition(".")
        grouped = f"{int(whole):,}"
        for digits, point in ((whole, "."), (grouped, "."), (grouped.replace(",", " "), "."),
                              (grouped.replace(",", " "), ","), (grouped.replace(",", "."), ",")):
            forms.add(sign + digits + (point + dec if dec else ""))
    return sorted(forms, key=len, reverse=True)


def _date_forms(y: int, m: int, d: int) -> list[str]:
    try:
        date(y, m, d)
    except ValueError:
        return []
    name, short = MONTHS[m - 1], MONTHS[m - 1][:3]
    return [
        f"{y:04d}-{m:02d}-{d:02d}", f"{name} {d}, {y}", f"{short} {d}, {y}", f"{short}. {d}, {y}",
        f"{d} {name} {y}", f"{d} {short} {y}", f"{m:02d}/{d:02d}/{y}", f"{m}/{d}/{y}", f"{d:02d}/{m:02d}/{y}",
        f"{d}/{m}/{y}", f"{d:02d}.{m:02d}.{y}", f"{y}/{m:02d}/{d:02d}", f"{y}年{m}月{d}日", f"{y}年{m:02d}月{d:02d}日",
        f"{m:02d}/{d:02d}/{y % 100:02d}", f"{d:02d}-{name[:3]}-{y}",
    ]


def search_terms(leaf: Leaf) -> list[str]:
    """The ways the value may be written in the document, most specific first."""
    v = leaf.value
    if isinstance(v, bool):
        return []
    if isinstance(v, (int, float)):
        return _number_forms(repr(v) if isinstance(v, float) else str(v))
    text = str(v).strip()
    if not text:
        return []
    if m := ISO_DATE.match(text):
        return list(dict.fromkeys(_date_forms(int(m[1]), int(m[2]), int(m[3])))) or [text]
    if NUMBER.match(text) and leaf.schema.get("type") in ("number", "integer"):
        return _number_forms(text)
    terms = [text]
    if len(text) > 120:
        # a long passage: its opening words locate it
        terms.append(" ".join(text.split()[:10]))
    return terms


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().casefold()


def label_words(path: str, schema: dict) -> set[str]:
    """Words of the field's name (invoice_number, dueDate) and title, to find its label on the page."""
    key = re.sub(r"\[\d+\]", "", path).split(".")[-1]
    words = re.sub(r"([a-z])([A-Z])", r"\1 \2", key).replace("_", " ").replace("-", " ").split()
    words += str(schema.get("title", "")).split()
    return {w.casefold() for w in words if len(w) >= 3}


def fuzzy_find(value: str, phrases: dict[int, list[dict]]) -> dict | None:
    """The phrase (or up to three phrases in a row) most like the value, when alike enough."""
    want = norm(value)
    if len(want) < 4:
        return None
    best = None
    for page, items in phrases.items():
        for i in range(len(items)):
            for span in (1, 2, 3):
                group = items[i:i + span]
                if len(group) < span:
                    break
                text = norm(" ".join(p["text"] for p in group))
                if len(text) < len(want) * 0.6:
                    continue
                matcher = SequenceMatcher(None, want, text, autojunk=False)
                found = sum(b.size for b in matcher.get_matching_blocks()) / len(want)
                if found >= FUZZY_MIN and (best is None or found > best[0]):
                    best = (found, page, group)
    if best is None:
        return None
    score, page, group = best
    x0 = min(p["x"] for p in group)
    y0 = min(p["y"] for p in group)
    x1 = max(p["x"] + p["width"] for p in group)
    y1 = max(p["y"] + p["height"] for p in group)
    return {"page": page, "box": {"x": round(x0, 2), "y": round(y0, 2), "width": round(x1 - x0, 2),
                                  "height": round(y1 - y0, 2)},
            "text": " ".join(p["text"] for p in group), "score": round(score, 2)}


def union(boxes: list[dict]) -> dict:
    x0 = min(b["x"] for b in boxes)
    y0 = min(b["y"] for b in boxes)
    x1 = max(b["x"] + b["width"] for b in boxes)
    y1 = max(b["y"] + b["height"] for b in boxes)
    return {"x": round(x0, 2), "y": round(y0, 2), "width": round(x1 - x0, 2), "height": round(y1 - y0, 2)}


def pick(candidates: list[dict], labels: list[dict], focus: dict[int, int]) -> dict:
    """The match next to the field's label (right of it or below), else on the page
    holding most of the other fields, else the first."""
    def score(c: dict) -> tuple:
        b = c["box"]
        near = [lab for lab in labels if lab["page"] == c["page"]]
        dist = min((abs(b["x"] - (lab["x"] + lab["width"])) * 0.5 + abs(b["y"] - lab["y"])
                    for lab in near if b["x"] >= lab["x"] - 2 and b["y"] >= lab["y"] - 4), default=1e9)
        return (dist, -focus.get(c["page"], 0), c["page"], b["y"], b["x"])
    return min(candidates, key=score)


def quote(page_phrases: list[dict], box: dict) -> str:
    """The line(s) of text around a match: what a person would read there."""
    mid = box["y"] + box["height"] / 2
    line = [p for p in page_phrases if p["y"] <= mid <= p["y"] + p["height"]]
    return " ".join(p["text"] for p in sorted(line, key=lambda p: p["x"]))[:300]
