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

import js
import pyodide.ffi
import builtins

# Store original print
_original_print = builtins.print

# Override print to force __str__ conversion
def print(*args, **kwargs):
    """Custom print that properly handles _BabelfontWrapper objects"""
    converted_args = []
    for arg in args:
        if isinstance(arg, _BabelfontWrapper):
            # Force string conversion via __str__
            converted_args.append(str(arg))
        else:
            converted_args.append(arg)
    return _original_print(*converted_args, **kwargs)

# Replace built-in print
builtins.print = print


class _BabelfontWrapper:
    """Generic wrapper to make babelfont objects print nicely in Python console"""
    __slots__ = ('__obj', '_repr_str')  # Use slots to control attribute access
    
    def __init__(self, obj):
        object.__setattr__(self, '_BabelfontWrapper__obj', obj)  # Name mangling to hide from Pyodide
        # Pre-compute the string representation
        object.__setattr__(self, '_repr_str', self._compute_repr())
    
    def _compute_repr(self):
        """Compute string representation by accessing JS _pyrepr getter property"""
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        try:
            # Try accessing _pyrepr property (not calling it - it's a getter)
            if hasattr(obj, '_pyrepr'):
                result = str(obj._pyrepr)  # Access as property, not method
                if result and result != '[object Object]':
                    return result
        except Exception as e:
            print(f"[FontEditor] Error accessing _pyrepr: {e}")
            import traceback
            traceback.print_exc()
        
        # Fallback to default representation
        return f'<{type(obj).__name__} at {hex(id(obj))}>'
    
    def __repr__(self):
        return self._repr_str
    
    def __str__(self):
        return self._repr_str
    
    def __format__(self, format_spec):
        """Format method - forces string representation"""
        return self._repr_str
    
    # Override the default string conversion that Pyodide console uses
    def _repr_mimebundle_(self, include=None, exclude=None):
        return {'text/plain': self._repr_str}
    
    # CRITICAL: Override toJs() to ensure proper representation when passed to JS
    def toJs(self):
        """When this Python object is converted to JavaScript, return a string representation"""
        return self._repr_str
    
    # Pyodide-specific: override __reduce__ to prevent introspection into _obj
    def __reduce__(self):
        """Prevent pickle from accessing _obj"""
        return (str, (self._repr_str,))
    
    def _should_wrap(self, obj):
        """Check if an object should be wrapped"""
        # Don't wrap None or primitives
        if obj is None:
            return False
        # Check if it has a toString method (indicating it's a babelfont object)
        try:
            return hasattr(obj, 'toString') and not callable(obj)
        except:
            return False
    
    def _wrap_method(self, method):
        """Wrap a method to auto-wrap its return value"""
        def wrapper(*args, **kwargs):
            result = method(*args, **kwargs)
            # Auto-wrap babelfont objects in the result
            if self._should_wrap(result):
                return _BabelfontWrapper(result)
            return result
        return wrapper
    
    def __getattr__(self, name):
        # Forward all attribute access to the wrapped object
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        result = getattr(obj, name)
        # If it's a callable (method/function), wrap it to auto-wrap return values
        if callable(result):
            return self._wrap_method(result)
        # Auto-wrap babelfont objects but not methods
        if self._should_wrap(result):
            return _BabelfontWrapper(result)
        return result
    
    def __setattr__(self, name, value):
        # Don't intercept setting of our internal slots
        if name in ('_BabelfontWrapper__obj', '_repr_str'):
            object.__setattr__(self, name, value)
            return
        
        # Forward all other attribute assignments to the wrapped object
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        # If the value is a wrapper, unwrap it first
        if isinstance(value, _BabelfontWrapper):
            value = object.__getattribute__(value, '_BabelfontWrapper__obj')
        setattr(obj, name, value)
    
    def __getitem__(self, key):
        # Forward indexing to the wrapped object
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        
        # Try different access methods for JsProxy objects
        try:
            # For numeric indices (arrays), convert to int
            if isinstance(key, int):
                result = obj[int(key)]
            # For string keys (objects/dicts), try attribute access first
            else:
                # Try bracket notation using js.Reflect
                result = js.Reflect.get(obj, key)
        except Exception as e:
            # Fallback to direct access
            try:
                result = obj[key]
            except:
                raise KeyError(f"Key {key!r} not found")
        
        # Auto-wrap babelfont objects but not methods
        if self._should_wrap(result):
            return _BabelfontWrapper(result)
        return result
    
    def __setitem__(self, key, value):
        # Forward item assignment to the wrapped object
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        # If the value is a wrapper, unwrap it first
        if isinstance(value, _BabelfontWrapper):
            value = object.__getattribute__(value, '_BabelfontWrapper__obj')
        
        # Use Reflect.set for proper JavaScript object property assignment
        try:
            js.Reflect.set(obj, key, value)
        except Exception:
            # Fallback to direct assignment
            obj[key] = value
    
    def __len__(self):
        # Forward len() to the wrapped object
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        # For objects, return number of keys
        try:
            constructor_name = obj.constructor.name if hasattr(obj, 'constructor') else None
            if constructor_name == 'Object':
                return len(js.Object.keys(obj))
        except:
            pass
        return len(obj)
    
    def keys(self):
        """Return keys for dict-like objects"""
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        try:
            constructor_name = obj.constructor.name if hasattr(obj, 'constructor') else None
            if constructor_name == 'Object':
                return list(js.Object.keys(obj))
        except:
            pass
        # Fallback for objects that don't have a clear constructor
        try:
            return list(js.Object.keys(obj))
        except:
            raise TypeError(f"keys() not supported for {type(obj)}")
    
    def values(self):
        """Return values for dict-like objects"""
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        try:
            keys = js.Object.keys(obj)
            for key in keys:
                value = js.Reflect.get(obj, key)
                if self._should_wrap(value):
                    yield _BabelfontWrapper(value)
                else:
                    yield value
        except:
            raise TypeError(f"values() not supported for {type(obj)}")
    
    def items(self):
        """Return (key, value) pairs for dict-like objects"""
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        try:
            keys = js.Object.keys(obj)
            for key in keys:
                value = js.Reflect.get(obj, key)
                if self._should_wrap(value):
                    yield (key, _BabelfontWrapper(value))
                else:
                    yield (key, value)
        except:
            raise TypeError(f"items() not supported for {type(obj)}")
    
    def __iter__(self):
        # Forward iteration to the wrapped object, wrapping each item
        obj = object.__getattribute__(self, '_BabelfontWrapper__obj')
        
        # Check if it's an array-like object or a dict-like object
        try:
            # Try to get the constructor name to determine type
            constructor_name = obj.constructor.name if hasattr(obj, 'constructor') else None
            
            # If it's an Array, iterate normally
            if constructor_name == 'Array' or hasattr(obj, 'length'):
                for item in obj:
                    if self._should_wrap(item):
                        yield _BabelfontWrapper(item)
                    else:
                        yield item
            # If it's an Object (dict-like), iterate over keys
            else:
                # Use Object.keys() to get the keys
                keys = js.Object.keys(obj)
                for key in keys:
                    yield key
        except Exception:
            # Fallback: try direct iteration
            for item in obj:
                if self._should_wrap(item):
                    yield _BabelfontWrapper(item)
                else:
                    yield item


def CurrentFont():
    """
    Get the currently active font.

    Returns:
        Font: The currently active context Font object

    Raises:
        RuntimeError: If no font is currently open

    Example:
        >>> font = CurrentFont()
        >>> print(font)
    """
    if type(js.window.currentFontModel) is pyodide.ffi.JsNull:
        raise RuntimeError("No font is currently open")
    
    font_obj = js.window.currentFontModel
    return _BabelfontWrapper(font_obj)

