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


def OpenFont(path):
    """
    Open a font file and return a Font object.

    Note: Dirty tracking is initialized separately after loading via
    InitializeTracking() to keep the UI responsive. Use IsTrackingReady()
    to check if tracking is initialized.

    Args:
        path (str): Path to the font file (.glyphs, .ufo, .designspace, etc.)

    Returns:
        Font: A context Font object

    Example:
        >>> font = OpenFont("/project/MyFont.glyphs")
        >>> print(font.info.familyName)
    """
    global __current_font_id

    __font_to_load = load(path)

    # Ensure the filename is set (should be done by loader, but make sure)
    if not hasattr(__font_to_load, "filename") or __font_to_load.filename is None:
        __font_to_load.filename = path

    # Generate a unique ID for this font
    font_id = str(uuid.uuid4())

    # Store the font with its ID
    __open_fonts[font_id] = __font_to_load
    __tracking_initialized[font_id] = False

    # Set as current font
    __current_font_id = font_id

    # Register save callbacks for UI integration
    _register_ui_callbacks(__font_to_load, font_id)

    # Note: Dirty tracking will be initialized from JavaScript
    # via InitializeTracking() call (synchronous, optimized with lazy loading)

    return __font_to_load


def _register_ui_callbacks(font, font_id):
    """
    Register UI callbacks on a font object.
    These callbacks will be called when font.save() is invoked.

    Note: Clears any existing callbacks before registering to prevent
    duplicates.
    """

    def before_save_callback(font, filename):
        """Called before saving begins."""
        # Call JavaScript callback if available
        try:
            import js

            if hasattr(js, "_fontSaveCallbacks"):
                js._fontSaveCallbacks.beforeSave(font_id, filename)
        except Exception as e:
            print(f"Error in before_save callback: {e}")

    def after_save_callback(font, filename, duration):
        """Called after successful save."""
        # Note: Font is already marked clean by font.save() itself,
        # no need to do it again here (it's expensive for large fonts)

        print(f"Saved font to {filename} in {duration:.2f}s")

        # Call JavaScript callback if available
        try:
            import js

            if hasattr(js, "_fontSaveCallbacks"):
                js._fontSaveCallbacks.afterSave(font_id, filename, duration)
        except Exception as e:
            print(f"Error in after_save callback: {e}")

    def on_error_callback(font, filename, error):
        """Called if save fails."""
        print(f"Error saving {filename}: {error}")

        # Call JavaScript callback if available
        try:
            import js

            if hasattr(js, "_fontSaveCallbacks"):
                js._fontSaveCallbacks.onError(font_id, filename, str(error))
        except Exception as e:
            print(f"Error in on_error callback: {e}")

    # Clear any existing callbacks to prevent duplicates
    # from multiple OpenFont calls
    font.clear_callbacks("before_save")
    font.clear_callbacks("after_save")
    font.clear_callbacks("on_error")

    # Register the callbacks
    font.register_callback("before_save", before_save_callback)
    font.register_callback("after_save", after_save_callback)
    font.register_callback("on_error", on_error_callback)


def GetCurrentFontId():
    """
    Get the ID of the currently active font.

    Returns:
        str: The font ID, or None if no font is open
    """
    return __current_font_id


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


def GetOpenFonts():
    """
    Get a list of all open fonts with their IDs and display names.

    Returns:
        list: List of dicts with 'id', 'name', and 'path' keys

    Example:
        >>> fonts = GetOpenFonts()
        >>> for font_info in fonts:
        ...     print(font_info['id'], font_info['name'])
    """
    result = []
    for font_id, font in __open_fonts.items():
        # Try to get a display name for the font
        name = "Untitled Font"

        # Try font.names.familyName['dflt'] first (context)
        if (
            hasattr(font, "names")
            and hasattr(font.names, "familyName")
            and isinstance(font.names.familyName, dict)
            and "dflt" in font.names.familyName
        ):
            name = font.names.familyName["dflt"]
        # Fallback to font.info.familyName
        elif (
            hasattr(font, "info")
            and hasattr(font.info, "familyName")
            and font.info.familyName
        ):
            name = font.info.familyName
        # Fallback to filename
        elif hasattr(font, "filename") and font.filename:
            name = font.filename.split("/")[-1]

        # Try to get the path
        path = getattr(font, "filename", "") or ""

        result.append(
            {
                "id": font_id,
                "name": name,
                "path": path,
                "is_current": font_id == __current_font_id,
            }
        )

    return result


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
