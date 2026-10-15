# Copyright (C) 2025 Yanone
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

"""
FontEditor Python Module
Core functionality for font editing operations
"""

from collections.abc import MutableMapping, MutableSequence
from keyword import iskeyword
import json

import js
import pyodide.ffi


_JS_UNDEFINED_TYPE = getattr(pyodide.ffi, 'JsUndefined', None)


_DICT_LIKE_FIELDS_BY_CLASS = {
    'Anchor': {'format_specific'},
    'Axis': {'name', 'format_specific'},
    'Component': {'location', 'format_specific', 'transform'},
    # Features.features is an array and is wrapped via _is_js_array -> LiveListProxy.
    'Features': {'classes', 'prefixes'},
    'Font': {
        'custom_ot_values',
        'features',
        'first_kern_groups',
        'format_specific',
        'names',
        'second_kern_groups',
        'variation_sequences',
    },
    'Glyph': set(),
    'Guide': {'color', 'format_specific', 'pos'},
    'Instance': {'custom_names', 'format_specific', 'location', 'name'},
    'Layer': {
        'color',
        'format_specific',
        'location',
        'master',
        'smart_component_location',
    },
    'Master': {
        # Pair maps keyed as "left:right" (glyph or @group names).
        'custom_ot_values',
        'format_specific',
        'kerning',
        'kerning_rtl',
        'location',
        'metrics',
        'name',
    },
    'Node': {'format_specific'},
    'Path': {'format_specific'},
    'Shape': set(),
}

# Object-valued fields that should wrap as live mappings even when Pyodide
# reports a Proxy constructor (for example Glyph.category's Custom object).
# Keep these out of _DICT_LIKE_FIELDS_BY_CLASS so string assignment still works
# for union types such as Glyph.category.
_WRAPPED_OBJECT_FIELDS_BY_CLASS = {
    'Glyph': {'category', 'glyphData'},
}
_SNAPSHOT_OBJECT_ATTRS = frozenset({'category', 'glyphData'})


def _is_js_null_or_undefined(value):
    if type(value) is pyodide.ffi.JsNull:
        return True
    if _JS_UNDEFINED_TYPE is not None and type(value) is _JS_UNDEFINED_TYPE:
        return True
    return False


def _get_constructor_name(value):
    try:
        return str(value.constructor.name)
    except Exception:
        return ''


def _has_js_callable(value, name):
    try:
        attr = getattr(value, name, None)
    except Exception:
        return False
    if attr is None or _is_js_null_or_undefined(attr):
        return False
    return _is_js_function(attr) or callable(attr)


def _infer_model_class_name(value):
    name = _get_constructor_name(value)
    if name in _DICT_LIKE_FIELDS_BY_CLASS:
        return name
    try:
        if _has_js_callable(value, 'findGlyph'):
            return 'Font'
        if _has_js_callable(value, 'addLayer'):
            return 'Glyph'
        if _has_js_callable(value, 'getMaster') or _has_js_callable(
            value, 'addAnchor'
        ):
            return 'Layer'
        if _has_js_callable(value, 'addGuide'):
            return 'Master'
        if _has_js_callable(value, 'addPath') and _has_js_callable(
            value, 'addComponent'
        ):
            return 'Layer'
    except Exception:
        pass
    return name


def _as_model_proxy(value):
    if value is None or _is_js_null_or_undefined(value):
        return None
    if isinstance(value, ModelObjectProxy):
        return value
    return ModelObjectProxy(_unwrap_py_value(value))


def _get_object_tag(value):
    try:
        return str(js.Object.prototype.toString.call(value))
    except Exception:
        return ''


def _is_js_function(value):
    if isinstance(
        value, (ModelObjectProxy, LiveDictProxy, LiveMapProxy, LiveListProxy)
    ):
        return False
    if isinstance(value, pyodide.ffi.JsProxy):
        try:
            return str(getattr(value, 'typeof', '')) == 'function'
        except Exception:
            return _get_object_tag(value) in (
                '[object Function]',
                '[object AsyncFunction]',
            )
    return callable(value)


def _is_plain_python_json_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _is_plain_python_json_value(item)
            for key, item in value.items()
        )
    if isinstance(value, (list, tuple)):
        return all(_is_plain_python_json_value(item) for item in value)
    return False


