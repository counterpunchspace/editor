import importlib.util
import sys
import types
import unittest
from pathlib import Path


class JsProxy:
    pass


class JsNull:
    pass


class JsUndefined:
    pass


class FakeConstructor:
    def __init__(self, name):
        self.name = name


class FakeJsBase(JsProxy):
    constructor_name = 'Object'

    def __init__(self):
        self.constructor = FakeConstructor(self.constructor_name)


class FakeJsArray(list, JsProxy):
    @property
    def length(self):
        return len(self)

    def to_py(self):
        return list(self)

    def splice(self, index, delete_count, *items):
        if index < 0:
            index = max(0, len(self) + index)
        removed = self[index : index + delete_count]
        self[index : index + delete_count] = list(items)
        return FakeJsArray(removed)


class FakeJsMap(JsProxy):
    constructor_name = 'Map'

    def __init__(self, entries=None):
        self.constructor = FakeConstructor(self.constructor_name)
        self._store = dict(entries or [])

    @property
    def size(self):
        return len(self._store)

    def has(self, key):
        return key in self._store

    def get(self, key):
        return self._store.get(key)

    def set(self, key, value):
        self._store[key] = value
        return self

    def delete(self, key):
        if key not in self._store:
            return False
        del self._store[key]
        return True

    def keys(self):
        return list(self._store.keys())


class FakeRecordStore:
    constructor_name = 'Proxy'

    def __init__(self, data=None):
        self.constructor = FakeConstructor(self.constructor_name)
        self._data = dict(data or {})

    def __str__(self):
        return '[object Object]'

    def __repr__(self):
        return '[object Object]'


class FakeJsObjectProxy(FakeRecordStore, JsProxy):
    def to_py(self):
        result = {}
        for key, item in self._data.items():
            if hasattr(item, 'to_py'):
                result[key] = item.to_py()
            else:
                result[key] = item
        return result


class FakeLiveRecord(FakeRecordStore):
    """A getLiveMutableValue-style Proxy that is not a Pyodide JsProxy."""


class FakeJsOpaqueObject(FakeJsObjectProxy):
    constructor_name = 'LiveMutableProxy'


class FakeAnchor(FakeJsBase):
    constructor_name = 'Anchor'

    def __init__(self, name):
        super().__init__()
        self.name = name


class FakeDrawing(FakeJsBase):
    constructor_name = 'Drawing'

    def __init__(self, allowed_items, initial_selection=None):
        super().__init__()
        self._allowed_items = list(allowed_items)
        self._selection = FakeJsArray(initial_selection or [])
        self.get_snapshot_calls = 0
        self.set_selection_calls = 0

    def _getSelectionSnapshotForPython(self):
        self.get_snapshot_calls += 1
        return FakeJsArray(self._selection)

    def _setSelectionFromPython(self, value):
        self.set_selection_calls += 1
        self.selection = value

    @property
    def selection(self):
        return FakeJsArray(self._selection)

    @selection.setter
    def selection(self, value):
        if isinstance(value, FakeJsArray):
            items = list(value)
        elif isinstance(value, list):
            items = list(value)
        else:
            items = [value]

        for item in items:
            if item not in self._allowed_items:
                raise ValueError('Drawing.selection can only contain objects from this drawing')

        self._selection = FakeJsArray(items)


class FakeStation(FakeJsBase):
    constructor_name = 'Station'

    def __init__(
        self,
        kerning,
        station_id='master-1',
        name=None,
        location=None,
        metrics=None,
    ):
        super().__init__()
        self.id = station_id
        self.kerning = kerning
        self.name = name if name is not None else FakeLiveRecord({'dflt': 'ExtraLight'})
        self.location = location if location is not None else FakeLiveRecord({'wght': 30})
        self.metrics = metrics if metrics is not None else FakeLiveRecord({'XHeight': 500})


