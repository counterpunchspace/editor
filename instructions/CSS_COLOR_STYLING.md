# CSS Color Styling Guidelines

## Core Principle

**NEVER use hard-coded color values in CSS rules. ALWAYS define colors as CSS variables in the theme definitions and reference them.**

## Theme Variable System

All colors are defined as CSS variables in `/webapp/css/style.css` in two locations:

1. **Dark Theme (Default)**: `:root { ... }`
2. **Light Theme**: `:root[data-theme="light"] { ... }`

## How to Add New Colors

### Step 1: Define the Variable in Both Themes

Add your new color variable to BOTH theme definitions with appropriate values for each theme.

**Example - Adding a new button hover color:**

```css
/* Dark Theme */
:root {
  /* ... existing variables ... */
  --button-hover-accent: #ff00ff;
}

/* Light Theme */
:root[data-theme="light"] {
  /* ... existing variables ... */
  --button-hover-accent: #cc00cc;
}
```

### Step 2: Use the Variable in Your CSS Rules

Reference the variable using `var()` in your CSS rules:

```css
.my-button:hover {
  background-color: var(--button-hover-accent);
  color: var(--text-primary);
}
```

## Variable Naming Conventions

Use semantic names that describe the purpose, not the color:

### ✅ Good Names

- `--text-primary`, `--text-secondary`, `--text-muted`
- `--bg-primary`, `--bg-hover`, `--bg-active`
- `--border-primary`, `--border-active`
- `--accent-green`, `--accent-magenta` (for consistent brand colors)
- `--button-hover-bg`, `--input-focus-border`

### ❌ Bad Names

- `--dark-gray`, `--light-blue` (describes appearance, not purpose)
- `--color-1`, `--color-2` (non-descriptive)

## Theme-Specific Rules

When you need different styling logic (not just colors) between themes:

```css
/* Dark theme specific rule */
:root:not([data-theme="light"]) .my-element {
  background-color: var(--my-dark-bg);
  border-color: var(--my-dark-border);
}

/* Light theme specific rule */
:root[data-theme="light"] .my-element {
  background-color: var(--my-light-bg);
  border-color: var(--my-light-border);
}
```

## CSS Specificity

When applying colors to elements with ID selectors, ensure your color rules have sufficient specificity:

### ❌ Wrong - Will be overridden

```css
.my-class.active {
  color: var(--accent-color);
}
```

If element has `id="my-element"`, the ID selector wins.

### ✅ Correct - Use ID in color rule

```css
#my-element.active {
  color: var(--accent-color);
}
```

## Common Mistakes to Avoid

### ❌ WRONG: Hard-coded colors

```css
.button {
  background-color: #ff00ff; /* DON'T DO THIS */
  color: rgba(255, 255, 255, 0.8); /* DON'T DO THIS */
}
```

### ✅ CORRECT: Use variables

```css
.button {
  background-color: var(--accent-magenta);
  color: var(--text-tertiary);
}
```

### ❌ WRONG: Theme-specific hard-coded colors

```css
:root[data-theme="light"] .button {
  background-color: #cc00cc; /* DON'T DO THIS */
}
```

### ✅ CORRECT: Define variable, then use it

```css
/* In theme definitions */
:root[data-theme="light"] {
  --button-bg-active: #cc00cc;
}

/* In your rule */
:root[data-theme="light"] .button.active {
  background-color: var(--button-bg-active);
}
```

## Existing Variable Categories

Refer to these existing categories when adding new variables:

- **Background Colors**: `--bg-*`
- **Text Colors**: `--text-*`
- **Border Colors**: `--border-*`
- **Accent Colors**: `--accent-*`
- **View Border Colors**: `--view-*`
- **UI Components**: `--button-*`, `--input-*`, `--modal-*`, `--scrollbar-*`
- **AI Assistant**: `--ai-*`
- **Code Editor**: `--code-*`
- **Context Colors**: `--font-context-*`, `--script-context-*`
- **Auto-run Button**: `--autorun-*`

## Workflow for Adding Colors

1. **Identify the need**: You need a new color for a UI element
2. **Choose semantic name**: Pick a descriptive variable name following conventions
3. **Define in both themes**: Add the variable to `:root` and `:root[data-theme="light"]`
4. **Use the variable**: Reference with `var(--your-variable-name)` in CSS rules
5. **Test both themes**: Switch themes to verify colors work in both light and dark modes

## Benefits of This System

- **Easy theme switching**: Colors update automatically when user changes theme
- **Maintainability**: Change colors in one place, affects entire application
- **Consistency**: Reuse variables ensures visual consistency
- **Accessibility**: Easy to adjust color schemes for contrast requirements
- **No JavaScript color management**: All color logic in CSS where it belongs

## Never Use Inline Styles for Colors

Inline styles (set via JavaScript `element.style.color = '#ff00ff'`) override CSS and prevent theme switching from working correctly.

### ❌ WRONG: JavaScript sets colors

```javascript
element.style.backgroundColor = "#ff00ff";
element.style.color = "#ffffff";
```

### ✅ CORRECT: JavaScript toggles classes, CSS handles colors

```javascript
element.classList.toggle("active", isActive);
element.classList.toggle("focused", isFocused);
```

```css
.element.active {
  background-color: var(--accent-magenta);
  color: var(--text-primary);
}
```

---

**Remember**: If you find yourself typing a `#` or `rgb` value in a CSS rule, stop and create a variable instead!
