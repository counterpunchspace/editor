# Axes and stations

Variable font work is a set of explicit design locations connected by interpolation. Counterpunch shows those relationships so you can move between stations and the locations in between and watch shape continuity.

An **axis** is a design dimension such as weight or width. A **station** is a named location on one or more axes where you draw; it also carries metrics, alignment zones and kerning (Glyphs and UFO call it a master). The **default station** is the one the compiled font is built from. **Interpolation** is the generated shape between stations. The goal is shapes that stay coherent across the design space, not only at the extremes.

![Axis controls for the current design location](images/axes.png)

Define axes and stations in the Font Info panel (**Axes** and **Stations** tabs). In the Editor, the axis sliders move the current design location. Edit a glyph’s drawing at one station, then at another, and move the sliders to check the path between them. Compatible point structures matter. Smooth in-betweens are the target. A jump or kink on the slider usually means the drawings do not match.

A glyph that shows with **gray nodes and handles** is an interpolation which you can’t edit. Dragging a slider onto the location of a drawing immediately restores that drawing’s colored, editable outlines, still while the pointer is down. Drawing locations are marked with small filled dots on the slider track (the same color as the track segment they sit on). The thumb snaps to a mark within 2px when approaching it; after you rest on a mark, dragging away is smooth until you leave that 2px window, then it can snap again.

Drawings and free drawings are in [Drawing operations](05-drawing-operations.md). Terms are in the [Glossary](../reference/glossary.md).