class FakeGlyph(FakeJsBase):
    constructor_name = 'Glyph'

    def __init__(self, name, drawings, category='Base', glyph_data=None):
        super().__init__()
        self.name = name
        self.drawings = FakeJsArray(drawings)
        self.category = category
        self.glyphData = glyph_data if glyph_data is not None else JsNull()

    def addDrawing(self, *args):
        return None


class FakeFont(FakeJsBase):
    constructor_name = 'Font'

    def __init__(self, glyphs, stations):
        super().__init__()
        self.glyphs = FakeJsArray(glyphs)
        self.stations = FakeJsArray(stations)
        self.names = FakeLiveRecord(
            {'family_name': FakeLiveRecord({'dflt': 'Test Family'})}
        )

    def findGlyph(self, name):
        for glyph in self.glyphs:
            if glyph.name == name:
                return glyph
        return None

    def findStation(self, station_id):
        for station in self.stations:
            if station.id == station_id:
                return station
        return None


class FakeDrawingForStation(FakeJsBase):
    constructor_name = 'Drawing'

    def __init__(self, drawing_id, station=None):
        super().__init__()
        self.id = drawing_id
        self._station = station

    def getStation(self):
        return self._station

    def addAnchor(self, *args):
        return None


class FakeOutlineEditor(FakeJsBase):
    constructor_name = 'OutlineEditor'

    def __init__(self, active=False, stack_entries=None):
        super().__init__()
        self.active = active
        self._stack_entries = FakeJsArray(stack_entries or [])

    def parseGlyphStack(self):
        return FakeJsArray(self._stack_entries)


class FakeTextRunEditor(FakeJsBase):
    constructor_name = 'TextRunEditor'

    def __init__(self, selected_station_id=None):
        super().__init__()
        self.selectedStationId = selected_station_id


class FakeGlyphCanvas(FakeJsBase):
    constructor_name = 'GlyphCanvas'

    def __init__(self, outline_editor=None, text_run_editor=None):
        super().__init__()
        self.outlineEditor = outline_editor if outline_editor is not None else JsNull()
        self.textRunEditor = text_run_editor if text_run_editor is not None else JsNull()


class FakeHost(FakeJsBase):
    constructor_name = 'Window'

    def __init__(self, font_model=None, glyph_canvas=None):
        super().__init__()
        self.currentFontModel = font_model if font_model is not None else JsNull()
        self.glyphCanvas = glyph_canvas if glyph_canvas is not None else JsNull()


def _fake_has_own_property(obj, key):
    if isinstance(obj, FakeRecordStore):
        return str(key) in obj._data
    if isinstance(obj, dict):
        return str(key) in obj
    return hasattr(obj, str(key))


def _fake_to_string(value):
    if isinstance(value, FakeJsBase):
        # Model classes define Symbol.toStringTag; `constructor` may be mangled.
        return f'[object {value.constructor_name}]'
    if isinstance(value, FakeJsArray):
        return '[object Array]'
    if isinstance(value, FakeJsMap):
        return '[object Map]'
    if isinstance(value, FakeRecordStore):
        return '[object Object]'
    return '[object Object]'


def _fake_keys(obj):
    if isinstance(obj, FakeRecordStore):
        return FakeJsArray(list(obj._data.keys()))
    if isinstance(obj, dict):
        return FakeJsArray(list(obj.keys()))
    return FakeJsArray(
        [
            key
            for key in dir(obj)
            if not key.startswith('_') and not callable(getattr(obj, key))
        ]
    )


def _fake_reflect_get(target, key):
    if isinstance(target, (list, FakeJsArray)):
        return target[key]
    if isinstance(target, FakeRecordStore):
        return target._data[str(key)]
    if isinstance(target, dict):
        return target[str(key)]
    return getattr(target, str(key))