def _js_proxy_to_py_dict(value):
    candidates = []

    to_py = getattr(value, 'to_py', None)
    if to_py is not None:
        try:
            converted = to_py()
            if isinstance(converted, dict) and _is_plain_python_json_value(
                converted
            ):
                candidates.append(converted)
        except Exception:
            pass

    try:
        json_text = js.JSON.stringify(value)
        if json_text is not None and not _is_js_null_or_undefined(json_text):
            text = str(json_text)
            if text not in ('', 'null', 'undefined'):
                converted = json.loads(text)
                if isinstance(converted, dict):
                    candidates.append(converted)
    except Exception:
        pass

    try:
        keys = js.Object.keys(value).to_py()
        copied = {}
        for key in keys:
            item = _js_get(value, key)
            if _is_js_null_or_undefined(item):
                copied[key] = None
                continue
            nested = (
                _js_proxy_to_py_dict(item)
                if (_is_js_proxy_value(item) or _is_plain_js_object(item))
                and not _is_js_array(item)
                and not _is_js_function(item)
                else None
            )
            if nested is not None:
                copied[key] = nested
            elif _is_js_array(item) and hasattr(item, 'to_py'):
                copied[key] = item.to_py()
            else:
                copied[key] = item
        candidates.append(copied)
    except Exception:
        pass

    nonempty = [candidate for candidate in candidates if candidate]
    if nonempty:
        return max(nonempty, key=len)
    if candidates:
        return candidates[0]
    return None


def _is_js_array(value):
    try:
        if bool(js.Array.isArray(value)):
            return True
    except Exception:
        pass

    if _get_object_tag(value) == '[object Array]':
        return True

    return _get_constructor_name(value) == 'Array'


_PLAIN_JS_OBJECT_CONSTRUCTORS = frozenset(
    {'', 'Object', 'Proxy', 'LiveMutableProxy'}
)


def _is_js_proxy_value(value):
    try:
        if isinstance(value, pyodide.ffi.JsProxy):
            return True
    except TypeError:
        pass
    return False


def _is_python_scalar_or_container(value):
    return value is None or isinstance(
        value, (str, int, float, bool, dict, list, tuple, bytes)
    )


def _is_plain_js_object(value):
    if isinstance(
        value, (ModelObjectProxy, LiveDictProxy, LiveMapProxy, LiveListProxy)
    ):
        return False
    if _is_python_scalar_or_container(value):
        return False
    if _is_js_array(value):
        return False
    if _is_js_map(value):
        return False
    if _is_js_function(value):
        return False

    if _infer_model_class_name(value) in _DICT_LIKE_FIELDS_BY_CLASS:
        return False
    constructor_name = _get_constructor_name(value)
    if constructor_name not in _PLAIN_JS_OBJECT_CONSTRUCTORS:
        if _get_object_tag(value) != '[object Object]':
            return False

    try:
        js.Object.keys(value)
        return True
    except Exception:
        return False


def _is_js_map(value):
    if _is_python_scalar_or_container(value):
        return False
    if _get_constructor_name(value) == 'Map':
        return True
    return _get_object_tag(value) == '[object Map]'


def _unwrap_py_value(value):
    if isinstance(value, ModelObjectProxy):
        return value._js_obj
    if isinstance(value, LiveDictProxy):
        return value._js_obj
    if isinstance(value, LiveMapProxy):
        return value._js_map
    if isinstance(value, LiveListProxy):
        return value._js_array
    if isinstance(value, (dict, list, tuple)):
        return pyodide.ffi.to_js(
            value,
            dict_converter=js.Object.fromEntries,
        )
    return value


def _materialize_py_value(value):
    if isinstance(value, LiveDictProxy):
        return value.to_py()
    if isinstance(value, LiveMapProxy):
        return value.to_py()
    if isinstance(value, LiveListProxy):
        return value.to_py()
    if isinstance(value, ModelObjectProxy):
        return value._js_obj
    if _is_js_map(value) or _is_plain_js_object(value):
        wrapped = _wrap_js_value(value)
        if wrapped is not value and hasattr(wrapped, 'to_py'):
            return wrapped.to_py()
    return value


def _js_get(target, key):
    return js.Reflect.get(target, key)


def _js_set(target, key, value):
    js.Reflect.set(target, key, value)


