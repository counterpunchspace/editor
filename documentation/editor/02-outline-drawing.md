# Outline drawing

Start with the drawing tools in the Editor title bar. Click a tool, then click on the canvas. The letter shortcuts `T`, `V`, `P`, `I`, and `C` select the same tools. Enter a glyph first (`Cmd/Ctrl+Enter` or double-click an outline). The tools other than Text stay unavailable until you are in outline editing.

![Drawing tools in the Editor title bar](images/edit-tools.png)

## Tools

- **Text** (`T`) leaves outline editing and returns to the text run.
- **Select** (`V`) clicks and drags points, handles, components, and other objects. Entering a glyph always starts on Select.
- **Pen** (`P`) draws a new contour point by point, or continues from a selected open end. Each click places a point. Click the first point to close, or connect to another open end to join two contours. While Pen is active, drawing can continue beyond the current glyph width; nearby glyphs are ignored so they do not steal the gesture.
- **Insert** (`I`) clicks a segment to add a node. It is enabled when the layer has path segments.
- **Convert** (`C`) clicks a straight segment to turn it into a curve. It is enabled when the layer has straight segments.
- **Cut** (toolbar only) clicks an on-curve node to open the contour there. Click a segment to insert a node at that point and cut in the same step. It is enabled when the layer has contours.

Pen only draws. Insert only inserts. Convert only converts. Cut only cuts. Switch back to Select when you want to move points.

## Select, move, and measure

With Select, click a point, then drag. Handles appear on curve points. Make small moves first so you can tell whether you changed one segment or the whole rhythm. Click a line or curve (away from its ends) to select that segment’s two on-curve nodes. Double-click selects the whole contour. Shift-click a segment to add or remove it: a neighbor already selected adds or removes only the new end node; a segment between two selected neighbors adds or removes both of its nodes and leaves the outer nodes selected. With objects already selected, `Cmd/Ctrl` does the same add/remove as Shift on nodes, segments, anchors, and components. Nodes, anchors, and path segments are picked before component fills. An anchor that sits on a node keeps a slightly larger pick ring around that node so the outer chrome is clickable.

Right-click a component and choose **Decompose** to replace it with the transformed outlines in that same place. Linked layers get the same action on the matching component; a background layer stays local. Automatic vs manual placement is in [Automatic composition](07-automatic-composition.md).

**Subtract** in the property panel marks selected paths as cutters (`fip001-boolean`). They punch a hole in everything below them in shape order; paths drawn later sit on top. Nodes stay editable. Cutter strokes are dashed. Cutter fill uses the same transparency as path fill (**Fill** in Editing View → View) and covers the whole cutter except where a later solid covers it. Solids below a cutter drop fill in the overlap, matching the compiled hole. Glyph overview tiles punch the same holes. Compile flattens any glyph that uses a cutter (including through components) and runs the same boolean. Linked layers get the flag at the same shape indexes.

Right-click selected shapes and open **Arrange** for **Bring Forward**, **Send Backward**, **Bring to Front**, and **Send to Back**. The same actions move mixed path and component selections together, including on linked layers.

Hold Tab in outline mode, then drag, to measure a custom distance.

## Curves and smooth points

Double-click an on-curve point in a curve to toggle smooth and corner. Hold Shift while dragging a smooth point’s off-curve handle to constrain it horizontally or vertically. Hold Alt/Option while dragging a smooth on-curve point to slide it along its handle axis while the handles stay put. Hold Alt/Option while dragging a corner on-curve point (including one with a curve on only one side) to move it freely while its handles stay put. Hold Alt/Option while dragging an off-curve that is not part of a smooth connection to keep it on its original direction from the on-curve point.

Open contour ends are always corners.

## Snapping

Node snapping is off by default. Turn it on from Editing View → View → Node Snapping. Drawing and dragging then snap to on-curve points in the glyph and neighbours, the dragged point’s original position, glyph edges, and vertical metric lines. Orange snap markers and guides draw fainter than the rest of the outline chrome. Open contour ends keep a red close/join bullseye even when Node Snapping is off: both ends of other open contours, and the start of the contour you are drawing when you hover it. The point you just placed is not a target. Two nodes on the same spot get a red circle; inspect whether that overlap is intentional.

A short practice: open `O`, `H`, or `n`; choose Pen; draw a short open contour; continue it and close it; switch to Insert and add a point; switch to Convert and turn a straight into a curve; switch to Cut and open the contour at a node; double-click an on-curve point to toggle smooth.

## Modifier shortcuts

When the tools feel familiar, you can keep Select active and hold modifiers instead of switching tools. These are the same actions as Pen, Insert, and Convert, without clicking the toolbar. Cut stays a toolbar tool.

Hold `Cmd/Ctrl` in empty glyph space with nothing selected to draw, or on a selected open end to continue that contour. With objects already selected, `Cmd/Ctrl+Click` adds or removes from the selection like Shift instead of inserting. With an empty selection, `Cmd/Ctrl+Click` on a segment inserts a point; on an on-curve point it cuts the contour open (the cut badge appears while that node is hovered). Guideline and sidebearing handles stay a plain-click drag; holding `Cmd/Ctrl` still places a point next to them when nothing is selected. `Alt/Option+Click` on a straight segment converts it to a curve. Drag one open end onto another to join or close.

While `Cmd/Ctrl` is held and nothing is selected, the toolbar highlights Pen, or Insert when an add-point preview is showing. While `Alt/Option` is held, it highlights Convert. Releasing the modifier returns the highlight to the sticky tool. Sticky Pen, Insert, Convert, and Cut stay single-purpose; the `Cmd/Ctrl` hold is what combines draw and insert by hover when the selection is empty.

Cutting a closed contour creates a new start and end at that point. Cutting an already open contour at another point splits it into two open contours.

Sidebearings are in [Sidebearing arithmetics](04-sidebearing-arithmetics.md). Shortcuts are in [Keyboard shortcuts](../reference/keyboard-shortcuts.md).
