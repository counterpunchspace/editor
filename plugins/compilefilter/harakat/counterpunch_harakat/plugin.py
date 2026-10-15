"""Compile-only Harakat filter.

Composites raise a stored or inherited ``top`` anchor. A ccmp chain keeps the
dot, and the vowel mark that follows that chain is raised with mkmk.
"""

import re

GUIDE_NAME = "min_top_harakat"
SETTING_ID = "minimum_by_master"
# Same vowel marks the Arabic language pack lists as "marks", not "dots".
# Dots are unencoded ijam and must not be in this set.
_VOWEL_CODEPOINTS = set(range(0x064B, 0x0656)) | {0x065A, 0x065B, 0x0670}
_SUB_BY = re.compile(r"^sub\s+(.+?)\s+by\s+(.+?);?\s*$")


class Harakat:
    id = "harakat"
    name = "Harakat"
    description = (
        "Raises Arabic vowel marks so matching marks share a vertical center. "
        "A guideline on each master keeps that center from sitting lower. "
        "Dots stay in place."
    )

    def setup(self, font):
        settings = _settings(font)
        default_y = float(font.upm) / 2.0
        changed = False
        for master in list(font.masters or []):
            master_id = str(master.id)
            if master_id in settings and settings[master_id] is not None:
                target = float(settings[master_id])
            else:
                target = default_y
                settings[master_id] = target
                changed = True
            guide = _named_guide(master)
            if guide is None:
                master.addGuide({"x": 0, "y": target, "angle": 0}, GUIDE_NAME)
            else:
                guide.pos.y = target
        if changed:
            font.setPluginSetting(
                self.id,
                SETTING_ID,
                {str(key): float(value) for key, value in settings.items()},
            )
        return {str(key): float(value) for key, value in settings.items()}

    def takedown(self, font):
        for master in list(font.masters or []):
            guides = list(master.guides or [])
            for index in range(len(guides) - 1, -1, -1):
                if guides[index].name == GUIDE_NAME:
                    master.removeGuide(index)

    def onGuideChange(self, font, change):
        if not isinstance(change, dict):
            return
        if change.get("kind") != "position" or change.get("scope") != "master":
            return
        if change.get("name") != GUIDE_NAME:
            return
        master_id = change.get("masterId")
        pos = change.get("pos") or {}
        if master_id is None or pos.get("y") is None:
            return
        settings = _settings(font)
        settings[str(master_id)] = float(pos["y"])
        font.setPluginSetting(self.id, SETTING_ID, settings)

    def filter_font_json(self, font, ctx):
        marks = _above_mark_names(font)
        if not marks:
            return None
        glyphs = _glyph_index(font)
        present = {
            name
            for name, glyph in glyphs.items()
            if not glyph.get("boundsOnly")
        }
        locations = _master_locations(font, ctx)
        if not locations:
            return None
        masters = _master_locations_by_id(font)
        offsets = _ink_offsets(font, marks, locations, glyphs, masters)
        tallest = _tallest_offsets(offsets)

        sequences = []
        for _shell, parts in _ccmp_rules(font).items():
            if parts and all(part in present for part in parts):
                sequences.append(parts)
        shells = set(_ccmp_rules(font))
        for name in _bare_base_names(font):
            if name in present and name not in shells:
                sequences.append([name])

        # The overlay runs after fontc's mark and mkmk lookups, so the first
        # vowel's ``_top`` already sits on the propagated top of its context.
        # The shared center line is the guideline plus the highest ink-center
        # offset. A vowel is lifted as soon as that line passes its own
        # center, even when ``_top`` is still above the guideline. Later
        # vowels are not matched, so they keep their place in the stack. A
        # named lookup must not be declared here: inside a feature block it
        # would apply to every vowel.
        lines = ["lookupflag 0;"]
        for parts in sequences:
            gaps = []
            for location, minimum in locations:
                propagated = _propagated_top(
                    font, parts, location, glyphs, masters
                )
                if propagated is None:
                    gaps = []
                    break
                gaps.append(minimum - propagated)
            if not gaps:
                continue
            context = " ".join(parts)
            for mark in marks:
                if mark not in present:
                    continue
                mark_offsets = offsets.get(mark)
                combined = []
                for index, gap in enumerate(gaps):
                    center = mark_offsets[index] if mark_offsets is not None else 0.0
                    reference = (
                        tallest[index]
                        if tallest and mark_offsets is not None
                        else center
                    )
                    combined.append(max(0.0, gap + reference - center))
                scalar = _variable_scalar(locations, combined, font.get("axes") or [])
                if scalar is None:
                    continue
                lines.append(f"pos {context} {mark}' <0 {scalar} 0 0>;")
        if len(lines) == 1:
            return None
        return {"features": "\n".join(lines)}


