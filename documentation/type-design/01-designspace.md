# Designspace, stations and drawings

A variable font is not one design but a continuous range of designs. You draw a few of them by hand, and the font computes (interpolates) everything in between. This page explains the words Counterpunch uses for the parts of that system and how they differ. The same words appear in the interface, in the handbook and in the Python API.

![A designspace box with three axes: weight, width and optical size. Light and Bold sit at both ends of the weight axis, Display at the largest optical size, halfway along weight, and Wide at the far end of the width axis, halfway along weight. Light is the default station. Each station has a drawing at the same location, and a free drawing for Regular sits on the weight axis between Light and Bold.](images/designspace.svg)

## Designspace and axes

An **axis** is one way the design can vary, such as weight (`wght`), width (`wdth`) or optical size (`opsz`). Each axis has a minimum, a maximum and a default value. Together, the axes span the **designspace**: with one axis it is a line, with two a plane, and with three a box like the one in the figure. A font can have more axes than three; the principle stays the same, it only gets harder to draw n-dimensional spaces.

A **location** is any point in the designspace, written as one value per axis, for example `wght 650, wdth 100, opsz 12`. The axis sliders in the editor set the **current location**. Every other term on this page is something that sits at a location.

## Stations

A **station** is a named location that the whole font shares. It carries the font-wide information that belongs to that location: its name, its axis values, its vertical metrics and alignment zones, and its kerning. In the figure, Light, Bold, Wide and Display are stations.

Its name, vertical metrics, and alignment zones are purely design-time aids to help a designer navigate and comprehend; they bear no meaning for the compiled font. But kerning needs to be defined at a certain location, and stations are the place for it.

One station is the **default station**. Apps that ignore variations show it, and the compiled font is built from it. In the figure it is Light, marked with a second ring, at the default location of all axes.

You do not need a station on every corner of the designspace. Older multiple-master workflows put a master on each corner, which doubles the work with every new axis. Variable fonts only need stations where the design actually changes character. The figure has four stations for three axes: Light and Bold at both ends of the weight axis, which is common practice, and one more station halfway along weight for each other axis: Wide at the far end of the width axis and Display at the largest optical size. Everything between them is interpolated.

Stations are listed in **Font Info → Stations**. Glyphs calls them _masters_; designspace files call them _sources_.

## Drawings

A **drawing** is one glyph’s outline at one station: its contours, components, anchors and advance width. Each glyph normally has one drawing per station. In the figure, the filled dot inside each station ring is a drawing of one glyph. They sit at the same location but are not the same thing: the station belongs to the whole font, the drawing to one glyph.

To interpolate, all drawings of a glyph must be **compatible**: the same contours with the same points in the same order. Then the font can blend any two drawings into the shapes between them.

The drawing you are editing is the **current drawing**. When the current location matches no stored drawing, the canvas shows an **interpolated view** with gray points instead. You can look at it but not edit it.

Glyphs calls these _layers_; designspace files call them _glyph in a source_.

## Free drawings

A **free drawing** is a drawing of one glyph at a location of its own, not at a station. It only exists in that one glyph, so it carries no font-wide metrics or kerning.

Free drawings fix problems in a single glyph without adding a station to the whole font. In the figure, a glyph has a free drawing at the Regular weight, between Light and Bold, for example because its bowl fills in too early there. All other glyphs interpolate straight from the stations.

Glyphs calls these _brace layers_; designspace files call them _sparse sources_.

## Background drawings

A **background drawing** is a reference outline behind a drawing, for example an earlier version or a traced sketch. It is shown on the canvas but never interpolated or exported.

## Variations

A **variation** is an alternate set of a glyph’s drawings that replaces the **base glyph** inside part of the designspace, for example a dollar sign whose stroke disappears above `wght 700`. Each variation has its own drawings at the stations, and can have free drawings too. The editor lists them under **Variations**.

Glyphs calls them _bracket layers_; designspace files call them _rules_.

## Instances

An **instance** is a named location that you export, either as a separate static font or as a named style inside the variable font, such as Bold or Light Display. Instances are output: they hold no drawings of their own. They can sit anywhere, on a station or between stations. For example, a Regular instance could sit halfway between the Light and Bold stations.

## Layers

A **layer** is one color layer of a drawing in a color font. In Counterpunch, “layer” never means a glyph’s outline at a location; we call that a drawing.

## How the terms relate

| Term | Belongs to | Has a location | Holds outlines | Role |
| --- | --- | --- | --- | --- |
| Location | — | is one | no | Where something sits |
| Station | the whole font | yes | no, but metrics and kerning | Input: where you draw |
| Drawing | one glyph, at one station | the station’s | yes | Input |
| Free drawing | one glyph | its own | yes | Input |
| Background drawing | one drawing | the drawing’s | yes, for reference | Reference |
| Variation | one glyph | an axis range | yes, its own drawings | Input |
| Instance | the whole font | yes | no | Output: what you ship |
| Layer | one drawing | the drawing’s | yes, one color | Part of a drawing |

The short version: stations say where the font is drawn, drawings and free drawings are what is drawn, and instances are what you ship.

## Names in other apps

| Counterpunch | Glyphs | Designspace and UFO |
| --- | --- | --- |
| Station | Master | Source |
| Drawing | Master layer | Glyph in a source |
| Free drawing | Brace layer | Sparse source |
| Variation | Bracket layer | Rule |
| Instance | Instance (export) | Instance |

Counterpunch reads and writes these formats with their own names, so nothing changes in your files. Working with axes and stations in the editor is in [Axes and stations](../editor/03-axes-stations.md). Adding and removing drawings is in [Drawing operations](../editor/05-drawing-operations.md). All terms are in the [Glossary](../reference/glossary.md).
