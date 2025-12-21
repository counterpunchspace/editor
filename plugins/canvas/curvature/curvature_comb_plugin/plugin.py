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
Curvature Comb Plugin
Draws a curvature comb visualization on bezier curves to show curvature distribution.
"""

import math

from base_canvas_plugin.plugin import BaseCanvasPlugin

# Import JavaScript console for logging
try:
    import js
    console = js.console
except ImportError:
    # Fallback for testing outside of Pyodide
    class FakeConsole:
        def log(self, *args):
            print(*args)
    console = FakeConsole()


class CurvatureCombPlugin(BaseCanvasPlugin):
    """
    Curvature comb plugin that visualizes curve curvature.
    
    Draws perpendicular lines (comb teeth) along curves where the length
    of each tooth is proportional to the curvature at that point.
    """
    
    name = "Curvature Comb"
    version = "0.1.0"
    
    # Configuration
    SAMPLES_PER_CURVE = 50  # Number of teeth per curve segment
    OPACITY = 0.4           # Opacity of comb teeth
    DEBUG = False           # Enable debug logging
    
    def visible(self):
        """This plugin should be visible in the plugin list."""
        return True
    
    @property
    def SCALE_FACTOR(self):
        """Get the current scale factor."""
        return 2000 + self.get_parameter('scale_factor') * 250
    
    def get_ui_elements(self):
        """
        Return UI elements for this plugin.
        
        Returns:
            List of UI element dictionaries
        """
        return [
            {
                'type': 'slider',
                'id': 'scale_factor',
                'label': 'Scale',
                'min': 0,
                'max': 100,
                'step': 1,
                'default': 50
            },
            {
                'type': 'slider',
                'id': 'exponent',
                'label': 'Exponent',
                'min': 1,
                'max': 5,
                'step': .1,
                'default': 1
            }
        ]
    
    def draw_below(self, layer_data, glyph_name, ctx, viewport_manager):
        """
        Draw curvature comb below the glyph outline.
        
        Args:
            layer_data: Dictionary with layer data including shapes
            glyph_name: String with the name of the current glyph
            ctx: Canvas 2D rendering context
            viewport_manager: Viewport manager for coordinate transformations
        """
        if self.DEBUG:
            console.log(f"[CurvatureComb] draw_below called for glyph: {glyph_name}")
        
        if not layer_data:
            if self.DEBUG:
                console.log(f"[CurvatureComb] No layer_data provided")
            return
            
        shapes = layer_data.get('shapes', [])
        if not shapes:
            if self.DEBUG:
                console.log(f"[CurvatureComb] No shapes in layer_data")
            return
        
        if self.DEBUG:
            console.log(f"[CurvatureComb] Processing {len(shapes)} shapes")
        
        ctx.save()
        
        # Process each shape (path) independently with its own min/max
        total_curve_count = 0
        for i, shape in enumerate(shapes):
            if 'Path' in shape:
                # Collect curvature data for this path only
                curve_data_list = self._collect_curve_data(shape)
                
                if not curve_data_list:
                    continue
                
                # Find min/max curvature for this path
                path_curvatures = []
                for curve_data in curve_data_list:
                    path_curvatures.extend([abs_cv for _, _, _, abs_cv in curve_data['samples']])
                
                if not path_curvatures:
                    continue
                
                min_curvature = min(path_curvatures)
                max_curvature = max(path_curvatures)
                
                if self.DEBUG:
                    console.log(f"[CurvatureComb] Path {i} curvature range: {min_curvature} to {max_curvature}")
                
                # Draw this path's curves with its own color range
                for curve_data in curve_data_list:
                    self._draw_curve_data(curve_data, ctx, min_curvature, max_curvature)
                    total_curve_count += 1
        
        if self.DEBUG:
            console.log(f"[CurvatureComb] Total cubic curves processed: {total_curve_count}")
        ctx.restore()
    
    def _collect_curve_data(self, shape):
        """
        Collect curvature data for all cubic bezier curves in a path without drawing.
        
        Args:
            shape: Shape dictionary with Path data
            
        Returns:
            List of curve data dictionaries
        """
        curve_data_list = []
        nodes = shape.get('nodes', [])
        if not nodes and 'Path' in shape:
            nodes = shape['Path'].get('nodes', [])
        
        if not nodes or len(nodes) < 2:
            return curve_data_list
        
        i = 0
        max_iterations = len(nodes)
        while i < max_iterations:
            try:
                node = nodes[i]
                if not isinstance(node, dict):
                    i += 1
                    continue
                    
                node_type = node.get('type', 'l')
                
                # Look ahead for cubic bezier curves
                next1 = nodes[(i + 1) % len(nodes)]
                next2 = nodes[(i + 2) % len(nodes)]
                next3 = nodes[(i + 3) % len(nodes)]
                
                if not all(isinstance(n, dict) for n in [next1, next2, next3]):
                    i += 1
                    continue
                
                # Check if this is a cubic bezier
                if (node_type in ('c', 'cs', 'l', 'ls') and 
                    next1.get('type') == 'o' and 
                    next2.get('type') == 'o' and 
                    next3.get('type') in ('c', 'cs', 'l', 'ls')):
                    
                    if not all('x' in n and 'y' in n for n in [node, next1, next2, next3]):
                        i += 1
                        continue
                    
                    p0 = (float(node['x']), float(node['y']))
                    p1 = (float(next1['x']), float(next1['y']))
                    p2 = (float(next2['x']), float(next2['y']))
                    p3 = (float(next3['x']), float(next3['y']))
                    
                    # Collect sample data for this curve
                    curve_data = self._sample_cubic_curve(p0, p1, p2, p3)
                    if curve_data:
                        curve_data_list.append(curve_data)
                    
                    i += 3
                    continue
            except Exception as e:
                if self.DEBUG:
                    console.log(f"[CurvatureComb] Error collecting data at node {i}: {e}")
                i += 1
                continue
            
            i += 1
        
        return curve_data_list
    
    def _draw_path_curvature(self, shape, ctx):
        """
        Draw curvature comb for a path shape.
        
        Args:
            shape: Shape dictionary with Path data
            ctx: Canvas 2D rendering context
            
        Returns:
            Number of cubic curves processed
        """
        nodes = shape.get('nodes', [])
        if not nodes and 'Path' in shape:
            nodes = shape['Path'].get('nodes', [])
        
        if self.DEBUG:
            console.log(f"[CurvatureComb] Nodes found: {len(nodes) if nodes else 0}")
            if nodes and len(nodes) > 0:
                console.log(f"[CurvatureComb] First node: {nodes[0]}")
                console.log(f"[CurvatureComb] Node types: {[n.get('type', '?') for n in nodes[:5]]}")
        
        if not nodes or len(nodes) < 2:
            if self.DEBUG:
                console.log(f"[CurvatureComb] Not enough nodes to process")
            return 0
        
        # Process nodes to find cubic bezier segments
        curve_count = 0
        i = 0
        # Only process up to len(nodes) to avoid reprocessing with wraparound
        max_iterations = len(nodes)
        while i < max_iterations:
            try:
                node = nodes[i]
                if not isinstance(node, dict):
                    i += 1
                    continue
                    
                node_type = node.get('type', 'l')
                
                # Look ahead for cubic bezier curves (on-curve followed by two off-curve)
                # Use modulo to wrap around for closed paths
                next1 = nodes[(i + 1) % len(nodes)]
                next2 = nodes[(i + 2) % len(nodes)]
                next3 = nodes[(i + 3) % len(nodes)]
                
                # Validate all nodes are dictionaries
                if not all(isinstance(n, dict) for n in [next1, next2, next3]):
                    i += 1
                    continue
                
                # Check if this is a cubic bezier: on-curve, off-curve, off-curve, on-curve
                if (node_type in ('c', 'cs', 'l', 'ls') and 
                    next1.get('type') == 'o' and 
                    next2.get('type') == 'o' and 
                    next3.get('type') in ('c', 'cs', 'l', 'ls')):
                    
                    # Verify all nodes have x and y coordinates
                    if not all('x' in n and 'y' in n for n in [node, next1, next2, next3]):
                        i += 1
                        continue
                    
                    if self.DEBUG:
                        console.log(f"[CurvatureComb] Found cubic curve at node {i}")
                    
                    # Draw curvature comb for this cubic bezier
                    p0 = (float(node['x']), float(node['y']))
                    p1 = (float(next1['x']), float(next1['y']))
                    p2 = (float(next2['x']), float(next2['y']))
                    p3 = (float(next3['x']), float(next3['y']))
                    
                    if self.DEBUG:
                        console.log(f"[CurvatureComb] Curve points: {p0} -> {p1}, {p2} -> {p3}")
                    
                    shapes_drawn = self._draw_cubic_curvature_comb(p0, p1, p2, p3, ctx)
                    if self.DEBUG:
                        console.log(f"[CurvatureComb] Drew {shapes_drawn} shapes")
                    curve_count += 1
                    
                    i += 3  # Skip the control points and endpoint
                    continue
            except Exception as e:
                if self.DEBUG:
                    console.log(f"[CurvatureComb] Error processing node {i}: {e}")
                i += 1
                continue
            
            i += 1
        
        return curve_count
    
    def _sample_cubic_curve(self, p0, p1, p2, p3):
        """
        Sample a cubic bezier curve to collect curvature data.
        
        Args:
            p0, p1, p2, p3: Bezier control points
            
        Returns:
            Dictionary with curve data or None
        """
        try:
            samples = []
            
            for i in range(self.SAMPLES_PER_CURVE):
                try:
                    t = i / (self.SAMPLES_PER_CURVE - 1) if self.SAMPLES_PER_CURVE > 1 else 0
                    
                    point = self._cubic_bezier_point(p0, p1, p2, p3, t)
                    curvature = self._cubic_bezier_curvature(p0, p1, p2, p3, t)
                    tangent = self._cubic_bezier_tangent(p0, p1, p2, p3, t)
                    
                    if tangent[0] == 0 and tangent[1] == 0:
                        continue
                    
                    tangent_length = math.sqrt(tangent[0]**2 + tangent[1]**2)
                    if tangent_length < 1e-10:
                        continue
                    
                    tangent_norm = (tangent[0] / tangent_length, tangent[1] / tangent_length)
                    perp = (-tangent_norm[1], tangent_norm[0])
                    
                    if math.isfinite(point[0]) and math.isfinite(point[1]):
                        # Store: point, perpendicular direction, raw curvature value
                        samples.append((point, perp, -curvature, abs(curvature)))
                except Exception as e:
                    if self.DEBUG:
                        console.log(f"[CurvatureComb] Error sampling: {e}")
                    continue
            
            if len(samples) >= 2:
                return {'samples': samples}
            return None
        except Exception as e:
            if self.DEBUG:
                console.log(f"[CurvatureComb] Error in sampling: {e}")
            return None
    
    def _draw_curve_data(self, curve_data, ctx, min_curvature, max_curvature):
        """
        Draw curvature comb with color mapping based on curvature range.
        
        Args:
            curve_data: Dictionary with sample data
            ctx: Canvas 2D rendering context
            min_curvature: Minimum curvature in glyph
            max_curvature: Maximum curvature in glyph
        """
        try:
            samples = curve_data['samples']
            
            for i in range(len(samples) - 1):
                try:
                    point_i, perp_i, signed_curv_i, abs_curv_i = samples[i]
                    point_next, perp_next, signed_curv_next, abs_curv_next = samples[i + 1]
                    
                    # Calculate average curvature for this segment
                    avg_curvature = (abs_curv_i + abs_curv_next) / 2
                    
                    # Normalize curvature to 0-1 range
                    if max_curvature - min_curvature < 1e-10:
                        t_i = 0
                        t_next = 0
                    else:
                        t_i = (abs_curv_i - min_curvature) / (max_curvature - min_curvature)
                        t_next = (abs_curv_next - min_curvature) / (max_curvature - min_curvature)
                    
                    # Clamp to 0-1
                    t_i = max(0, min(1, t_i))
                    t_next = max(0, min(1, t_next))
                    
                    # Use raw curvature for tooth length (no exponent applied)
                    # Use signed curvature direction with original magnitude
                    tooth_length_i = (signed_curv_i / abs_curv_i if abs_curv_i > 0 else 0) * abs_curv_i * self.SCALE_FACTOR
                    tooth_length_next = (signed_curv_next / abs_curv_next if abs_curv_next > 0 else 0) * abs_curv_next * self.SCALE_FACTOR
                    
                    # Skip extreme values
                    if abs(tooth_length_i) > 10000 or abs(tooth_length_next) > 10000:
                        continue
                    
                    # Calculate tooth endpoints
                    tooth_end_i = (point_i[0] + perp_i[0] * tooth_length_i, point_i[1] + perp_i[1] * tooth_length_i)
                    tooth_end_next = (point_next[0] + perp_next[0] * tooth_length_next, point_next[1] + perp_next[1] * tooth_length_next)
                    
                    # Map curvature to color: gray → yellow → red
                    color = self._get_curvature_color(avg_curvature, min_curvature, max_curvature)
                    
                    ctx.fillStyle = color
                    ctx.beginPath()
                    ctx.moveTo(point_i[0], point_i[1])
                    ctx.lineTo(point_next[0], point_next[1])
                    ctx.lineTo(tooth_end_next[0], tooth_end_next[1])
                    ctx.lineTo(tooth_end_i[0], tooth_end_i[1])
                    ctx.closePath()
                    ctx.fill()
                except Exception as e:
                    if self.DEBUG:
                        console.log(f"[CurvatureComb] Error drawing segment {i}: {e}")
                    continue
        except Exception as e:
            if self.DEBUG:
                console.log(f"[CurvatureComb] Error drawing curve data: {e}")
    
    def _get_curvature_color(self, curvature, min_curv, max_curv):
        """
        Map curvature value to color gradient: gray → yellow → red.
        
        Args:
            curvature: Current curvature value (absolute)
            min_curv: Minimum curvature in glyph
            max_curv: Maximum curvature in glyph
            
        Returns:
            CSS color string with opacity from setting
        """
        # Normalize to 0-1 range
        if max_curv - min_curv < 1e-10:
            t = 0
        else:
            t = (curvature - min_curv) / (max_curv - min_curv)
        
        # Clamp to 0-1
        t = max(0, min(1, t))
        
        # Apply exponent for more expressive contrast
        t = pow(t, self.get_parameter('exponent'))
        
        # Color gradient: gray (128,128,128) → yellow (255,255,0) → red (255,0,0)
        if t < 0.5:
            # gray → yellow
            blend = t * 2  # 0 to 1
            r = int(128 + (255 - 128) * blend)
            g = int(128 + (255 - 128) * blend)
            b = int(128 - 128 * blend)
        else:
            # yellow → red
            blend = (t - 0.5) * 2  # 0 to 1
            r = 255
            g = int(255 - 255 * blend)
            b = 0
        
        return f'rgba({r}, {g}, {b}, {self.OPACITY})'
    
    def _draw_cubic_curvature_comb(self, p0, p1, p2, p3, ctx):
        """
        Legacy method for compatibility.
        """
        curve_data = self._sample_cubic_curve(p0, p1, p2, p3)
        if curve_data:
            self._draw_curve_data(curve_data, ctx, 0, 1)
            return len(curve_data['samples']) - 1
        return 0
    
    def _cubic_bezier_point(self, p0, p1, p2, p3, t):
        """
        Calculate point on cubic bezier curve at parameter t.
        
        Args:
            p0, p1, p2, p3: Control points (x, y)
            t: Parameter [0, 1]
            
        Returns:
            Point (x, y) on curve
        """
        try:
            # B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
            t = max(0.0, min(1.0, t))  # Clamp t to [0, 1]
            t2 = t * t
            t3 = t2 * t
            mt = 1 - t
            mt2 = mt * mt
            mt3 = mt2 * mt
            
            x = mt3 * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t3 * p3[0]
            y = mt3 * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t3 * p3[1]
            
            return (x, y)
        except:
            return (0, 0)
    
    def _cubic_bezier_tangent(self, p0, p1, p2, p3, t):
        """
        Calculate tangent vector (first derivative) at parameter t.
        
        Args:
            p0, p1, p2, p3: Control points (x, y)
            t: Parameter [0, 1]
            
        Returns:
            Tangent vector (dx/dt, dy/dt)
        """
        try:
            # B'(t) = 3(1-t)²(P₁-P₀) + 6(1-t)t(P₂-P₁) + 3t²(P₃-P₂)
            t = max(0.0, min(1.0, t))  # Clamp t to [0, 1]
            mt = 1 - t
            mt2 = mt * mt
            t2 = t * t
            
            dx = 3 * mt2 * (p1[0] - p0[0]) + 6 * mt * t * (p2[0] - p1[0]) + 3 * t2 * (p3[0] - p2[0])
            dy = 3 * mt2 * (p1[1] - p0[1]) + 6 * mt * t * (p2[1] - p1[1]) + 3 * t2 * (p3[1] - p2[1])
            
            return (dx, dy)
        except:
            return (0, 0)
    
    def _cubic_bezier_curvature(self, p0, p1, p2, p3, t):
        """
        Calculate curvature at parameter t using the formula:
        κ(t) = |x'y'' - y'x''| / (x'² + y'²)^(3/2)
        
        Args:
            p0, p1, p2, p3: Control points (x, y)
            t: Parameter [0, 1]
            
        Returns:
            Curvature value (signed)
        """
        try:
            # First derivative (tangent)
            dx, dy = self._cubic_bezier_tangent(p0, p1, p2, p3, t)
            
            # Second derivative
            # B''(t) = 6(1-t)(P₂-2P₁+P₀) + 6t(P₃-2P₂+P₁)
            mt = 1 - t
            
            ddx = 6 * mt * (p2[0] - 2*p1[0] + p0[0]) + 6 * t * (p3[0] - 2*p2[0] + p1[0])
            ddy = 6 * mt * (p2[1] - 2*p1[1] + p0[1]) + 6 * t * (p3[1] - 2*p2[1] + p1[1])
            
            # Curvature formula
            cross_product = dx * ddy - dy * ddx
            velocity_squared = dx * dx + dy * dy
            
            if velocity_squared < 1e-10:  # Use small epsilon instead of exact zero
                return 0
            
            curvature = cross_product / (velocity_squared ** 1.5)
            
            # Clamp to prevent extreme values
            max_curvature = 1.0
            if abs(curvature) > max_curvature:
                return max_curvature if curvature > 0 else -max_curvature
            
            return curvature
        except:
            return 0