def _as_dict(value):
    if isinstance(value, dict):
        return dict(value)
    if value is None:
        return {}
    try:
        return {str(key): item for key, item in dict(value).items()}
    except Exception:
        return {}


def _settings(font):
    return _as_dict(font.getPluginSetting(Harakat.id, SETTING_ID))


def _named_guide(master):
    for guide in list(master.guides or []):
        if guide.name == GUIDE_NAME:
            return guide
    return None


def _by_master(ctx):
    settings = (ctx or {}).get("settings") or {}
    if not isinstance(settings, dict):
        return {}
    stored = settings.get(SETTING_ID)
    if isinstance(stored, dict):
        return stored
    return settings


def _minimum(ctx, master_id):
    settings = _by_master(ctx)
    if master_id not in settings or settings.get(master_id) is None:
        return None
    return float(settings[master_id])


def _default_master_id(font):
    masters = font.get("masters") or []
    return masters[0].get("id") if masters else None


def _master_locations(font, ctx):
    masters = font.get("masters") or []
    default_master = _default_master_id(font)
    default_minimum = _minimum(ctx, default_master)
    if default_minimum is None:
        default_minimum = float(font.get("upm") or 1000) / 2.0
    locations = []
    for master in masters:
        minimum = _minimum(ctx, master.get("id"))
        if minimum is None and master.get("id") == default_master:
            minimum = default_minimum
        if minimum is None:
            continue
        locations.append((master.get("location") or {}, minimum))
    return locations


def _bare_base_names(font):
    names = []
    for glyph in font.get("glyphs") or []:
        if not isinstance(glyph, dict):
            continue
        name = glyph.get("name")
        if not name or _is_vowel_mark(glyph):
            continue
        if _has_anchor(glyph, "top") or _has_components(glyph):
            names.append(str(name))
    return names


def _above_mark_names(font):
    names = []
    for glyph in font.get("glyphs") or []:
        if not isinstance(glyph, dict):
            continue
        name = glyph.get("name")
        if not name or not _is_vowel_mark(glyph):
            continue
        names.append(str(name))
    return names


def _is_vowel_mark(glyph):
    """A harakat, not an ijam dot.

    The Arabic language pack calls encoded combining marks (fatha, sukun,
    shadda, …) "marks" and unencoded anchor-only marks "dots".
    """
    if not _has_anchor(glyph, "_top"):
        return False
    for codepoint in glyph.get("codepoints") or []:
        try:
            if int(codepoint) in _VOWEL_CODEPOINTS:
                return True
        except (TypeError, ValueError):
            continue
    return False


def _has_components(glyph):
    for layer in glyph.get("layers") or []:
        if _component_records(layer):
            return True
    return False


def _component_records(layer):
    records = []
    for item in (layer or {}).get("components") or []:
        if isinstance(item, str) and item:
            records.append({"reference": item, "matrix": None})
            continue
        if not isinstance(item, dict):
            continue
        reference = item.get("reference")
        if reference:
            records.append(
                {"reference": str(reference), "matrix": item.get("matrix")}
            )
    if records:
        return records
    for shape in (layer or {}).get("shapes") or []:
        if not isinstance(shape, dict):
            continue
        reference = shape.get("reference")
        transform = shape.get("transform")
        component = shape.get("Component")
        if not reference and isinstance(component, dict):
            reference = component.get("reference")
            transform = component.get("transform")
        if reference:
            records.append({"reference": str(reference), "matrix": transform})
    return records


def _apply_matrix(x, y, matrix):
    if not isinstance(matrix, (list, tuple)) or len(matrix) < 6:
        return x, y
    return (
        float(matrix[0]) * x + float(matrix[2]) * y + float(matrix[4]),
        float(matrix[1]) * x + float(matrix[3]) * y + float(matrix[5]),
    )


