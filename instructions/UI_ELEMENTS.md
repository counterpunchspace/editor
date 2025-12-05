# UI Elements Guidelines

## Standard Components

This document describes the standard UI components used throughout the application. Always use these existing components rather than creating custom variations.

## Info Button

Use the `.info-icon-btn` class for help/information buttons throughout the app.

### Icon

**Always use the `help` icon** (question mark) from Material Symbols, not the `info` icon:

```html
<button class="info-icon-btn" id="my-info-btn" title="More information">
  <span class="material-symbols-outlined">help</span>
</button>
```

### Characteristics

- **Color**: Blue (`--accent-blue`)
- **Opacity**: 0.7 default, 1.0 on hover
- **Size**: 16px icon
- **Behavior**: Scales to 1.1x on hover
- **Position**: Typically inline after a label

### Usage

```html
<label class="settings-item-label">
  Feature Name
  <button
    class="info-icon-btn"
    id="feature-info-btn"
    title="Feature information"
  >
    <span class="material-symbols-outlined">help</span>
  </button>
</label>
```

## Info Popup

Use the `.info-popup-*` classes for help dialogs and informational overlays.

### Structure

```html
<div class="info-popup-overlay" id="my-popup" style="display: none;">
  <div class="info-popup">
    <div class="info-popup-header">
      <h3>Popup Title</h3>
      <button class="info-popup-close" id="my-popup-close">
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
    <div class="info-popup-content">
      <!-- Your content here -->
      <p>Explanation text...</p>

      <h4>Section Title</h4>
      <ul>
        <li>Point one</li>
        <li>Point two</li>
      </ul>

      <p class="info-highlight">💡 Important highlighted information</p>
    </div>
  </div>
</div>
```

### Components

1. **`.info-popup-overlay`**: Full-screen backdrop
   - Dark overlay with blur effect
   - Flexbox centered
   - Click outside to close
   - Escape key to close

2. **`.info-popup`**: Main container
   - Max width 500px
   - Max height 80vh
   - Rounded corners (8px)
   - Slide-up animation

3. **`.info-popup-header`**: Title bar
   - Contains `<h3>` title
   - Close button on right
   - Bottom border separator

4. **`.info-popup-content`**: Scrollable content area
   - Supports `<h4>` subsections
   - Supports `<p>`, `<ul>`, `<li>` standard elements
   - Custom scrollbar styling
   - Use `.info-highlight` class for highlighted paragraphs

### JavaScript Setup

Standard pattern for popup interaction:

```javascript
const infoBtn = document.getElementById("my-info-btn");
const popup = document.getElementById("my-popup");
const closeBtn = document.getElementById("my-popup-close");

// Open popup
infoBtn.addEventListener("click", (e) => {
  e.preventDefault();
  popup.style.display = "flex";
});

// Close popup - close button
closeBtn.addEventListener("click", () => {
  popup.style.display = "none";
});

// Close popup - click outside
popup.addEventListener("click", (e) => {
  if (e.target === popup) {
    popup.style.display = "none";
  }
});

// Close popup - Escape key (with priority handling)
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && popup.style.display === "flex") {
    e.preventDefault(); // IMPORTANT: Prevents other Escape handlers from running
    e.stopPropagation(); // IMPORTANT: Stops event propagation
    popup.style.display = "none";
  }
});
```

**Important**: Always call `e.preventDefault()` and `e.stopPropagation()` in the Escape key handler. This ensures that popups are closed before other UI elements (like the settings panel) when multiple elements are open.

### Styling Classes

- **`.info-highlight`**: Use for important callout paragraphs
  - Colored left border (blue accent)
  - Light background
  - Extra padding

### Features

- ✅ Theme-aware (adapts to light/dark themes)
- ✅ Smooth animations (fade-in, slide-up)
- ✅ Backdrop blur effect
- ✅ Responsive design
- ✅ Custom scrollbar
- ✅ Keyboard accessible (Escape to close)
- ✅ Click-outside-to-close
- ✅ **Priority handling**: Popups close before other UI elements when Escape is pressed

### Escape Key Priority

When multiple overlays are open (e.g., popup + settings panel), pressing Escape will:

1. Close the popup first (highest priority)
2. Require another Escape press to close the settings panel

This is achieved by:

- Popup handlers calling `e.preventDefault()` and `e.stopPropagation()`
- Settings panel handler checking `e.defaultPrevented` before closing

## When to Use

- **Info Button + Popup**: Complex explanations, feature documentation, help content
- **Tooltip** (future): Short hints on hover
- **Modal Dialog** (future): Actions requiring user input/confirmation

## Design Principles

1. **Consistency**: Always use the standard info button and popup styles
2. **Accessibility**: Ensure keyboard navigation works (Escape, Tab, Enter)
3. **Clarity**: Use clear hierarchy in popup content (h4 for sections)
4. **Feedback**: Provide hover states and visual feedback for interactive elements
5. **Responsiveness**: Components should work on various screen sizes

## Don't

- ❌ Don't use the `info` icon - use `help` (question mark) instead
- ❌ Don't create custom modal styles - use `.info-popup-*` classes
- ❌ Don't use inline styles - use CSS classes
- ❌ Don't forget to add close handlers (button, outside click, Escape key)
- ❌ Don't make popups too wide (max-width: 500px is optimal)

---

**See Also**: `/instructions/CSS_COLOR_STYLING.md` for color theming guidelines
