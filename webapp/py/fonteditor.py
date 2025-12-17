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


def CurrentFont():
    """
    Get the currently active font.

    Returns:
        Font: The currently active context Font object

    Raises:
        RuntimeError: If no font is currently open

    Example:
        >>> font = CurrentFont()
        >>> print(font.info.familyName)
    """
    if type(js.window.currentFontModel) is pyodide.ffi.JsNull:
        raise RuntimeError("No font is currently open")
    return js.window.currentFontModel