def _js_has_property(target, key):
    try:
        return bool(js.Reflect.has(target, key))
    except Exception:
        try:
            return bool(
                js.Object.prototype.hasOwnProperty.call(target, key)
            )
        except Exception:
            return False


def _is_mapping_assignment_value(value):
    if isinstance(value, (LiveDictProxy, LiveMapProxy, ModelObjectProxy)):
        return True
    if isinstance(value, MutableMapping):
        return True
    if isinstance(value, pyodide.ffi.JsProxy) and (
        _is_plain_js_object(value) or _is_js_map(value)
    ):
        return True
    return False


def _wrap_js_value(value, owner_class_name=None, attr_name=None):
    if _is_js_null_or_undefined(value):
        return None

    if isinstance(value, (ModelObjectProxy, LiveDictProxy, LiveMapProxy, LiveListProxy)):
        return value

    if _is_js_array(value):
        return LiveListProxy(value)

    constructor_name = _infer_model_class_name(value)
    owner = owner_class_name or constructor_name
    dict_fields = _DICT_LIKE_FIELDS_BY_CLASS.get(owner, set())
    wrap_object_fields = _WRAPPED_OBJECT_FIELDS_BY_CLASS.get(owner, set())
    force_dict_wrap = bool(attr_name) and attr_name in dict_fields
    snapshot_object = bool(attr_name) and (
        attr_name in _SNAPSHOT_OBJECT_ATTRS or attr_name in wrap_object_fields
    )

    if snapshot_object and not _is_python_scalar_or_container(value):
        converted = _js_proxy_to_py_dict(value)
        if converted is not None:
            return converted

    if constructor_name in _DICT_LIKE_FIELDS_BY_CLASS:
        return ModelObjectProxy(value)

    if _is_js_map(value):
        return LiveMapProxy(value)

    if force_dict_wrap or _is_plain_js_object(value):
        return LiveDictProxy(value)

    return value


def _unwrap_layer_selection_value(value):
    if value is None:
        items = []
    elif isinstance(value, LayerSelectionProxy):
        items = [item for item in value]
    elif isinstance(value, LiveListProxy):
        items = [value[i] for i in range(len(value))]
    elif isinstance(value, pyodide.ffi.JsProxy) and _is_js_array(value):
        return value
    elif isinstance(value, (list, tuple)):
        items = list(value)
    else:
        items = [value]

    return pyodide.ffi.to_js(
        [_unwrap_py_value(item) for item in items],
        dict_converter=js.Object.fromEntries,
    )


class LiveDictProxy(MutableMapping):
    def __init__(self, js_obj):
        object.__setattr__(self, '_js_obj', js_obj)

    def _is_attr_key(self, name):
        return isinstance(name, str) and name.isidentifier() and not iskeyword(name)

    def __getitem__(self, key):
        key_string = str(key)
        if not _js_has_property(self._js_obj, key_string):
            raise KeyError(key)
        return _wrap_js_value(_js_get(self._js_obj, key_string))

    def __setitem__(self, key, value):
        key_string = str(key)

        key_exists = bool(
            js.Object.prototype.hasOwnProperty.call(self._js_obj, key_string)
        )
        if key_exists:
            existing = _js_get(self._js_obj, key_string)
            if _is_plain_js_object(existing) and not _is_mapping_assignment_value(value):
                value_type = type(value).__name__
                raise TypeError(
                    f"Cannot overwrite dictionary entry '{key_string}' with non-dictionary value ({value_type}). "
                    f"Use '{key_string}[\"dflt\"] = ...' for language values, or assign a full mapping like "
                    f"{key_string} = {{\"dflt\": ...}}."
                )

        _js_set(self._js_obj, key_string, _unwrap_py_value(value))

    def __delitem__(self, key):
        key_string = str(key)
        if not bool(js.Object.prototype.hasOwnProperty.call(self._js_obj, key_string)):
            raise KeyError(key)
        js.Reflect.deleteProperty(self._js_obj, key_string)

    def __iter__(self):
        keys = js.Object.keys(self._js_obj).to_py()
        return iter(keys)

    def __len__(self):
        return int(js.Object.keys(self._js_obj).length)

    def to_py(self):
        return {
            key: _materialize_py_value(self[key])
            for key in js.Object.keys(self._js_obj).to_py()
        }

    def as_dict(self):
        return self.to_py()

    def __repr__(self):
        return repr(self.to_py())

    def __str__(self):
        return self.__repr__()

    def __getattr__(self, name):
        if self._is_attr_key(name):
            try:
                return self[name]
            except KeyError as error:
                raise AttributeError(name) from error
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name.startswith('_'):
            object.__setattr__(self, name, value)
            return
        if self._is_attr_key(name):
            self[name] = value
            return
        object.__setattr__(self, name, value)

    def __delattr__(self, name):
        if self._is_attr_key(name):
            try:
                del self[name]
                return
            except KeyError as error:
                raise AttributeError(name) from error
        object.__delattr__(self, name)