def _fake_reflect_set(target, key, value):
    if isinstance(target, (list, FakeJsArray)):
        if key == 'length':
            del target[value:]
            return True
        index = int(key)
        while len(target) <= index:
            target.append(None)
        target[index] = value
        return True
    if isinstance(target, FakeRecordStore):
        target._data[str(key)] = value
        return True
    if isinstance(target, dict):
        target[str(key)] = value
        return True
    setattr(target, str(key), value)
    return True


def _install_stub_modules():
    pyodide_module = types.ModuleType('pyodide')
    ffi_module = types.ModuleType('pyodide.ffi')
    ffi_module.JsProxy = JsProxy
    ffi_module.JsNull = JsNull
    ffi_module.JsUndefined = JsUndefined
    ffi_module.to_js = lambda value, dict_converter=None: FakeJsArray(value) if isinstance(value, (list, tuple)) else value
    pyodide_module.ffi = ffi_module
    sys.modules['pyodide'] = pyodide_module
    sys.modules['pyodide.ffi'] = ffi_module

    js_module = types.ModuleType('js')
    js_module.Array = types.SimpleNamespace(
        isArray=lambda value: isinstance(value, FakeJsArray),
        from_=lambda value: FakeJsArray(list(value)),
    )
    setattr(js_module.Array, 'from', js_module.Array.from_)
    js_module.Object = types.SimpleNamespace(
        prototype=types.SimpleNamespace(
            hasOwnProperty=types.SimpleNamespace(call=_fake_has_own_property),
            toString=types.SimpleNamespace(call=_fake_to_string),
        ),
        fromEntries=lambda entries: dict(entries),
        keys=_fake_keys,
    )
    js_module.Reflect = types.SimpleNamespace(
        get=_fake_reflect_get,
        set=_fake_reflect_set,
        has=lambda target, key: (
            str(key) in target._data
            if isinstance(target, FakeRecordStore)
            else str(key) in target
            if isinstance(target, dict)
            else hasattr(target, str(key))
        ),
    )
    js_module.Reflect.deleteProperty = lambda target, key: (
        target._data.pop(str(key), None) is not None
        if isinstance(target, FakeRecordStore)
        else target.pop(str(key), None) is not None
        if isinstance(target, dict)
        else False
    )

    def _fake_json_stringify(value):
        import json as json_module

        if isinstance(value, FakeRecordStore):
            if value._data.get('__empty_json__'):
                return '{}'
            return json_module.dumps(
                {
                    key: item
                    for key, item in value._data.items()
                    if key != '__empty_json__'
                }
            )
        if isinstance(value, dict):
            return json_module.dumps(value)
        raise TypeError('Cannot stringify value')

    js_module.JSON = types.SimpleNamespace(stringify=_fake_json_stringify)
    sys.modules['js'] = js_module