def _propagated_top(font, parts, location, glyphs, masters):
    """Attachment height of a shaped context.

    A ``ccmp`` context is several glyphs, and each glyph's anchors are
    composed in order. A component glyph is one shaped glyph: its
    components are already positioned by their transforms, and the last
    ``top`` wins, which is the same height the ``ccmp`` chain composes.
    """
    if len(parts) == 1:
        layer = _layer_for(font, parts[0], location, glyphs, masters)
        if layer is not None and _component_records(layer):
            return _component_top(
                font, parts[0], location, glyphs, masters, set()
            )
    return _resolved_top(font, parts, location, glyphs, masters)


def _component_top(font, name, location, glyphs, masters, seen):
    if name in seen:
        return None
    layer = _layer_for(font, name, location, glyphs, masters)
    if layer is None:
        return None
    records = _component_records(layer)
    if not records:
        top = _anchors(layer).get("top")
        return top[1] if top else None
    seen.add(name)
    available = {}
    for record in records:
        reference = record["reference"]
        nested = _component_top(font, reference, location, glyphs, masters, seen)
        anchors = _anchors(_layer_for(font, reference, location, glyphs, masters))
        if nested is not None and "top" not in anchors:
            anchors = {**anchors, "top": (0.0, nested)}
        for anchor_name, (x, y) in anchors.items():
            available[anchor_name] = _apply_matrix(x, y, record["matrix"])
    top = available.get("top")
    return top[1] if top else None


def _has_anchor(glyph, anchor_name):
    for layer in glyph.get("layers") or []:
        for anchor in (layer or {}).get("anchors") or []:
            if anchor.get("name") == anchor_name:
                return True
    return False


def _ccmp_rules(font):
    rules = {}
    for feature in (font.get("features") or {}).get("features") or []:
        if not isinstance(feature, (list, tuple)) or len(feature) < 2:
            continue
        tag, code = feature[0], feature[1]
        if tag != "ccmp":
            continue
        text = code.get("code") if isinstance(code, dict) else ""
        for line in (text or "").splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            match = _SUB_BY.match(stripped)
            if not match:
                continue
            left, right = match.group(1), match.group(2)
            shell = left.strip().split()[0]
            parts = [part for part in right.replace(";", "").split() if part]
            if shell and parts:
                rules[shell] = parts
    return rules


def _glyph_index(font):
    return {
        glyph.get("name"): glyph
        for glyph in font.get("glyphs") or []
        if isinstance(glyph, dict) and glyph.get("name")
    }


def _master_locations_by_id(font):
    return {
        master.get("id"): master.get("location") or {}
        for master in font.get("masters") or []
    }


def _layer_for(font, glyph_name, location, glyphs=None, masters=None):
    if glyphs is None:
        glyphs = _glyph_index(font)
    glyph = glyphs.get(glyph_name)
    if not glyph:
        return None
    if masters is None:
        masters = _master_locations_by_id(font)
    for layer in glyph.get("layers") or []:
        if layer.get("is_background"):
            continue
        layer_location = layer.get("location") or None
        if not layer_location:
            master = layer.get("master")
            master_id = master.get("master") if isinstance(master, dict) else None
            layer_location = masters.get(master_id) or {}
        if _locations_match(layer_location, location, font.get("axes") or []):
            return layer
    layers = glyph.get("layers") or []
    return layers[0] if layers else None


def _locations_match(left, right, axes):
    tags = {axis.get("tag") for axis in axes if axis.get("tag")}
    tags.update((left or {}).keys())
    tags.update((right or {}).keys())
    for tag in tags:
        if float((left or {}).get(tag) or 0) != float((right or {}).get(tag) or 0):
            return False
    return True


def _ink_offset(layer):
    """Ink center minus ``_top``. Missing bounds leave the mark out of alignment."""
    y_max = (layer or {}).get("yMax")
    y_min = (layer or {}).get("yMin")
    if y_max is None or y_min is None:
        return None
    anchors = _anchors(layer)
    top = anchors.get("_top")
    if top is None:
        return None
    return (float(y_min) + float(y_max)) / 2.0 - top[1]


def _ink_offsets(font, marks, locations, glyphs, masters):
    offsets = {}
    for name in marks:
        values = []
        for location, _minimum in locations:
            layer = _layer_for(font, name, location, glyphs, masters)
            offset = _ink_offset(layer) if layer is not None else None
            if offset is None:
                values = []
                break
            values.append(offset)
        if values:
            offsets[name] = values
    return offsets


def _tallest_offsets(offsets):
    if not offsets:
        return []
    count = len(next(iter(offsets.values())))
    return [
        max(values[index] for values in offsets.values())
        for index in range(count)
    ]