class LiveMapProxy(MutableMapping):
    def __init__(self, js_map):
        object.__setattr__(self, '_js_map', js_map)

    def _is_attr_key(self, name):
        return isinstance(name, str) and name.isidentifier() and not iskeyword(name)

    def __getitem__(self, key):
        if not bool(self._js_map.has(key)):
            raise KeyError(key)
        return _wrap_js_value(self._js_map.get(key))

    def __setitem__(self, key, value):
        key_exists = bool(self._js_map.has(key))
        if key_exists:
            existing = self._js_map.get(key)
            if (_is_plain_js_object(existing) or _is_js_map(existing)) and not _is_mapping_assignment_value(value):
                value_type = type(value).__name__
                raise TypeError(
                    f"Cannot overwrite dictionary entry '{key}' with non-dictionary value ({value_type}). "
                    f"Use '{key}[\"dflt\"] = ...' for language values, or assign a full mapping like "
                    f"{key} = {{\"dflt\": ...}}."
                )

        self._js_map.set(key, _unwrap_py_value(value))

    def __delitem__(self, key):
        if not bool(self._js_map.delete(key)):
            raise KeyError(key)

    def __iter__(self):
        keys = getattr(js.Array, 'from')(self._js_map.keys()).to_py()
        return iter(keys)

    def __len__(self):
        return int(self._js_map.size)

    def to_py(self):
        return {key: _materialize_py_value(self[key]) for key in self}

    def as_dict(self):
        return self.to_py()

    def __repr__(self):
        return repr(self.to_py())

    def __str__(self):
        return self.__repr__()

    def __getattr__(self, name):
        if self._is_attr_key(name):
            try:
                return self[name]
            except KeyError as error:
                raise AttributeError(name) from error
        raise AttributeError(name)

    def __setattr__(self, name, value):
        if name.startswith('_'):
            object.__setattr__(self, name, value)
            return
        if self._is_attr_key(name):
            self[name] = value
            return
        object.__setattr__(self, name, value)

    def __delattr__(self, name):
        if self._is_attr_key(name):
            try:
                del self[name]
                return
            except KeyError as error:
                raise AttributeError(name) from error
        object.__delattr__(self, name)


class LiveListProxy(MutableSequence):
    def __init__(self, js_array):
        self._js_array = js_array

    def __len__(self):
        return int(self._js_array.length)

    def __getitem__(self, index):
        if isinstance(index, slice):
            start, stop, step = index.indices(len(self))
            return [self[i] for i in range(start, stop, step)]
        return _wrap_js_value(_js_get(self._js_array, index))

    def __setitem__(self, index, value):
        if isinstance(index, slice):
            raise TypeError('Slice assignment is not supported')
        _js_set(self._js_array, index, _unwrap_py_value(value))

    def __delitem__(self, index):
        self._js_array.splice(index, 1)

    def insert(self, index, value):
        self._js_array.splice(index, 0, _unwrap_py_value(value))

    def __iter__(self):
        for i in range(len(self)):
            yield self[i]

    def to_py(self):
        return [_materialize_py_value(item) for item in self]

    def __repr__(self):
        return repr(self.to_py())

    def __str__(self):
        return self.__repr__()


