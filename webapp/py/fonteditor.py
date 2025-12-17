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


# def SetCurrentFont(font_id):
#     """
#     Set the current font by ID.

#     Args:
#         font_id (str): The ID of the font to set as current

#     Returns:
#         bool: True if successful, False if font ID not found
#     """
#     global __current_font_id

#     if font_id in __open_fonts:
#         __current_font_id = font_id
#         return True
#     return False


# def InitializeTracking(font_id=None):
#     """
#     Initialize dirty tracking for a font.

#     Args:
#         font_id (str, optional): Font ID. If None, uses current font.

#     Returns:
#         dict: Result with 'success', 'duration'
#     """
#     if font_id is None:
#         font_id = __current_font_id

#     if font_id is None or font_id not in __open_fonts:
#         return {"error": "Font not found", "success": False}

#     if __tracking_initialized.get(font_id, False):
#         return {
#             "success": True,
#             "already_initialized": True,
#             "duration": 0,
#         }

#     import time

#     start_time = time.time()
#     font = __open_fonts[font_id]

#     # Initialize tracking (runs synchronously, optimized with lazy loading)
#     font.initialize_dirty_tracking()

#     total_duration = time.time() - start_time
#     __tracking_initialized[font_id] = True

#     print(f"✅ Dirty tracking initialized in {total_duration:.2f}s")

#     return {
#         "success": True,
#         "duration": round(total_duration, 2),
#     }


# def IsTrackingReady(font_id=None):
#     """
#     Check if dirty tracking has been initialized for a font.

#     Args:
#         font_id (str, optional): Font ID to check. If None, checks current.

#     Returns:
#         bool: True if tracking is initialized, False otherwise
#     """
#     if font_id is None:
#         font_id = __current_font_id

#     if font_id is None or font_id not in __tracking_initialized:
#         return False

#     return __tracking_initialized[font_id]


# def WaitForTracking(font_id=None):
#     """
#     Wait for dirty tracking initialization to complete.
#     This is a no-op in the current implementation since we initialize
#     synchronously, but is here for API consistency.

#     Args:
#         font_id (str, optional): Font ID to wait for. If None, uses current.

#     Returns:
#         bool: True when tracking is ready
#     """
#     if font_id is None:
#         font_id = __current_font_id

#     # Since we're initializing synchronously, this just returns the status
#     return IsTrackingReady(font_id)


# def SaveFont(path=None):
#     """
#     Save the current font to disk.

#     This now simply calls font.save(), which triggers all registered callbacks.
#     The UI callbacks handle updating the interface, marking clean, etc.

#     Args:
#         path (str, optional): Path to save the font. If not provided,
#                              uses the font's stored filename.

#     Returns:
#         bool: True if successful, False if no font is open

#     Example:
#         >>> SaveFont()  # Saves to original location
#         >>> SaveFont("/path/to/newfont.glyphs")  # Save As
#     """
#     current_font = CurrentFont()
#     if current_font is None:
#         return False

#     # Wait for tracking to be initialized (should already be done)
#     if not WaitForTracking():
#         print("Warning: Saving before tracking fully initialized")

#     # Simply call font.save() - callbacks will handle the rest
#     try:
#         current_font.save(path)
#         return True
#     except Exception as e:
#         # Error callback will have been triggered by font.save()
#         print(f"Error saving font: {e}")
#         return False