def _load_fonteditor_module():
    _install_stub_modules()

    module_path = Path(__file__).resolve().parents[2] / 'py' / 'fonteditor.py'
    spec = importlib.util.spec_from_file_location('fonteditor_under_test', module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FontEditorSelectionBridgeTest(unittest.TestCase):
    def setUp(self):
        self.fonteditor = _load_fonteditor_module()
        self.anchor_a = FakeAnchor('a')
        self.anchor_b = FakeAnchor('b')
        self.foreign_anchor = FakeAnchor('foreign')
        self.drawing = FakeDrawing([self.anchor_a, self.anchor_b], [self.anchor_a])
        self.drawing_proxy = self.fonteditor.ModelObjectProxy(self.drawing)

    def test_drawing_selection_proxy_reads_and_mutates_live_selection(self):
        selection = self.drawing_proxy.selection

        self.assertEqual(len(selection), 1)
        self.assertGreater(self.drawing.get_snapshot_calls, 0)
        self.assertEqual(selection[0]._js_obj, self.anchor_a)
        self.assertEqual([item._js_obj for item in list(selection)], [self.anchor_a])
        self.assertIn('<Anchor>', repr(selection))

        selection.append(self.fonteditor.ModelObjectProxy(self.anchor_b))
        self.assertGreater(self.drawing.set_selection_calls, 0)
        self.assertEqual(len(selection), 2)
        self.assertEqual([item._js_obj for item in selection], [self.anchor_a, self.anchor_b])

        del selection[0]
        self.assertEqual([item._js_obj for item in selection], [self.anchor_b])

        selection.insert(0, self.fonteditor.ModelObjectProxy(self.anchor_a))
        self.assertEqual([item._js_obj for item in selection], [self.anchor_a, self.anchor_b])

    def test_drawing_selection_assignment_supports_single_objects_and_validation(self):
        self.drawing_proxy.selection = self.fonteditor.ModelObjectProxy(self.anchor_b)
        self.assertEqual(
            [item._js_obj for item in self.drawing_proxy.selection],
            [self.anchor_b],
        )

        with self.assertRaises(ValueError):
            self.drawing_proxy.selection.append(
                self.fonteditor.ModelObjectProxy(self.foreign_anchor)
            )

    def test_station_kerning_map_is_wrapped_as_native_python_mapping(self):
        kerning_map = FakeJsMap(
            {
                'A:V': -80,
                '@Left:@Right': -120,
            }.items()
        )
        station_proxy = self.fonteditor.ModelObjectProxy(FakeStation(kerning_map))

        kerning = station_proxy.kerning

        self.assertIsInstance(kerning, self.fonteditor.MutableMapping)
        self.assertEqual(kerning['A:V'], -80)
        self.assertEqual(kerning['@Left:@Right'], -120)

        kerning['A:W'] = -70
        kerning['B:Y'] = -40

        self.assertEqual(kerning_map.get('A:W'), -70)
        self.assertEqual(kerning['B:Y'], -40)
        self.assertEqual(
            kerning.as_dict(),
            {
                'A:V': -80,
                '@Left:@Right': -120,
                'A:W': -70,
                'B:Y': -40,
            },
        )

    def test_station_kerning_proxy_object_is_wrapped_as_native_python_mapping(self):
        kerning_proxy = FakeJsObjectProxy({'@T:@A': -120, '@T:@O': -80})
        station_proxy = self.fonteditor.ModelObjectProxy(FakeStation(kerning_proxy))

        kerning = station_proxy.kerning

        self.assertIsInstance(kerning, self.fonteditor.MutableMapping)
        self.assertEqual(kerning['@T:@A'], -120)
        kerning['@T:@V'] = -140
        self.assertEqual(kerning_proxy._data['@T:@V'], -140)

    def test_station_returns_selected_text_mode_station(self):
        station = FakeStation({}, station_id='master-selected')
        font = FakeFont([], [station])
        host = FakeHost(
            font_model=font,
            glyph_canvas=FakeGlyphCanvas(
                outline_editor=FakeOutlineEditor(active=False),
                text_run_editor=FakeTextRunEditor('master-selected'),
            ),
        )
        self.fonteditor.js.window = host

        resolved = self.fonteditor.Station()

        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.id, 'master-selected')

    def test_station_returns_none_when_text_mode_location_is_not_a_station(self):
        station = FakeStation({}, station_id='master-selected')
        font = FakeFont([], [station])
        host = FakeHost(
            font_model=font,
            glyph_canvas=FakeGlyphCanvas(
                outline_editor=FakeOutlineEditor(active=False),
                text_run_editor=FakeTextRunEditor(None),
            ),
        )
        self.fonteditor.js.window = host

        self.assertIsNone(self.fonteditor.Station())

    def test_station_uses_active_drawing_station_in_edit_mode(self):
        selected_station = FakeStation({}, station_id='master-edit')
        active_drawing = FakeDrawingForStation('layer-1', selected_station)
        interpolated_drawing = FakeDrawingForStation('layer-2', None)
        glyph = FakeGlyph('A', [interpolated_drawing, active_drawing])
        font = FakeFont([glyph], [selected_station])
        host = FakeHost(
            font_model=font,
            glyph_canvas=FakeGlyphCanvas(
                outline_editor=FakeOutlineEditor(
                    active=True,
                    stack_entries=[types.SimpleNamespace(glyphName='A', layerId='layer-1')],
                ),
                text_run_editor=FakeTextRunEditor('other-master'),
            ),
        )
        self.fonteditor.js.window = host

        resolved = self.fonteditor.Station()

        self.assertIsNotNone(resolved)
        self.assertEqual(resolved.id, 'master-edit')

    def test_station_returns_none_for_interpolated_edit_drawing(self):
        selected_station = FakeStation({}, station_id='master-edit')
        interpolated_drawing = FakeDrawingForStation('layer-2', None)
        glyph = FakeGlyph('A', [interpolated_drawing])
        font = FakeFont([glyph], [selected_station])
        host = FakeHost(
            font_model=font,
            glyph_canvas=FakeGlyphCanvas(
                outline_editor=FakeOutlineEditor(
                    active=True,
                    stack_entries=[types.SimpleNamespace(glyphName='A', layerId='layer-2')],
                ),
                text_run_editor=FakeTextRunEditor('master-edit'),
            ),
        )
        self.fonteditor.js.window = host

        self.assertIsNone(self.fonteditor.Station())

    def test_glyph_category_string_stays_a_python_string(self):
        glyph = FakeGlyph('A', [], category='Mark')
        proxy = self.fonteditor.ModelObjectProxy(glyph)

        self.assertEqual(proxy.category, 'Mark')
        proxy.category = 'Ligature'
        self.assertEqual(glyph.category, 'Ligature')

    def test_glyph_custom_category_is_wrapped_as_native_python_mapping(self):
        category = FakeJsOpaqueObject({'Custom': 'Letter'})
        glyph = FakeGlyph('custom', [], category=category)
        proxy = self.fonteditor.ModelObjectProxy(glyph)

        wrapped = proxy.category
        self.assertEqual(wrapped, {'Custom': 'Letter'})
        self.assertNotIn('[object Object]', repr(wrapped))

    def test_glyph_data_is_wrapped_as_native_python_mapping(self):
        glyph_data = FakeJsOpaqueObject(
            {
                'glyph_name': 'A',
                'script': 'Latn',
                'character': 'A',
            }
        )
        glyph = FakeGlyph('A', [], glyph_data=glyph_data)
        proxy = self.fonteditor.ModelObjectProxy(glyph)

        wrapped = proxy.glyphData
        self.assertEqual(
            wrapped,
            {
                'glyph_name': 'A',
                'script': 'Latn',
                'character': 'A',
            },
        )
        self.assertEqual(wrapped['script'], 'Latn')
        self.assertNotIn('[object Object]', repr(wrapped))

    def test_glyph_data_prefers_to_py_when_json_stringify_is_empty(self):
        glyph_data = FakeJsOpaqueObject(
            {
                '__empty_json__': True,
                'glyph_name': 'A',
                'script': 'Latn',
            }
        )
        glyph = FakeGlyph('A', [], glyph_data=glyph_data)
        proxy = self.fonteditor.ModelObjectProxy(glyph)

        wrapped = proxy.glyphData
        self.assertEqual(wrapped['script'], 'Latn')
        self.assertEqual(wrapped['glyph_name'], 'A')

    def test_glyph_helper_converts_fields_when_js_constructor_is_proxy(self):
        glyph = FakeGlyph(
            'A',
            [],
            category=FakeJsOpaqueObject({'Custom': 'Letter'}),
            glyph_data=FakeJsOpaqueObject({'script': 'Latn'}),
        )
        glyph.constructor = FakeConstructor('Proxy')
        font = FakeFont([glyph], [])
        font.constructor = FakeConstructor('Proxy')
        host = FakeHost(
            font_model=font,
            glyph_canvas=FakeGlyphCanvas(
                outline_editor=FakeOutlineEditor(
                    active=True,
                    stack_entries=[
                        types.SimpleNamespace(glyphName='A', layerId='layer-1')
                    ],
                ),
            ),
        )
        self.fonteditor.js.window = host

        resolved = self.fonteditor.Glyph()

        self.assertIsInstance(resolved, self.fonteditor.ModelObjectProxy)
        self.assertEqual(resolved.category, {'Custom': 'Letter'})
        self.assertEqual(resolved.glyphData['script'], 'Latn')
        self.assertNotIn('[object Object]', repr(resolved.category))
        self.assertNotIn('[object Object]', repr(resolved.glyphData))

    def test_proxy_constructed_drawing_exposes_anchors(self):
        drawing = FakeDrawingForStation('drawing-1')
        drawing.constructor = FakeConstructor('Proxy')
        drawing.anchors = FakeJsArray([self.anchor_a])
        proxy = self.fonteditor._wrap_js_value(drawing)

        self.assertIsInstance(proxy, self.fonteditor.ModelObjectProxy)
        self.assertEqual(len(proxy.anchors), 1)
        self.assertEqual(proxy.anchors[0]._js_obj, self.anchor_a)

    def test_classify_filter_glyphs_reads_anchors_on_proxy_glyph(self):
        drawing = FakeDrawingForStation('drawing-1')
        drawing.constructor = FakeConstructor('Proxy')
        drawing.anchors = FakeJsArray([])
        glyph = FakeGlyph('A', [drawing])
        glyph.constructor = FakeConstructor('Proxy')

        seen = []

        def classify_glyph(wrapped_glyph):
            seen.append(list(wrapped_glyph.anchors or []))
            if wrapped_glyph.anchors:
                return False
            return True

        results = self.fonteditor._cp_classify_filter_glyphs(
            [glyph], classify_glyph
        )

        self.assertEqual(results, {'A': True})
        self.assertEqual(seen, [[]])
        self.assertIsInstance(
            self.fonteditor._as_model_proxy(glyph),
            self.fonteditor.ModelObjectProxy,
        )

    def test_station_live_proxy_records_are_python_mappings(self):
        station = FakeStation({})
        self.assertFalse(isinstance(station.name, JsProxy))
        self.assertEqual(str(station.name), '[object Object]')

        proxy = self.fonteditor.ModelObjectProxy(station)
        name = proxy.name
        location = proxy.location
        metrics = proxy.metrics

        self.assertIsInstance(name, self.fonteditor.LiveDictProxy)
        self.assertEqual(name.dflt, 'ExtraLight')
        name.dflt = 'Thin'
        self.assertEqual(station.name._data['dflt'], 'Thin')

        self.assertNotIn('[object Object]', repr(name))
        self.assertNotIn('[object Object]', str(name))
        self.assertEqual(name.to_py(), {'dflt': 'Thin'})
        self.assertIsInstance(name.to_py(), dict)

        self.assertEqual(location.wght, 30)
        self.assertNotIn('[object Object]', repr(location))
        self.assertEqual(location.to_py(), {'wght': 30})

        self.assertEqual(metrics.XHeight, 500)

        with self.assertRaises(TypeError) as raised:
            _ = station.name['dflt']
        self.assertNotIn('JsProxy', str(raised.exception))
        self.assertNotIn('pyodide', str(raised.exception).lower())

    def test_nested_font_names_are_python_mappings(self):
        font = FakeFont([], [])
        proxy = self.fonteditor.ModelObjectProxy(font)

        family_name = proxy.names.family_name
        self.assertEqual(family_name.dflt, 'Test Family')
        self.assertNotIn('[object Object]', repr(proxy.names))
        self.assertNotIn('[object Object]', repr(family_name))
        family_name.dflt = 'Renamed'
        self.assertEqual(font.names._data['family_name']._data['dflt'], 'Renamed')