class LayerSelectionProxy:
    def __init__(self, layer_js_obj):
        self._layer_js_obj = layer_js_obj

    def _get_selection(self):
        getter = getattr(self._layer_js_obj, '_getSelectionSnapshotForPython', None)
        if getter is not None:
            return getter()
        return getattr(self._layer_js_obj, 'selection')

    def _replace(self, items):
        setter = getattr(self._layer_js_obj, '_setSelectionFromPython', None)
        unwrapped_items = _unwrap_layer_selection_value(items)
        if setter is not None:
            setter(unwrapped_items)
            return
        setattr(self._layer_js_obj, 'selection', unwrapped_items)

    def __len__(self):
        return int(self._get_selection().length)

    def __getitem__(self, index):
        selection = self._get_selection()
        if isinstance(index, slice):
            start, stop, step = index.indices(len(self))
            return [self[i] for i in range(start, stop, step)]
        return _wrap_js_value(_js_get(selection, index))

    def __setitem__(self, index, value):
        current = self[:]
        if isinstance(index, slice):
            current[index] = list(value)
        else:
            current[index] = value
        self._replace(current)

    def __iter__(self):
        for i in range(len(self)):
            yield self[i]

    def __delitem__(self, index):
        current = self[:]
        del current[index]
        self._replace(current)

    def insert(self, index, value):
        current = self[:]
        current.insert(index, value)
        self._replace(current)

    def append(self, value):
        self.insert(len(self), value)

    def extend(self, values):
        current = self[:]
        current.extend(list(values))
        self._replace(current)

    def clear(self):
        self._replace([])

    def pop(self, index=-1):
        current = self[:]
        value = current.pop(index)
        self._replace(current)
        return value

    def remove(self, value):
        current = self[:]
        for index, item in enumerate(current):
            same_object = (
                item is value
                or (
                    isinstance(item, ModelObjectProxy)
                    and isinstance(value, ModelObjectProxy)
                    and item._js_obj is value._js_obj
                )
            )
            if same_object:
                del current[index]
                self._replace(current)
                return
        raise ValueError('LayerSelectionProxy.remove(x): x not in selection')

    def to_py(self):
        return list(self)

    def __repr__(self):
        return repr(list(self))

    def __str__(self):
        return self.__repr__()


class ModelObjectProxy:
    def __init__(self, js_obj):
        object.__setattr__(self, '_js_obj', js_obj)

    def __getattr__(self, name):
        owner_class_name = _infer_model_class_name(self._js_obj)
        if owner_class_name == 'Layer' and name == 'selection':
            return LayerSelectionProxy(self._js_obj)

        if owner_class_name == 'Glyph' and name == 'anchors':
            try:
                raw_anchors = getattr(self._js_obj, 'anchors', None)
            except AttributeError:
                raw_anchors = None
            if raw_anchors is not None and not _is_js_null_or_undefined(
                raw_anchors
            ):
                return _wrap_js_value(raw_anchors, owner_class_name, name)

            layers = _wrap_js_value(
                getattr(self._js_obj, 'layers', None), 'Glyph', 'layers'
            )
            collected = []
            if layers:
                for layer in layers:
                    layer_anchors = getattr(layer, 'anchors', None)
                    if layer_anchors:
                        collected.extend(list(layer_anchors))
            return collected

        raw = getattr(self._js_obj, name)
        if _is_js_function(raw):
            def method(*args, **kwargs):
                if kwargs:
                    raise TypeError('Keyword arguments are not supported')
                unwrapped = [_unwrap_py_value(arg) for arg in args]
                result = raw(*unwrapped)
                return _wrap_js_value(result)

            return method
        return _wrap_js_value(raw, owner_class_name, name)

    def __setattr__(self, name, value):
        owner_class_name = _infer_model_class_name(self._js_obj)
        if owner_class_name == 'Layer' and name == 'selection':
            setattr(self._js_obj, name, _unwrap_layer_selection_value(value))
            return

        dict_fields = _DICT_LIKE_FIELDS_BY_CLASS.get(owner_class_name, set())
        if name in dict_fields and not _is_mapping_assignment_value(value):
            value_type = type(value).__name__
            raise TypeError(
                f"Cannot assign non-dictionary value ({value_type}) to dict-like field "
                f"'{owner_class_name}.{name}'. Use key assignment (e.g. {name}[\"dflt\"] = ...), "
                f"or assign a full mapping."
            )
        setattr(self._js_obj, name, _unwrap_py_value(value))

    def __getitem__(self, key):
        owner_class_name = _infer_model_class_name(self._js_obj)
        if owner_class_name == 'Layer' and key == 'selection':
            return LayerSelectionProxy(self._js_obj)

        attr_name = key if isinstance(key, str) else None
        return _wrap_js_value(_js_get(self._js_obj, key), owner_class_name, attr_name)

    def __setitem__(self, key, value):
        if isinstance(key, str):
            self.__setattr__(key, value)
            return
        _js_set(self._js_obj, key, _unwrap_py_value(value))

    def __str__(self):
        return self.__repr__()

    def __repr__(self):
        try:
            text = str(self._js_obj.toString())
            if text and text != '[object Object]':
                return text
        except Exception:
            pass
        class_name = _get_constructor_name(self._js_obj)
        return f'<{class_name}>'


