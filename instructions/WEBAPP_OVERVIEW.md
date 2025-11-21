# Web App Overview

## Purpose

A browser-based font editor with live compilation and rendering capabilities.

## Architecture

- **Editor**: Interactive outline editing with visual feedback
- **Compilation**: Fonts are compiled in-browser from serialized babelfont JSON files using fontc and babelfont-rs compiled in WebAssembly
- **Rendering**: Compiled OpenType fonts are shaped using harfbuzz-js and displayed with editable outlines overlayed
- **Workflow**: Edit → Serialize to JSON → Compile via fontc-wasm → Shape with HarfBuzz → Render with overlay

## Key Technologies

- **fontc (WASM)**: Compiles babelfont JSON to OpenType fonts in the browser
- **babelfont-rs**: Bridges the serialized JSON font to fontc
- **harfbuzz-js**: Shapes the compiled font for accurate text rendering

## Live Feedback

The editor provides real-time visualization of how outline edits affect the final rendered font, combining the precision of the compiled font with the interactivity of editable vector paths.

## Development Instructions

If necessary, create command-line workflows for development and testing, for instance to proof font compilation via node using the compiled fontc wasm binary ("test-compiler" folder), as you can easily debug its output without user interaction.

## Compilation Testing

The "test-compiler" folder contains the file Fustat.json.babelfont, which is an official conversion from babelfont-rs. It shall form the basis for offline compilation testing.