class FakeMinifiedModelObject(FakeJsBase):
    """A model object from the minified bundle: mangled constructor name."""

    def __init__(self, class_name, **fields):
        self.constructor_name = class_name
        self.constructor = FakeConstructor('tn')
        for key, value in fields.items():
            setattr(self, key, value)

    def toString(self):
        return f'<{self.constructor_name}>'


class MinifiedModelObjectTest(unittest.TestCase):
    MODEL_CLASSES = (
        'Anchor',
        'Axis',
        'Component',
        'Drawing',
        'FeatureVariationGlyph',
        'Font',
        'Glyph',
        'Guide',
        'Instance',
        'Node',
        'Path',
        'Shape',
        'Station',
    )

    def setUp(self):
        self.fonteditor = _load_fonteditor_module()

    def test_every_model_class_wraps_as_model_object(self):
        for class_name in self.MODEL_CLASSES:
            with self.subTest(class_name=class_name):
                obj = FakeMinifiedModelObject(class_name, id='x')
                wrapped = self.fonteditor._wrap_js_value(obj)
                self.assertIsInstance(wrapped, self.fonteditor.ModelObjectProxy)
                self.assertEqual(repr(wrapped), f'<{class_name}>')

    def test_drawing_selection_yields_model_objects(self):
        anchor = FakeMinifiedModelObject('Anchor', name='bottom', x=283, y=0)
        component = FakeMinifiedModelObject('Component', reference='n')
        node = FakeMinifiedModelObject('Node', x=10, y=20)
        drawing = FakeDrawing([anchor, component, node], [anchor, component, node])
        drawing.constructor = FakeConstructor('on')

        selection = self.fonteditor._wrap_js_value(drawing).selection

        self.assertEqual(
            [type(item) for item in selection],
            [self.fonteditor.ModelObjectProxy] * 3,
        )
        self.assertEqual(repr(selection), '[<Anchor>, <Component>, <Node>]')
        self.assertEqual(selection[0].name, 'bottom')
        self.assertEqual(selection[1].reference, 'n')

    def test_model_lists_attributes_and_method_results_are_model_objects(self):
        node = FakeMinifiedModelObject('Node', x=1, y=2)
        path = FakeMinifiedModelObject('Path', nodes=FakeJsArray([node]))
        guide = FakeMinifiedModelObject('Guide', name='g')
        variation = FakeMinifiedModelObject('FeatureVariationGlyph', name='a')
        drawing = FakeMinifiedModelObject(
            'Drawing',
            paths=FakeJsArray([path]),
            guides=FakeJsArray([guide]),
            findGuide=lambda name: guide,
        )
        glyph = FakeMinifiedModelObject(
            'Glyph', drawings=FakeJsArray([drawing]), variations=FakeJsArray([variation])
        )

        proxy = self.fonteditor._wrap_js_value(glyph)
        wrapped_path = proxy.drawings[0].paths[0]

        self.assertIsInstance(wrapped_path, self.fonteditor.ModelObjectProxy)
        self.assertEqual(repr(wrapped_path.nodes), '[<Node>]')
        self.assertEqual(repr(proxy.drawings[0].guides), '[<Guide>]')
        self.assertEqual(repr(proxy.drawings[0].findGuide('g')), '<Guide>')
        self.assertEqual(repr(proxy.variations), '[<FeatureVariationGlyph>]')
        self.assertNotIn('_parentObject', repr(proxy.drawings))

    def test_to_py_lists_round_trip_back_to_js(self):
        node = FakeMinifiedModelObject('Node', x=1, y=2)
        path = FakeMinifiedModelObject('Path', nodes=FakeJsArray([node]))

        items = self.fonteditor._wrap_js_value(path).nodes.to_py()

        self.assertIsInstance(items[0], self.fonteditor.ModelObjectProxy)
        self.assertEqual(list(self.fonteditor._unwrap_py_value(items)), [node])


if __name__ == '__main__':
    unittest.main()