# Curvature Comb Canvas Plugin

A canvas plugin for the Context Font Editor that visualizes curve curvature by drawing a curvature comb.

## Features

- **Pure Python Implementation**: All curvature calculations done in Python (no external dependencies)
- **Cubic Bezier Support**: Analyzes cubic bezier curve segments
- **Visual Feedback**: Color-coded filled shapes show curvature intensity
- **Interactive UI**: Adjustable scale via slider control
- **Per-Path Normalization**: Each path gets its own color scale for better visibility
- **Configurable**: Adjustable sample rate and visual parameters

## What is a Curvature Comb?

A curvature comb is a visualization tool that shows how the curvature of a curve changes along its length. It draws perpendicular shapes at regular intervals, where:

- **Shape size** represents the magnitude of curvature at that point
- **Shape direction** extends perpendicular to the curve's tangent
- **Color gradient** indicates curvature intensity:
  - **Gray**: Low curvature (gentle curves)
  - **Yellow**: Medium curvature
  - **Red**: High curvature (sharp curves)

This helps font designers:

- Identify kinks or discontinuities in curves
- Ensure smooth, harmonious curve transitions
- Detect areas where curve quality could be improved
- Compare curvature between different parts of a glyph

## UI Controls

After activating the plugin, a slider appears in the plugin dropdown:

- **Scale** (1000-10000, default 5000): Controls the visual scale of the curvature visualization
  - Lower values = smaller visualization
  - Higher values = larger visualization for fine details

## Mathematics

The plugin uses the standard curvature formula for parametric curves:

```
κ(t) = |x'(t)y''(t) - y'(t)x''(t)| / (x'(t)² + y'(t)²)^(3/2)
```

For cubic Bezier curves B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃:

- First derivative B'(t) gives the tangent vector
- Second derivative B''(t) gives the acceleration
- Curvature is calculated from the cross product of these derivatives

## Building

```bash
# Make the build script executable
chmod +x build.sh

# Build and install
./build.sh
```

This will:

1. Build a Python wheel
2. Copy it to `webapp/wheels/`
3. Update `webapp/wheels/wheels.json`

## Configuration

Advanced users can modify class constants in `plugin.py`:

```python
SAMPLES_PER_CURVE = 20        # Number of samples per curve segment (more = smoother)
DEBUG = False                 # Enable debug logging
```

Note: The `SCALE_FACTOR` is now controlled via the UI slider and no longer needs manual configuration.

## Implementation Details

- **Curve Detection**: Identifies cubic bezier segments by looking for the pattern: on-curve → off-curve → off-curve → on-curve
- **Sampling**: Evaluates curvature at evenly spaced parameter values (t) along each curve
- **Perpendicular Calculation**: Rotates the tangent vector 90° to find the perpendicular direction
- **Coordinate System**: Accounts for font coordinate system where Y-axis points upward

## Usage

Once built and loaded, the plugin automatically draws curvature combs on all cubic bezier curves in the current glyph. The visualization appears above the glyph outline.

## License

GPL-3.0-or-later
