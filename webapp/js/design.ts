// Design utilities for color manipulation and visual styling

/**
 * Adjusts a color's hue and lightness
 * @param {string} colorString - Color in rgba(), rgb(), or hex format
 * @param {number} hueDegrees - Degrees to shift hue on color wheel (-360 to 360)
 * @param {number} lightnessPercent - Percentage to adjust lightness (-100 to 100, negative makes darker)
 * @returns {string} Color in rgba() format
 */
export function adjustColorHueAndLightness(
    colorString: string,
    hueDegrees: number,
    lightnessPercent: number
): string {
    let r, g, b, a;

    // Parse the color string
    const rgbaMatch = colorString.match(
        /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
    );
    const hexMatch = colorString.match(/^#([0-9a-fA-F]{6})$/);

    if (rgbaMatch) {
        r = parseInt(rgbaMatch[1]) / 255;
        g = parseInt(rgbaMatch[2]) / 255;
        b = parseInt(rgbaMatch[3]) / 255;
        a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    } else if (hexMatch) {
        const hex = hexMatch[1];
        r = parseInt(hex.substr(0, 2), 16) / 255;
        g = parseInt(hex.substr(2, 2), 16) / 255;
        b = parseInt(hex.substr(4, 2), 16) / 255;
        a = 1;
    } else {
        return colorString; // Can't parse, return original
    }

    // Convert RGB to HSL
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h,
        s,
        l = (max + min) / 2;

    if (max === min) {
        h = s = 0; // achromatic
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                break;
            case g:
                h = ((b - r) / d + 2) / 6;
                break;
            case b:
                h = ((r - g) / d + 4) / 6;
                break;
        }
    }

    // Shift hue
    h = (h! + hueDegrees / 360) % 1;
    if (h < 0) h += 1;

    // Adjust lightness (negative percentage makes it darker)
    l = Math.max(0, Math.min(1, l * (1 + lightnessPercent / 100)));

    // Convert HSL back to RGB
    let r2, g2, b2;
    if (s === 0) {
        r2 = g2 = b2 = l; // achromatic
    } else {
        const hue2rgb = (p: number, q: number, t: number): number => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r2 = hue2rgb(p, q, h + 1 / 3);
        g2 = hue2rgb(p, q, h);
        b2 = hue2rgb(p, q, h - 1 / 3);
    }

    // Return as rgba string
    return `rgba(${Math.round(r2 * 255)}, ${Math.round(g2 * 255)}, ${Math.round(b2 * 255)}, ${a})`;
}

/**
 * Desaturates a color to grayscale
 * @param {string} colorString - Color in rgba(), rgb(), or hex format
 * @returns {string} Desaturated color in rgba() format
 */
export function desaturateColor(colorString: string): string {
    let r, g, b, a;

    // Parse the color string
    const rgbaMatch = colorString.match(
        /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/
    );
    const hexMatch = colorString.match(/^#([0-9a-fA-F]{6})$/);

    if (rgbaMatch) {
        r = parseInt(rgbaMatch[1]);
        g = parseInt(rgbaMatch[2]);
        b = parseInt(rgbaMatch[3]);
        a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1;
    } else if (hexMatch) {
        const hex = hexMatch[1];
        r = parseInt(hex.substr(0, 2), 16);
        g = parseInt(hex.substr(2, 2), 16);
        b = parseInt(hex.substr(4, 2), 16);
        a = 1;
    } else {
        return colorString; // Can't parse, return original
    }

    // Convert to grayscale using luminance formula
    const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);

    // Return as rgba string
    return `rgba(${gray}, ${gray}, ${gray}, ${a})`;
}

// Export for module use (Node.js/Jest)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { adjustColorHueAndLightness, desaturateColor };
}