def _cp_get_host_object():
    if hasattr(js, 'window') and type(js.window) is not pyodide.ffi.JsNull:
        return js.window
    return js.self


def _cp_wrap_js_value(value):
    return _wrap_js_value(value)


def _cp_classify_filter_glyphs(glyphs, classify_fn, candidate_fn=None):
    """Classify a JS glyph list in one Python pass.

    Each glyph is wrapped with the live object model. Returns a dict of
    glyph name → classify_glyph result (or False when is_candidate rejects).
    """
    if not callable(classify_fn):
        raise ValueError('Missing classify_glyph(glyph).')

    results = {}
    for glyph in glyphs:
        wrapped = _as_model_proxy(glyph)
        name = getattr(wrapped, 'name', None)
        if not name:
            continue
        name = str(name)
        if candidate_fn is not None and candidate_fn(wrapped) is False:
            results[name] = False
            continue
        results[name] = classify_fn(wrapped)
    return results


def _cp_get_active_outline_editor():
    host = _cp_get_host_object()
    glyph_canvas = getattr(host, 'glyphCanvas', None)
    if _is_js_null_or_undefined(glyph_canvas):
        raise RuntimeError('Glyph canvas is not available')

    outline_editor = getattr(glyph_canvas, 'outlineEditor', None)
    if _is_js_null_or_undefined(outline_editor) or not bool(outline_editor.active):
        raise RuntimeError('No glyph is currently active in editing mode')

    return outline_editor


def _cp_get_active_stack_entry():
    outline_editor = _cp_get_active_outline_editor()
    parsed_stack = outline_editor.parseGlyphStack()
    if int(parsed_stack.length) == 0:
        raise RuntimeError('Active glyph stack is empty')

    return parsed_stack[int(parsed_stack.length) - 1]


def _cp_get_active_glyph_and_layer_ids():
    stack_entry = _cp_get_active_stack_entry()

    glyph_name = str(stack_entry.glyphName)
    if not glyph_name or glyph_name == 'undefined':
        raise RuntimeError('Active glyph is not available')

    layer_id = str(stack_entry.layerId)
    if not layer_id or layer_id == 'undefined':
        raise RuntimeError('Active layer is not available')

    return glyph_name, layer_id


def Font():
    """
    Get the currently active font.

    Returns:
        Font: The currently active context Font object

    Raises:
        RuntimeError: If no font is currently open

    Example:
        >>> font = Font()
        >>> print(font.info.familyName)
    """
    host = _cp_get_host_object()
    if type(host.currentFontModel) is pyodide.ffi.JsNull:
        raise RuntimeError("No font is currently open")
    return _as_model_proxy(host.currentFontModel)


def Glyph():
    """
    Get the currently active glyph in outline editing mode.

    Returns:
        Glyph: The live Glyph object from the current font model

    Raises:
        RuntimeError: If outline editing is inactive or the glyph cannot be resolved
    """
    glyph_name, _layer_id = _cp_get_active_glyph_and_layer_ids()
    glyph = Font().findGlyph(glyph_name)
    if glyph is None:
        raise RuntimeError(f'Active glyph "{glyph_name}" is not available')
    return _as_model_proxy(glyph)


def Layer():
    """
    Get the currently active layer in outline editing mode.

    Returns:
        Layer: The live Layer object from the current font model

    Raises:
        RuntimeError: If outline editing is inactive or the layer cannot be resolved
    """
    glyph_name, layer_id = _cp_get_active_glyph_and_layer_ids()
    glyph = Font().findGlyph(glyph_name)
    if glyph is None:
        raise RuntimeError(f'Active glyph "{glyph_name}" is not available')

    for layer in glyph.layers:
        if layer.id == layer_id:
            return layer

    raise RuntimeError(
        f'Active layer "{layer_id}" on glyph "{glyph_name}" is not available'
    )


