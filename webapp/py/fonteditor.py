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

from context import load
import uuid


__open_fonts = {}  # Dictionary of {font_id: font_object}
__current_font_id = None  # ID of the currently active font
# Track if dirty tracking has been initialized for each font
__tracking_initialized = {}


def CurrentFont():
    """
    Get the currently active font.

    Returns:
        Font: The currently active context Font object, or None if no font is open

    Example:
        >>> font = CurrentFont()
        >>> print(font.info.familyName)
    """
    if __current_font_id and __current_font_id in __open_fonts:
        return __open_fonts[__current_font_id]
    return None


def SetCurrentFont(font_id):
    """
    Set the current font by ID.

    Args:
        font_id (str): The ID of the font to set as current

    Returns:
        bool: True if successful, False if font ID not found
    """
    global __current_font_id

    if font_id in __open_fonts:
        __current_font_id = font_id
        return True
    return False


def InitializeTracking(font_id=None):
    """
    Initialize dirty tracking for a font.

    Args:
        font_id (str, optional): Font ID. If None, uses current font.

    Returns:
        dict: Result with 'success', 'duration'
    """
    if font_id is None:
        font_id = __current_font_id

    if font_id is None or font_id not in __open_fonts:
        return {"error": "Font not found", "success": False}

    if __tracking_initialized.get(font_id, False):
        return {
            "success": True,
            "already_initialized": True,
            "duration": 0,
        }

    import time

    start_time = time.time()
    font = __open_fonts[font_id]

    # Initialize tracking (runs synchronously, optimized with lazy loading)
    font.initialize_dirty_tracking()

    total_duration = time.time() - start_time
    __tracking_initialized[font_id] = True

    print(f"✅ Dirty tracking initialized in {total_duration:.2f}s")

    return {
        "success": True,
        "duration": round(total_duration, 2),
    }


def IsTrackingReady(font_id=None):
    """
    Check if dirty tracking has been initialized for a font.

    Args:
        font_id (str, optional): Font ID to check. If None, checks current.

    Returns:
        bool: True if tracking is initialized, False otherwise
    """
    if font_id is None:
        font_id = __current_font_id

    if font_id is None or font_id not in __tracking_initialized:
        return False

    return __tracking_initialized[font_id]


def WaitForTracking(font_id=None):
    """
    Wait for dirty tracking initialization to complete.
    This is a no-op in the current implementation since we initialize
    synchronously, but is here for API consistency.

    Args:
        font_id (str, optional): Font ID to wait for. If None, uses current.

    Returns:
        bool: True when tracking is ready
    """
    if font_id is None:
        font_id = __current_font_id

    # Since we're initializing synchronously, this just returns the status
    return IsTrackingReady(font_id)


def SaveFont(path=None):
    """
    Save the current font to disk.

    This now simply calls font.save(), which triggers all registered callbacks.
    The UI callbacks handle updating the interface, marking clean, etc.

    Args:
        path (str, optional): Path to save the font. If not provided,
                             uses the font's stored filename.

    Returns:
        bool: True if successful, False if no font is open

    Example:
        >>> SaveFont()  # Saves to original location
        >>> SaveFont("/path/to/newfont.glyphs")  # Save As
    """
    current_font = CurrentFont()
    if current_font is None:
        return False

    # Wait for tracking to be initialized (should already be done)
    if not WaitForTracking():
        print("Warning: Saving before tracking fully initialized")

    # Simply call font.save() - callbacks will handle the rest
    try:
        current_font.save(path)
        return True
    except Exception as e:
        # Error callback will have been triggered by font.save()
        print(f"Error saving font: {e}")
        return False


def GetOpentypeFeatureInfo():
    """
    Get information about OpenType features, including which are discretionary
    and which should be on by default.

    Returns:
        dict: Dictionary with feature information including:
            - 'default_on': List of features that should be on by default
            - 'default_off': List of features that should be off by default
            - 'descriptions': Dictionary mapping feature tags to descriptions

    Example:
        >>> info = GetOpentypeFeatureInfo()
        >>> print(info['default_on'])
        ['calt', 'clig', 'liga', 'kern', 'cpsp', 'locl']
    """
    from context.opentype.features import (
        DEFAULT_ON_FEATURES,
        DEFAULT_OFF_FEATURES,
        FEATURE_DESCRIPTIONS,
    )

    return {
        "default_on": list(DEFAULT_ON_FEATURES),
        "default_off": list(DEFAULT_OFF_FEATURES),
        "descriptions": FEATURE_DESCRIPTIONS,
    }
