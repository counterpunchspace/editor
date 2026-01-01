# Milestone Issues Plan

## January 2026 - Pre-babelfont-ts Foundation

### Infrastructure

- [ ] **Website/user account infrastructure**

  - User registration and login system
  - Password reset and email verification
  - User profile management
  - Database schema for users

- [ ] **Payment/subscription integration with Stripe**

  - Stripe integration for AI assistant subscription
  - Monthly billing setup
  - Webhook handlers for payment events
  - Subscription management UI

- [ ] **Legal documents**
  - Privacy policy
  - Terms of Service
  - Cookie policy
  - GDPR compliance

### Core Features

- [ ] **Implement Undo/Redo Phase 1**

  - Install fast-json-patch or jsondiffpatch
  - Create undo-manager.ts with stack-based undo
  - Hook into beforePythonExecution/afterPythonExecution
  - Add Cmd+Z and Cmd+Shift+Z keyboard shortcuts
  - Add undo/redo buttons with stack depth indicator

- [ ] **Implement Undo/Redo Phase 2 - Transaction Granularity**

  - Batch rapid changes (point dragging → single undo entry)
  - Handle begin drag/end drag semantics in canvas
  - Python scripts as single undo entries
  - Add transaction descriptions for undo UI

- [ ] **Copy/paste outline data**
  - Copy selected paths/nodes to clipboard
  - Paste paths/nodes with proper positioning
  - Support cross-glyph copy/paste
  - Handle clipboard data formats

### Documentation & Planning

- [ ] **Basic documentation structure**

  - Set up documentation framework (markdown/static site)
  - Create table of contents
  - Placeholder sections for user guide, API docs, plugin guide

- [ ] **Plugin system architecture design**
  - Design plugin registration system
  - Define plugin API interfaces
  - Document plugin lifecycle
  - Create example plugin templates

---

## v0.2 (Due Feb 2) - babelfont-ts Migration + Variable Components

### Critical Migration

- [ ] **Migrate object model to babelfont-ts**

  - Replace current babelfont-model.ts with babelfont-ts
  - Update all class references
  - Migrate getters/setters to new structure
  - Update type definitions

- [ ] **Port existing features to babelfont-ts**

  - Update glyph canvas to use new model
  - Update Python integration layer
  - Update font-manager.ts
  - Update all UI components

- [ ] **Port undo/redo to babelfont-ts structure**

  - Adapt undo manager to new data structures
  - Test undo/redo with new model
  - Update transaction boundaries

- [ ] **Update canvas rendering for babelfont-ts**
  - Update outline-editor.ts
  - Update component rendering
  - Update selection handling
  - Update measurement tools

### Variable Components

- [ ] **Variable component data structures**

  - Add variable component support to object model
  - Define axis mapping data structures
  - Component instance variation support

- [ ] **Variable component UI**

  - Component variation axis controls
  - Per-instance axis value sliders
  - Variable component palette/browser

- [ ] **Variable component interpolation**

  - Implement variable component interpolation logic
  - Preview interpolation in canvas
  - Integration with live preview system

- [ ] **Variable component canvas rendering**
  - Render variable components with current axis values
  - Update component bounds calculation
  - Handle nested variable components

### Other Features

- [ ] **Basic fontinfo editing UI**

  - Name table editing (family name, style name, etc.)
  - Version number editing
  - Copyright and license info
  - Font metadata (designer, vendor, etc.)

- [ ] **Axis manager with designspace/userspace mapping**

  - Visual editor for axis definitions
  - Map designspace values to userspace values
  - Axis naming and display configuration
  - Integration with font variation preview

- [ ] **avar2 visual editor**

  - Axis mapping curve editor
  - Per-axis mapping UI
  - Curve manipulation tools (bezier handles)

- [ ] **avar2 preview and testing**

  - Live preview of axis mappings
  - Before/after comparison
  - Integration with variation slider preview

- [ ] **Regression testing after migration**

  - Test all existing features with babelfont-ts
  - Fix migration bugs
  - Performance testing

---

## v0.3 (Due March 2) - Core Editing Features

### Outline Editing

- [ ] **Smooth on-curve nodes with preserved off-curve directions**

  - Implement tangent preservation algorithm
  - Auto-adjust off-curve points when moving smooth nodes
  - Visual feedback for smooth vs corner nodes

- [ ] **Handle type conversions (smooth ↔ corner)**

  - UI for converting node types
  - Preserve outline quality during conversion
  - Keyboard shortcuts for node type changes

