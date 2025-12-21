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
Base Canvas Plugin Template
This is a minimal template showing the essential methods for a canvas plugin.
"""


class BaseCanvasPlugin:
    """
    Base template for canvas plugins.
    
    Canvas plugins can draw at two different layers:
    - draw_below: Underneath everything (backgrounds, guides)
    - draw_above: Above everything including UI elements
    
    Implement only the methods you need.
    """
    
    # Plugin metadata (customize these)
    name = "Base Canvas Plugin"
    version = "0.1.0"
    
    def get_ui_elements(self):
        """
        Return a list of UI elements for this plugin.
        
        Each element is a dictionary with:
        - type: 'slider', 'checkbox', 'color-picker', etc.
        - id: unique identifier for this element
        - label: human-readable label
        - ... type-specific properties
        
        Example:
        return [
            {
                'type': 'slider',
                'id': 'example_param',
                'label': 'Example Parameter',
                'min': 0,
                'max': 100,
                'step': 1,
                'default': 50
            }
        ]
        
        Returns:
            List of UI element dictionaries
        """
        return []
    
    def set_parameter(self, param_id, value):
        """
        Set a parameter value from the UI.
        
        Args:
            param_id: The parameter identifier (from UI element 'id')
            value: The new value
        """
        pass
    
    def get_parameter(self, param_id):
        """
        Get a parameter value.
        
        Args:
            param_id: The parameter identifier
            
        Returns:
            The current parameter value, or None if not found
        """
        return None
    
    def draw_below(self, layer_data, glyph_name, ctx, viewport_manager):
        """
        Draw below the glyph outline (first layer).
        
        Use this for backgrounds, reference images, or anything that should
        appear behind the glyph outline.
        
        Args:
            layer_data (dict): Layer data containing:
                - shapes: List of shape dictionaries (Path, Component, etc.)
                - width: Advance width
                - height: Vertical advance (if set)
                - anchors: List of anchor dictionaries
                - guides: List of guide dictionaries
                - location: Interpolation location (if applicable)
                
            glyph_name (str): Name of the current glyph
            
            ctx (CanvasRenderingContext2D): HTML5 canvas 2D context
                - Coordinate system is in font design space
                - Origin (0,0) is at baseline/left sidebearing
                - Y-axis points upward (font coordinates, not screen)
                - Use standard canvas methods: fillRect, strokeRect, arc, etc.
                
            viewport_manager: Viewport manager object with:
                - scale: Current zoom level
                - Methods for coordinate transformations
        
        Example:
            # Draw a light gray background
            ctx.save()
            ctx.fillStyle = 'rgba(200, 200, 200, 0.3)'
            ctx.fillRect(0, -200, layer_data.get('width', 600), 1000)
            ctx.restore()
        """
        pass
    
    def draw_above(self, layer_data, glyph_name, ctx, viewport_manager):
        """
        Draw above everything (top layer).
        
        Use this for overlays, HUD elements, or information that should
        always be visible above all other canvas content.
        
        Args:
            layer_data (dict): Same as draw_below
            glyph_name (str): Same as draw_below
            ctx (CanvasRenderingContext2D): Same as draw_below
            viewport_manager: Same as draw_below
        
        Example:
            # Display glyph info in corner
            ctx.save()
            ctx.fillStyle = 'rgba(0, 0, 0, 0.8)'
            ctx.font = '14px monospace'
            ctx.fillText(f'Glyph: {glyph_name}', 10, 30)
            ctx.fillText(f'Width: {layer_data.get("width", 0)}', 10, 50)
            ctx.restore()
        """
        pass


# Helper notes for plugin development:
#
# Node Types:
# - 'c' or 'cs': On-curve point (corner or smooth)
# - 'o': Off-curve point (control point for bezier curves)
# - 'l' or 'ls': Line endpoint (corner or smooth)
# - 'q' or 'qs': Quadratic curve endpoint
#
# Shape Types in layer_data['shapes']:
# - {'Path': {'nodes': [...], 'closed': bool}}
# - {'Component': {'reference': str, 'transform': {...}}}
# - {'Anchor': {'name': str, 'x': float, 'y': float}}
#
# Canvas Context Methods:
# - Drawing: fillRect, strokeRect, fillText, strokeText
# - Paths: beginPath, moveTo, lineTo, bezierCurveTo, closePath, fill, stroke
# - Transform: save, restore, translate, rotate, scale
# - Style: fillStyle, strokeStyle, lineWidth, font, textAlign
#
# Coordinate System:
# - Font design space (typically 1000 UPM)
# - Y-axis points up (opposite of screen coordinates)
# - Use viewport_manager.scale to convert between design and screen units