def Master():
    """
    Get the currently selected master.

    In outline editing mode, the master is resolved from the active layer and
    returned only when that layer reflects a stored master. In text mode, the
    selected master is resolved from the text-run editor's selected master ID.

    Returns:
        Master | None: The selected live Master object, or None when the
        current designspace location does not correspond to a stored master.

    Raises:
        RuntimeError: If no font is currently open, or if outline editing is
        active but the active glyph/layer cannot be resolved.
    """
    host = _cp_get_host_object()
    glyph_canvas = getattr(host, 'glyphCanvas', None)
    outline_editor = getattr(glyph_canvas, 'outlineEditor', None)

    if not _is_js_null_or_undefined(outline_editor) and bool(outline_editor.active):
        layer = Layer()
        return layer.getMaster()

    text_run_editor = getattr(glyph_canvas, 'textRunEditor', None)
    if _is_js_null_or_undefined(text_run_editor):
        return None

    selected_master_id = getattr(text_run_editor, 'selectedMasterId', None)
    if _is_js_null_or_undefined(selected_master_id) or selected_master_id is None:
        return None

    selected_master_id = str(selected_master_id)
    if not selected_master_id or selected_master_id == 'undefined':
        return None

    return Font().findMaster(selected_master_id)


def Context():
    host = _cp_get_host_object()
    if not hasattr(host, 'sharedPluginContext'):
        return {}
    if _is_js_null_or_undefined(host.sharedPluginContext):
        return {}
    return _wrap_js_value(host.sharedPluginContext)


def SetContextPatch(patch):
    host = _cp_get_host_object()
    if hasattr(host, 'setPendingContextPatch'):
        host.setPendingContextPatch(_unwrap_py_value(patch))


def Notification(title, body=''):
    """Show an OS system notification.

    The first call may ask the browser for notification permission.
    Use this for a requested action finishing, not as automatic
    confirmation of routine edits.
    """
    host = _cp_get_host_object()
    if host is None or not hasattr(host, 'showSystemNotification'):
        raise RuntimeError('System notifications are not available')

    title_text = '' if title is None else str(title)
    body_text = '' if body is None else str(body)
    host.showSystemNotification(title_text, body_text)


_CP_COMPILE_FILTERS = {}
_CP_COMPILE_FILTER_GROUP = 'counterpunch_compilefilter_plugins'


def _cp_compile_filters_discover():
    """Load CompileFilter entry points and return their hook flags as JSON."""
    import sys
    from importlib.metadata import entry_points

    if sys.version_info >= (3, 10):
        found = entry_points(group=_CP_COMPILE_FILTER_GROUP)
    else:
        found = entry_points().get(_CP_COMPILE_FILTER_GROUP, [])

    described = []
    for entry in found:
        instance = entry.load()()
        plugin_id = getattr(instance, 'id', entry.name)
        _CP_COMPILE_FILTERS[plugin_id] = instance
        described.append({
            'id': plugin_id,
            'name': str(getattr(instance, 'name', '') or plugin_id),
            'description': str(getattr(instance, 'description', '') or ''),
            'hasLayer': callable(getattr(instance, 'filter_layer_json', None)),
            'hasPropagated': callable(
                getattr(instance, 'filter_layer_json_propagated_anchors', None)
            ),
            'hasFont': callable(getattr(instance, 'filter_font_json', None)),
            'hasSetup': callable(getattr(instance, 'setup', None)),
            'hasTakedown': callable(getattr(instance, 'takedown', None)),
            'hasGuide': callable(getattr(instance, 'onGuideChange', None)),
        })
    return json.dumps(described)


def _cp_compile_filter_setup(plugin_id):
    plugin = _CP_COMPILE_FILTERS.get(plugin_id)
    if plugin is None or not callable(getattr(plugin, 'setup', None)):
        return
    try:
        result = plugin.setup(Font())
        js.window.__cpCompileFilterSetupResult = json.dumps(result, default=str)
    except Exception:
        import traceback
        js.window.__cpCompileFilterError = traceback.format_exc()
        raise


def _cp_compile_filter_takedown(plugin_id):
    plugin = _CP_COMPILE_FILTERS.get(plugin_id)
    if plugin is None or not callable(getattr(plugin, 'takedown', None)):
        return
    plugin.takedown(Font())