def _anchors(layer):
    found = {}
    for anchor in (layer or {}).get("anchors") or []:
        name = anchor.get("name")
        if name:
            found[name] = (float(anchor.get("x") or 0), float(anchor.get("y") or 0))
    return found


def _resolved_top(font, parts, location, glyphs=None, masters=None):
    available = {}
    for name in parts:
        layer = _layer_for(font, name, location, glyphs, masters)
        if layer is None:
            return None
        anchors = _anchors(layer)
        dx = dy = 0.0
        for anchor_name, (x, y) in anchors.items():
            if not str(anchor_name).startswith("_"):
                continue
            base = available.get(anchor_name[1:])
            if base is None:
                continue
            dx, dy = base[0] - x, base[1] - y
            break
        for anchor_name, (x, y) in anchors.items():
            if str(anchor_name).startswith("_"):
                continue
            available[anchor_name] = (x + dx, y + dy)
    top = available.get("top")
    return top[1] if top else None


def _format_number(value):
    if float(value).is_integer():
        return str(int(value))
    return str(value)


def _variable_scalar(locations, deltas, axes):
    """Y shift that puts the vowel ``_top`` on the guideline.

    ``deltas`` are ``guideline - attachment`` at each master, where
    attachment is the composed Y the vowel's ``_top`` locks onto. Knots
    sit on the axis map so the shift interpolates in the same design
    space as the anchors.
    """
    if not deltas or all(delta <= 0 for delta in deltas):
        return None
    if len(locations) == 1 or all(delta == deltas[0] for delta in deltas):
        return _format_number(deltas[0])
    axis = axes[0] if len(axes) == 1 else None
    mapping = (axis or {}).get("map") or []
    tag = (axis or {}).get("tag")
    if (
        tag
        and mapping
        and all(tag in (location or {}) for location, _minimum in locations)
    ):
        samples = sorted(
            (float((location or {}).get(tag) or 0), delta)
            for (location, _minimum), delta in zip(locations, deltas)
        )
        knots = []
        seen = set()
        for user, design in sorted(mapping, key=lambda item: float(item[0])):
            user = float(user)
            if user in seen:
                continue
            seen.add(user)
            knots.append((user, float(round(max(0.0, _interp(samples, float(design)))))))
        if all(value <= 0 for _user, value in knots):
            return None
        if all(value == knots[0][1] for _user, value in knots):
            return _format_number(knots[0][1])
        return (
            "("
            + " ".join(
                f"{tag}={_format_number(user)}:{_format_number(value)}"
                for user, value in knots
            )
            + ")"
        )
    pieces = []
    for (location, _minimum), delta in zip(locations, deltas):
        userspace = _userspace_location(location, axes)
        coords = ",".join(
            f"{axis_tag}={_format_number(value)}"
            for axis_tag, value in sorted(userspace.items())
        )
        pieces.append(f"{coords}:{_format_number(delta)}")
    return "(" + " ".join(pieces) + ")"


def _interp(samples, design):
    if design <= samples[0][0]:
        return samples[0][1]
    if design >= samples[-1][0]:
        return samples[-1][1]
    for (left, left_value), (right, right_value) in zip(samples, samples[1:]):
        if left <= design <= right:
            if right == left:
                return left_value
            ratio = (design - left) / (right - left)
            return left_value + ratio * (right_value - left_value)
    return samples[-1][1]


def _userspace_location(location, axes):
    by_tag = {axis.get("tag"): axis for axis in axes or [] if axis.get("tag")}
    return {
        tag: _design_to_user(by_tag.get(tag), value)
        for tag, value in (location or {}).items()
    }


def _design_to_user(axis, design):
    design = float(design)
    pairs = (axis or {}).get("map") or []
    if not pairs:
        return design
    points = sorted(
        (float(item[1]), float(item[0]))
        for item in pairs
        if isinstance(item, (list, tuple)) and len(item) >= 2
    )
    if not points:
        return design
    if design <= points[0][0]:
        return points[0][1]
    if design >= points[-1][0]:
        return points[-1][1]
    for (left_design, left_user), (right_design, right_user) in zip(
        points, points[1:]
    ):
        if left_design <= design <= right_design:
            if right_design == left_design:
                return left_user
            ratio = (design - left_design) / (right_design - left_design)
            return left_user + ratio * (right_user - left_user)
    return design
