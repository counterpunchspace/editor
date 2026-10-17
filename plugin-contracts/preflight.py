"""Dynamic plugin contract harness. Prints PROBE lines, then one JSON report."""

import importlib.metadata
import inspect
import json
import os
import sys
import traceback


def _emit(kind, name):
    print(f"PROBE {kind} {name}", flush=True)


def _callable_arity(fn):
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return None
    count = 0
    for param in sig.parameters.values():
        if param.kind in (
            inspect.Parameter.POSITIONAL_ONLY,
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
        ):
            if param.default is inspect.Parameter.empty:
                count += 1
    return count


def _check_surface(instance, spec, report):
    missing = []
    for item in spec.get("required", []):
        if not hasattr(instance, item["name"]):
            missing.append(item["name"])
            continue
        value = getattr(instance, item["name"])
        if item["kind"] == "method" and not callable(value):
            missing.append(item["name"])
        elif item["kind"] == "method":
            arity = _callable_arity(value)
            if arity is not None and arity > item.get("arity", 0):
                report["failures"].append(
                    f"{item['name']} needs {arity} arguments, contract allows {item.get('arity', 0)}"
                )
    one_of = spec.get("oneOf") or []
    if one_of and not any(callable(getattr(instance, name, None)) for name in one_of):
        missing.append("one of " + ", ".join(one_of))
    if missing:
        report["failures"].append("missing " + ", ".join(missing))
    return not missing


def _probe(instance, spec, fixtures, report):
    kind = spec["type"]
    try:
        if kind == "canvas":
            _emit("start", "canvas.draw")
            layer = fixtures["layer"]
            ctx = {"calls": []}

            class Ctx:
                def __getattr__(self, name):
                    def fn(*args, **kwargs):
                        ctx["calls"].append(name)
                        return None
                    return fn

            if callable(getattr(instance, "draw_above", None)):
                instance.draw_above(layer, Ctx())
            if callable(getattr(instance, "draw_below", None)):
                instance.draw_below(layer, Ctx())
            if callable(getattr(instance, "get_ui_elements", None)):
                instance.get_ui_elements()
            _emit("done", "canvas.draw")
        elif kind == "glyphfilter":
            _emit("start", "glyphfilter.filter")
            instance.visible()
            instance.filter(fixtures["glyphs"])
            events = getattr(instance, "event_types", [])
            if not isinstance(events, (list, tuple)):
                report["failures"].append("event_types must be a list")
            _emit("done", "glyphfilter.filter")
        elif kind == "character_set":
            _emit("start", "character_set.metadata")
            meta = instance.metadata()
            if not isinstance(meta, dict):
                report["failures"].append("metadata() must return a dict")
            instance.characters([], [])
            instance.members_by_set([], [])
            _emit("done", "character_set.metadata")
        elif kind == "compilefilter":
            _emit("start", "compilefilter.filter")
            layer = json.dumps(fixtures["layer"])
            if callable(getattr(instance, "filter_layer_json", None)):
                instance.filter_layer_json(layer)
            if callable(getattr(instance, "filter_layer_json_propagated_anchors", None)):
                instance.filter_layer_json_propagated_anchors(layer)
            if callable(getattr(instance, "filter_font_json", None)):
                instance.filter_font_json(layer)
            _emit("done", "compilefilter.filter")
        elif kind == "composition":
            _emit("start", "composition.recipe")
            instance.recipe(65, fixtures["lookups"])
            instance.anchors(65)
            _emit("done", "composition.recipe")
        elif kind == "feature":
            _emit("start", "feature.generate")
            instance.generate(fixtures["glyphs"])
            if not isinstance(getattr(instance, "EVENT_TYPES", None), (list, tuple)):
                report["failures"].append("EVENT_TYPES must be a list")
            if not isinstance(getattr(instance, "SETTINGS", None), (list, tuple, dict)):
                report["failures"].append("SETTINGS must be a list or dict")
            _emit("done", "feature.generate")
        elif kind == "font_destination":
            _emit("start", "font_destination.metadata")
            meta = instance.metadata()
            if not isinstance(meta, dict):
                report["failures"].append("metadata() must return a dict")
            else:
                dest = str(meta.get("destinationUrl") or "")
                origin = str(meta.get("targetOrigin") or "")
                if origin and not dest.startswith(origin):
                    report["failures"].append("destinationUrl origin must equal targetOrigin")
            _emit("done", "font_destination.metadata")
        else:
            report["failures"].append(f"unknown type {kind}")
    except Exception as exc:
        report["failures"].append(f"{kind} probe raised {exc}")
        report["trace"] = traceback.format_exc()[-4000:]


def run(manifest, contracts, fixtures):
    report = {
        "passed": False,
        "contractsSha256": contracts.get("sha256", ""),
        "checks": [],
        "failures": [],
    }
    by_type = {item["type"]: item for item in contracts["types"]}
    declared = manifest.get("plugins") or []
    if not declared:
        report["failures"].append("manifest has no plugins")
    for plugin in declared:
        spec = by_type.get(plugin.get("type"))
        if not spec:
            report["failures"].append(f"unknown type {plugin.get('type')}")
            continue
        expected = f"{spec['type']}:v{spec['contract']}"
        if plugin.get("contract") != expected:
            supported = [f"{spec['type']}:v{n}" for n in spec["editorSupports"]]
            if plugin.get("contract") not in supported:
                report["failures"].append(
                    f"{plugin.get('pluginId')} contract {plugin.get('contract')} not in {supported}"
                )
                continue
        group = spec["group"]
        name = plugin.get("entryPoint")
        _emit("start", f"import {name}")
        try:
            matches = [
                entry
                for entry in importlib.metadata.entry_points(group=group)
                if entry.name == name
            ]
            if not matches:
                report["failures"].append(f"entry point {group}:{name} not installed")
                continue
            instance = matches[0].load()()
        except Exception as exc:
            report["failures"].append(f"import {name} failed: {exc}")
            continue
        _emit("done", f"import {name}")
        if _check_surface(instance, spec, report):
            _probe(instance, spec, fixtures, report)
        report["checks"].append({"pluginId": plugin.get("pluginId"), "type": spec["type"]})
    report["passed"] = not report["failures"]
    return report


def main():
    root = os.path.dirname(os.path.abspath(__file__))
    job_path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PREFLIGHT_JOB")
    if not job_path:
        print(json.dumps({"passed": False, "failures": ["no job path"]}))
        return 2
    with open(job_path, "r", encoding="utf-8") as handle:
        job = json.load(handle)
    contracts_path = job.get("contractsPath") or os.path.join(root, "contracts.json")
    with open(contracts_path, "r", encoding="utf-8") as handle:
        contracts = json.load(handle)
    fixtures = {}
    fixture_dir = job.get("fixturesDir") or os.path.join(root, "fixtures")
    for name in ("layer", "glyphs", "lookups"):
        with open(os.path.join(fixture_dir, f"{name}.json"), "r", encoding="utf-8") as handle:
            fixtures[name] = json.load(handle)
    report = run(job["manifest"], contracts, fixtures)
    print("REPORT " + json.dumps(report), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