def _cp_compile_filter_guide(plugin_id, change_json):
    plugin = _CP_COMPILE_FILTERS.get(plugin_id)
    if plugin is None or not callable(getattr(plugin, 'onGuideChange', None)):
        return False
    before = _materialize_py_value(
        Font().getPluginSetting(plugin_id, 'minimum_by_master')
    )
    plugin.onGuideChange(Font(), json.loads(change_json))
    after = _materialize_py_value(
        Font().getPluginSetting(plugin_id, 'minimum_by_master')
    )
    return json.dumps(before, default=str) != json.dumps(after, default=str)


def _cp_compile_filters_run(payload_json):
    """Run the JSON compile hooks. payload is {ids, font, layers:[{glyphName, layer}]}."""
    payload = json.loads(payload_json)
    plugins = [
        _CP_COMPILE_FILTERS[plugin_id]
        for plugin_id in payload.get('ids') or []
        if plugin_id in _CP_COMPILE_FILTERS
    ]
    font = payload.get('font') or {}
    replaced = {}
    needs_layers = any(
        callable(getattr(plugin, 'filter_layer_json', None))
        or callable(getattr(plugin, 'filter_layer_json_propagated_anchors', None))
        for plugin in plugins
    )
    if needs_layers:
        current_layers = {
            f"{item['glyphName']}\x1f{item['layer'].get('id') or ''}": item['layer']
            for item in payload.get('layers') or []
        }
        for item in payload.get('layers') or []:
            glyph_name = item['glyphName']
            working = json.loads(json.dumps(item['layer']))
            key = f"{glyph_name}\x1f{working.get('id') or ''}"
            for plugin in plugins:
                ctx = _cp_compile_filter_ctx(plugin, font, working)
                layer_fn = getattr(plugin, 'filter_layer_json', None)
                if callable(layer_fn):
                    updated = layer_fn(working, ctx)
                    if isinstance(updated, dict):
                        working = updated
                propagated = getattr(plugin, 'filter_layer_json_propagated_anchors', None)
                if callable(propagated):
                    inherited = item.get('inherited') or {}
                    anchors = working.setdefault('anchors', [])
                    names = {anchor.get('name') for anchor in anchors}
                    for name, point in inherited.items():
                        if name not in names and isinstance(point, dict):
                            anchors.append({
                                'name': name,
                                'x': point.get('x'),
                                'y': point.get('y'),
                            })
                            names.add(name)
                    updated = propagated(working, ctx)
                    if isinstance(updated, dict):
                        working = updated
            replaced[key] = working
            current_layers[key] = working

        compile_font = json.loads(json.dumps(font))
        for glyph in compile_font.get('glyphs') or []:
            layers = []
            for layer in glyph.get('layers') or []:
                key = f"{glyph.get('name')}\x1f{layer.get('id') or ''}"
                layers.append(current_layers.get(key, layer))
            glyph['layers'] = layers
    else:
        compile_font = font

    chunks = []
    for plugin in plugins:
        font_fn = getattr(plugin, 'filter_font_json', None)
        if not callable(font_fn):
            continue
        ctx = _cp_compile_filter_ctx(plugin, compile_font, {})
        result = font_fn(compile_font, ctx)
        if isinstance(result, dict) and isinstance(result.get('features'), str):
            chunks.append(result['features'])
    return json.dumps({'layers': replaced, 'features': '\n'.join(chunks)})


def _cp_plugin_settings_bag(format_specific):
    if not isinstance(format_specific, dict):
        return {}
    flat = format_specific.get('com.counterpunch.plugin-settings')
    if isinstance(flat, dict):
        return flat
    com = format_specific.get('com')
    if not isinstance(com, dict):
        return {}
    counterpunch = com.get('counterpunch')
    if not isinstance(counterpunch, dict):
        return {}
    nested = counterpunch.get('plugin-settings')
    return nested if isinstance(nested, dict) else {}


def _cp_compile_filter_ctx(plugin, font, layer):
    master = layer.get('master') if isinstance(layer, dict) else None
    master_id = master.get('master') if isinstance(master, dict) else None
    masters = font.get('masters') or []
    master_record = next((item for item in masters if item.get('id') == master_id), None)
    settings = _cp_plugin_settings_bag(font.get('format_specific') or {})
    values = (settings.get(getattr(plugin, 'id', ''), {}) or {}).get('values') or {}
    return {
        'master': master_record,
        'masterId': master_id,
        'axes': font.get('axes') or [],
        'settings': values,
    }

