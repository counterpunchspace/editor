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
Example Canvas Plugin
Draws the outline filled in black and the glyph's name centered underneath.
"""

import js

from base_canvas_plugin.plugin import BaseCanvasPlugin


class ExampleCanvasPlugin(BaseCanvasPlugin):
    """
    Example canvas plugin that draws a filled outline and glyph name.
    
    This plugin demonstrates the canvas plugin API by:
    - Drawing the outline filled in 50% transparent blue
    - Drawing the glyph's name in 20px text centered underneath the glyph's bbox
    """
    
    name = "Example Canvas Plugin"
    version = "0.1.0"
    
    def visible(self):
        """This plugin should be visible in the plugin list."""
        return True
    
    def draw_below(self, layer_data, glyph_name, ctx, viewport_manager):
        """
        Draw below the outline on the canvas.
        
        Args:
            layer_data: Dictionary with layer data including shapes, width, anchors, etc.
            glyph_name: String with the name of the current glyph
            ctx: Canvas 2D rendering context (CanvasRenderingContext2D)
            viewport_manager: Viewport manager for coordinate transformations
        """
        
        if not layer_data or not layer_data.get('shapes'):
            print(f"[ExamplePlugin] Early return - no layer_data or shapes")
            return
        
        # Calculate bounding box of all shapes
        bbox = self._calculate_bbox(layer_data['shapes'])
        if not bbox:
            return
        
        min_x, min_y, max_x, max_y = bbox
        
        # Save context state
        ctx.save()
        
        # Draw filled outline in black
        self._draw_filled_outline(ctx, layer_data['shapes'])
        
        # Draw glyph name centered underneath bbox
        self._draw_glyph_name(ctx, glyph_name, min_x, max_x, min_y, viewport_manager)
        
        # Restore context state
        ctx.restore()
    
    def _calculate_bbox(self, shapes):
        """
        Calculate the bounding box of all shapes.
        
        Args:
            shapes: List of shape dictionaries
            
        Returns:
            Tuple (min_x, min_y, max_x, max_y) or None if no coordinates found
        """
        min_x = min_y = float('inf')
        max_x = max_y = float('-inf')
        found_coords = False
        
        for shape in shapes:
            if 'Path' in shape:
                path = shape['Path']
                nodes = path.get('nodes', [])
                
                # Parse nodes if they're a string
                if isinstance(nodes, str):
                    nodes = self._parse_nodes_string(nodes)
                
                for node in nodes:
                    if isinstance(node, dict):
                        x = node.get('x', 0)
                        y = node.get('y', 0)
                        min_x = min(min_x, x)
                        min_y = min(min_y, y)
                        max_x = max(max_x, x)
                        max_y = max(max_y, y)
                        found_coords = True
        
        return (min_x, min_y, max_x, max_y) if found_coords else None
    
    def _parse_nodes_string(self, nodes_str):
        """
        Parse a nodes string into a list of node dictionaries.
        
        Args:
            nodes_str: String representation of nodes
            
        Returns:
            List of node dictionaries
        """
        # Simple parser for node strings like "M 100 200 L 300 400"
        # This is a simplified version - the real implementation might be more complex
        nodes = []
        if not nodes_str:
            return nodes
        
        parts = nodes_str.strip().split()
        i = 0
        while i < len(parts):
            node_type = parts[i]
            if node_type in ('M', 'L', 'C', 'Q'):
                if i + 2 < len(parts):
                    try:
                        x = float(parts[i + 1])
                        y = float(parts[i + 2])
                        nodes.append({'type': node_type, 'x': x, 'y': y})
                        i += 3
                    except ValueError:
                        i += 1
                else:
                    break
            else:
                i += 1
        
        return nodes
    
    def _draw_filled_outline(self, ctx, shapes):
        """
        Draw all paths filled in 50% transparent blue. All contours are added to a single path
        before filling, which allows the canvas to properly handle counters
        (holes in glyphs) using the nonzero winding rule.
        
        Args:
            ctx: Canvas 2D rendering context
            shapes: List of shape dictionaries
        """
        ctx.fillStyle = 'rgba(0, 0, 255, 0.5)'
        
        # Begin a single path for all contours - this allows counters to work correctly
        ctx.beginPath()
        
        for shape in shapes:
            # Get nodes - they can be at shape['nodes'] or shape['Path']['nodes']
            nodes = shape.get('nodes', [])
            if not nodes and 'Path' in shape:
                nodes = shape['Path'].get('nodes', [])
            
            if not nodes:
                continue
            
            # Find first on-curve point to start
            start_idx = 0
            for i, node in enumerate(nodes):
                if node.get('type') in ('c', 'cs', 'l', 'ls'):
                    start_idx = i
                    break
            
            # Move to start point (adds new subpath without ending previous ones)
            start_node = nodes[start_idx]
            ctx.moveTo(start_node['x'], start_node['y'])
            
            # Draw the path
            i = 0
            while i < len(nodes):
                idx = (start_idx + i) % len(nodes)
                next_idx = (start_idx + i + 1) % len(nodes)
                next2_idx = (start_idx + i + 2) % len(nodes)
                next3_idx = (start_idx + i + 3) % len(nodes)
                
                node = nodes[idx]
                node_type = node.get('type', 'l')
                
                # Check if next points are off-curve (cubic bezier)
                if next_idx < len(nodes):
                    next_node = nodes[next_idx]
                    next_type = next_node.get('type', 'l')
                    
                    if next_type == 'o':  # Next is off-curve (control point)
                        # This is a cubic bezier curve
                        cp1 = next_node
                        cp2 = nodes[next2_idx]
                        end = nodes[next3_idx]
                        
                        ctx.bezierCurveTo(
                            cp1['x'], cp1['y'],
                            cp2['x'], cp2['y'],
                            end['x'], end['y']
                        )
                        i += 3  # Skip control points and endpoint
                    else:
                        # Straight line to next on-curve point
                        ctx.lineTo(next_node['x'], next_node['y'])
                        i += 1
                else:
                    i += 1
            
            # Close this subpath (but don't fill yet)
            ctx.closePath()
        
        # Fill all contours at once - the canvas uses the nonzero winding rule
        # to automatically create counters (holes) where paths have opposite directions
        ctx.fill()
        
    
    def _draw_glyph_name(self, ctx, glyph_name, min_x, max_x, min_y, viewport_manager):
        """
        Draw the glyph name centered underneath the glyph.
        
        Args:
            ctx: Canvas 2D rendering context
            glyph_name: Name of the glyph
            min_x: Minimum x coordinate
            max_x: Maximum x coordinate
            min_y: Minimum y coordinate
            viewport_manager: Viewport manager for scale information
        """
        if not glyph_name:
            return
        
        # Calculate center x position
        center_x = (min_x + max_x) / 2
        
        # Position text below the glyph (below the minimum y)
        # Note: In font coordinates, y increases upward, so min_y is at the bottom
        text_y = min_y - 50  # 50 units below the bottom of the glyph
        
        # Calculate font size in design space units
        # 20px on screen should translate to design space
        inv_scale = 1 / viewport_manager.scale
        font_size_design = 20 * inv_scale
        
        # Set up text rendering
        ctx.fillStyle = 'rgba(128, 128, 128, 0.8)'  # Semi-transparent gray
        ctx.font = f'{font_size_design}px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        
        # Save and transform for text (flip y-axis for proper text orientation)
        ctx.save()
        ctx.translate(center_x, text_y)
        ctx.scale(1, -1)  # Flip y-axis so text appears upright
        ctx.fillText(glyph_name, 0, 0)
        ctx.restore()
