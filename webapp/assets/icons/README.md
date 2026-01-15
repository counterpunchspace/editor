# PWA Icons

This directory contains placeholder icons for the Progressive Web App.

## Required Icon Sizes

For a complete PWA, you need PNG icons in the following sizes:

- 72x72
- 96x96
- 128x128
- 144x144
- 152x152
- 192x192 (required for Android)
- 384x384
- 512x512 (required for Android)

## Creating Icons

You can use the provided `icon.svg` as a base and convert it to PNG files:

### Using ImageMagick (recommended):

```bash
# Install ImageMagick if needed
brew install imagemagick

# Generate all icon sizes
for size in 32 72 96 128 144 152 192 384 512; do
  magick convert -background none -resize ${size}x${size} icon.svg icon-${size}x${size}.png
done
```

### Using online tools:

1. Visit https://realfavicongenerator.net/ or similar
2. Upload your SVG or design
3. Download all required sizes

### Using design software:

- Export the SVG at each required size using Figma, Sketch, or Adobe Illustrator

## Maskable Icons

For Android adaptive icons, ensure your 192x192 and 512x512 icons have important content in the "safe zone" (center 80% of the image) as edges may be cropped.
