# Draw New Outlines Tutorial Process

This document describes the local-only pipeline used to generate the tutorial video for drawing new outlines in Counterpunch.

## Goal

Produce a 1080p tutorial that:

- uses the Regular `n` from `webapp/examples/Fustat.glyphs` as the real reference shape
- keeps only the editor view visible during recording
- forces the page into a 16:9 capture layout
- starts directly on the tutorial content, with startup/loading trimmed out of the final export
- uses Inter for all capture-only text overlays
- shows a visible tutorial cursor with nearby modifier labels such as `cmd` and `option`
- keeps the tutorial cue card centered along the bottom edge
- generates narration first in chunks, then records the video against those chunk durations

## Scripts

The pipeline lives in `webapp/scripts/tutorial/`.

- `outline-scenes.mjs`: scene metadata and narration text
- `generate-outline-tutorial-audio.mjs`: Gemini TTS generation with Aoede, then 1.1x speed-up via ffmpeg
- `record-outline-tutorial.mjs`: Playwright capture against the local dev server
- `assemble-outline-tutorial.mjs`: ffmpeg muxing to the final H.264 mp4
- `make-outline-tutorial.mjs`: runs the full pipeline in order

## Output Location

All generated assets are written to:

- `webapp/temp/tutorial-draw-new-outlines/`

Key artifacts:

- `manifest.json`
- `audio/*.wav`
- `video/draw-new-outlines-raw.webm`
- `final/draw-new-outlines-1080p.mp4`

## Narration

Narration is generated scene by scene with Gemini TTS using the Aoede voice.

- The scripts read `VERTEX_AI_API_KEY`, `GOOGLE_API_KEY`, or `GEMINI_API_KEY` from the local shell environment.
- Each chunk is saved first as raw WAV.
- ffmpeg applies `atempo=1.1` so the final timing is based on the sped-up narration, not on the original generation.
- Per-scene end padding is added with ffmpeg so the on-screen actions have a little silence to breathe.
- The measured per-chunk durations are stored in `manifest.json` and treated as targets, not hard limits.

## Recording Layout

The recording script injects a capture-only stylesheet into the running app.

- It hides the toolbar and all non-editor views.
- It stretches the editor to the full 1920x1080 viewport.
- It forces light mode for the recording pass.
- It hides outline guidelines and suppresses the editing metrics underlay.
- It injects Inter-based cue cards plus a visible recording-only cursor overlay.
- Modifier labels are rendered next to the cursor instead of in a detached corner overlay.
- The normal pointer is rendered with a dark outline so it stays visible on the pale canvas.

The recorder writes a trim offset into `manifest.json`, and the assembly step uses that offset so the final mp4 begins on the prepared intro view rather than on the application startup.

## Geometry Strategy

The script does not delete the original Fustat outline.

- It leaves that contour visible as the reference.
- It draws a duplicate contour to the right, offset beyond the original bounds.
- The duplicate geometry is derived from the currently selected Regular drawing at record time rather than from a hard-coded node list.
- No additional thick contour overlay is drawn on top of the editor paths; the video uses the editor's native rendering.

This is simpler and more legible than erasing the reference shape before recording.

## Editor Actions Used On Camera

The visible tutorial uses real editor gestures:

- `cmd`-click to draw the on-curve skeleton
- `alt`-click on line segments to convert them to curves
- double-click on on-curve points to toggle smoothness
- drag off-curve handles to refine the result

The redraw geometry is still derived from the actual Fustat contour, so the final duplicate lands on the original structure rather than on hand-written placeholder geometry.

## Preconditions

Before running the recorder:

1. The local dev server must be available at `https://localhost:8000`.
2. `ffmpeg` and `ffprobe` must be installed and available on `PATH`.
3. A valid Gemini-compatible API key must be present in the shell environment.

## Run Commands

From `webapp/`:

```bash
npm run tutorial:outline:audio
npm run tutorial:outline:record
npm run tutorial:outline:assemble
```

Or all at once:

```bash
npm run tutorial:outline:make
```

## Constraints

- The scene durations are hints, not frame-accurate editorial locks.
- The final assembly currently caps the export at just under two minutes to stay inside the requested duration range.
- The recorder currently assumes the selected Fustat `n` contour can be reconstructed by drawing all on-curves first and then converting the curve-bearing segments.
- If the editor behavior changes around command drawing, line-to-curve conversion, or smooth toggling, the recording script will need recalibration.

## Test Mode Note

- `webapp/js/glyph-canvas/renderer.ts` now suppresses the top-left text buffer readout in test mode as well, so test captures no longer show the `Text: ...` debug label.
- Existing screenshot expectations were not updated in this change.