- [ ] **Intelligent tangent preservation**

  - Maintain curve smoothness when editing
  - Handle edge cases (endpoints, inflection points)
  - Undo/redo support for tangent operations

- [ ] **Selection and multi-node editing improvements**

  - Multi-node selection
  - Proportional scaling of selections
  - Align/distribute selected nodes

- [ ] **Grid settings and snapping**

  - Configurable grid spacing
  - Grid visibility toggle
  - Snap-to-grid toggle
  - Smart snapping (points, guidelines, grid)

- [ ] **Guidelines**

  - Global guidelines (font-wide)
  - Local guidelines (per-glyph)
  - Guideline dragging and positioning
  - Guideline snapping

- [ ] **Kerning UI**
  - Kerning pairs list/editor
  - Visual kerning adjustment in preview
  - Group kerning support
  - Import/export kerning data

### Layer Management

- [ ] **Delete layers**

  - UI for layer deletion
  - Confirmation dialog
  - Prevent deletion of last layer
  - Undo support

- [ ] **Add layers via interpolation**

  - UI for creating interpolated layers
  - Select source masters for interpolation
  - Set axis locations for new layer
  - Preview interpolation before creating

- [ ] **Add layers via extrapolation**

  - Extrapolation UI
  - Define extrapolation factors
  - Validation and bounds checking

- [ ] **Layer UI improvements**
  - Layer visibility toggles
  - Layer reordering
  - Layer naming
  - Master/instance coordination

### Undo/Redo Phase 3

- [ ] **Implement Yjs infrastructure**

  - Install Yjs dependencies
  - Create state-manager.ts wrapper
  - Mirror babelfontData to Yjs (async, debounced)
  - Set up IndexedDB persistence via y-indexeddb

- [ ] **Migrate undo from JSON patches to Yjs UndoManager**
  - Replace JSON patch system with Yjs undo
  - Test undo/redo with Yjs
  - Ensure transaction boundaries work correctly

### Glyph Overview

- [ ] **Glyph overview foundation**

  - Grid view of all glyphs
  - Glyph search/filter UI
  - Glyph sorting options

- [ ] **JavaScript-based filter plugin architecture**
  - Plugin registration system
  - Filter API definition
  - Example filters (missing glyphs, empty glyphs, etc.)

### File I/O Integrations

- [ ] **Github integration for file I/O**

  - Load font source via URL parameter
  - OAuth2 authentication with Github
  - Commit changes via Github API
  - Conflict resolution and pull request workflow

- [ ] **File System Access API integration**

  - Directory picker and permission management
  - Simple file manager UI for local directory
  - Read/write files to user's disk
  - File watching for external changes

- [ ] **Support for nested folder structures (.designspace/.ufo/.glyphspackage)**
  - Parse nested folder formats
  - Write back to nested folder formats
  - Workaround for Rust babelfont limitations (virtual file system or pre/post processing)
  - .designspace file support
  - .ufo file support
  - .glyphspackage file support

---

## v0.4 (Due April 1) - Feature Editing + Plugins

### Feature Editing

- [ ] **Feature code editor UI**

  - Code editor component integration (Monaco/CodeMirror)
  - FEA syntax highlighting
  - Line numbers and code folding

- [ ] **Feature code integration with compilation**
  - Send feature code to compiler
  - Handle compilation errors
  - Live preview of feature effects

### Python Plugin System

- [ ] **Python-based feature code generator plugins**

  - Plugin API for feature generators
  - Registration/discovery system
  - Plugin loading from wheels

- [ ] **Example feature generator plugins**

  - Kern feature generator
  - Mark/mkmk feature generator
  - Liga feature generator
  - Plugin documentation/templates

- [ ] **Python script UI manager**
  - Script editor with syntax highlighting
  - Save scripts to on-disk file structure
  - Open/edit saved scripts
  - Script organization (folders, categories)
  - Script execution from UI
  - Script library/examples

### Glyph Filters

- [ ] **JavaScript filter plugins**

  - Additional JS filter examples
  - Filter composition
  - Filter UI controls

- [ ] **Python filter plugins**

  - Python filter API
  - Example Python filters
  - Filter performance optimization

- [ ] **Filter UI and controls**
  - Filter dropdown/selection
  - Filter parameters UI
  - Save/load filter presets

### Glyph Composition

- [ ] **Port Python glyph name generator to JavaScript**

  - Convert glyph name generation logic from Python to JS
  - Unicode/AGD integration
  - Production name generation

- [ ] **Glyph composition UI (OpenType ccmp)**
  - UI for defining glyph compositions
  - Map base glyphs to component glyphs
  - Generate ccmp feature code
  - Preview composed glyphs
  - Not visual composition in editor (OpenType-only)

### Website

- [ ] **Website content completion**

  - Landing page
  - Feature descriptions
  - Pricing page
  - Documentation portal

- [ ] **User onboarding flow**
  - Welcome tour
  - Sample fonts/projects
  - Tutorial tooltips
  - Getting started guide

### Simon's Work (starts here)

- [ ] **Precise compilation error reporting with line numbers**

  - Parser error line/column extraction
  - OpenType table error mapping
  - Human-readable error messages
  - Error severity levels

- [ ] **Integrate error reporting into UI**
  - Display errors in feature editor
  - Error highlighting in code
  - Click-to-jump to error location
  - Error list panel

---

## v0.5 (Due May 1) - Advanced Features Complete

### Documentation

- [ ] **User guide completion**

  - Getting started
  - Editing workflows
  - Feature editing guide
  - Plugin usage

- [ ] **Plugin development guide**

  - Plugin API reference
  - Creating custom plugins
  - Plugin examples and patterns
  - Publishing plugins

- [ ] **API documentation**

  - Object model API docs
  - Python API reference
  - JavaScript API reference
  - Auto-generated from code

- [ ] **Video tutorials**
  - Basic editing (2-3 min)
  - Variable fonts (3-4 min)
  - Plugin usage (2-3 min)
  - Feature editing (3-4 min)

### Testing & Optimization

- [ ] **AI subscription integration testing**

  - End-to-end payment flow
  - Subscription activation/cancellation
  - Usage tracking and limits
  - Billing portal

- [ ] **Performance optimization**

  - Canvas rendering profiling
  - Compilation caching improvements
  - Font loading optimization
  - Memory leak detection

- [ ] **End-to-end testing**

  - Full workflow testing
  - Cross-browser testing
  - Mobile/tablet testing
  - Accessibility testing

- [ ] **Security review**

  - XSS vulnerability check
  - CSRF protection
  - Authentication security
  - API security audit

- [ ] **Load testing**

  - Simulate concurrent users
  - Large font handling
  - Memory usage under load
  - Cloudflare Workers performance

### Deployment Infrastructure

- [ ] **Setup Cloudflare Pages deployment pipeline**

  - Configure build scripts for Cloudflare Pages
  - Set up environment variables and secrets
  - Configure custom domain and SSL

- [ ] **Cloudflare Pages first deployment test**

  - Deploy to staging environment
  - Test PWA functionality
  - Verify CORS headers
  - Test SharedArrayBuffer support

- [ ] **Cloudflare Pages continuous deployment setup**

  - Auto-deploy from main branch
  - Preview deployments for PRs
  - Rollback functionality

- [ ] **Cloudflare Pages production deployment configuration**

  - Production environment setup
  - CDN configuration
  - Performance optimization

- [ ] **Cloudflare CDN optimization**
  - Cache headers optimization
  - Edge caching configuration
  - Asset compression
  - Performance monitoring

---

## v0.6 Public Beta (Due May 10) - Launch

### Polish

- [ ] **Final bug fixing**

  - Critical bug triage
  - UX polish issues
  - Edge case handling

- [ ] **Final performance optimization**
  - Profiling and bottleneck identification
  - Lazy loading improvements
  - Bundle size optimization

### Launch Preparation

- [ ] **Demo video production**

  - Script and storyboard
  - Screen recording and editing
  - Feature showcase videos
  - Social media clips

- [ ] **Security and penetration testing**

  - Third-party security audit
  - Vulnerability scanning
  - Penetration testing
  - Security fixes

- [ ] **Monitoring and analytics setup**

  - Cloudflare Analytics integration
  - Error tracking (Sentry or similar)
  - Performance monitoring
  - User analytics (privacy-focused)

- [ ] **Support documentation and materials**

  - FAQ
  - Troubleshooting guide
  - Support ticket system
  - Community guidelines

- [ ] **Beta user onboarding**
  - Welcome emails
  - Onboarding materials
  - Beta feedback form
  - User community setup

### Launch

- [ ] **Soft launch to initial beta users**

  - Invite-only beta group
  - Monitor initial usage
  - Gather feedback

- [ ] **Monitor and address critical issues**

  - Real-time error monitoring
  - Hot-fix deployment process
  - User support response

- [ ] **Public announcement**
  - Blog post
  - Social media announcement
  - Font community outreach
  - Press release (if applicable)
