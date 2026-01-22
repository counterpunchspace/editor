# Counterpunch Font Editor

## Live App

Try the editor live:

- Latest official release (using `release.sh`): https://editor.counterpunch.space
- Latest preview (updated after each succesful push): https://preview.editor.counterpunch.space

Update to a newer version using the **reload button** that appears in the title bar after a new version got released. This invalidates the browser cache for this website and reloads all resources.

## Develop

Run the app locally with `cd webapp && npm run dev`

- Load assistant test conversation with `?assistant_style_test`

## Releasing a New Version

To create and deploy a new release, run the release script from the repository root:

```bash
./release.sh v1.0.0
```

This script automatically:

- Updates the version number in `webapp/coi-serviceworker.js`
- Extracts release notes from the "Unreleased" section in `CHANGELOG.md`
- Commits the version change
- Creates and pushes a git tag
- Triggers GitHub Actions to create a release and deploy to Cloudflare Pages

Users will see an orange update notification button in the title bar within 10 minutes and can reload to get the latest version without manually clearing their cache.

## Roadmap

### Pre-historic bootstrapping phase

- ✅ Bidirectional text shaping
- ✅ Super basic outline editing
- ✅ Live recompilation during editing
- ✅ Variable preview, live interpolation, animation
- ✅ Assistant generates Python code
- ✅ Canvas drawing plugins

### Pre-babelfont-ts Foundation (Due: Feb 2, 2026)

**Website and subscription system while waiting for `babelfont-ts`**

- ✅ Cloudflare setup
- ✅ Cloudflare Workers - AI Assistant Relay
- ✅ Authentication system - Passwordless
- ✅ Usage metering and billing sync
- ✅ User dashboard
- ✅ Stripe setup
- ✅ Website content
- ✅ Terms of service, privacy policy
- ✅ Configure custom domains
- ✅ Website design
- ✅ Canvas plugin system

### v0.2 (Due: Feb 15, 2026)

**`babelfont-ts` object model integration — Counterpunch becomes an analysis tool**

- ◻️ User file sytem I/O
- ✅ .glyphs I/O
- ✅ .vfj I/O
- ◻️ .vfb I/O
- ◻️ .glyphspackage I/O
- ◻️ .ufo/.designspace I/O
- ✅ .babelfont I/O
- ◻️ Python scripts I/O
- ◻️ Glyph overview
- ◻️ Glyph search and filtering
- ◻️ Glyph filtering plugins
- ◻️ Insert glyphs into editor text
- ◻️ OpenType feature code editor
- ◻️ Fontspector integration (incl. glyph-level messages)
- ◻️ Interactive demo

### v0.3 (Due: Mar 10, 2026)

**Counterpunch becomes a simple font editor**

- ◻️ Multi-line editing
- ◻️ Basic layer/glyph operations
- ◻️ Contour point manipulation
- ◻️ Component editing
- ◻️ Anchor editing
- ◻️ Guideline editing
- ◻️ Layer management UI
- ◻️ Undo/redo system
- ◻️ Clipboard operations
- ◻️ Selection tools
- ◻️ Font info editing
- ◻️ Master/instance management
- ◻️ Path operations (boolean)
- ◻️ Transform tools
- ◻️ Kerning UI
- ◻️ Automatic glyph metric updates

### v0.4 (Due: Apr 1, 2026)

**Extended features — Counterpunch becomes a full-featured font editor**

- ◻️ avar2 editor
- ◻️ Variable components
- ◻️ OpenType feature code generator
- ◻️ Glyph composition UI (OpenType ccmp)
- ◻️ Contextual kerning/positioning UI
- ◻️ Multiple font windows
- ◻️ Plugin system architecture complete

### v0.5 (Due: Apr 21, 2026)

Cleanup, documentation, testing, videos

- ◻️ Performance optimization
- ◻️ Memory usage optimization
- ◻️ Unit test coverage
- ◻️ Integration test suite
- ◻️ End-to-end tests
- ◻️ Browser compatibility testing
- ◻️ Code documentation
- ◻️ Load testing
- ◻️ User guide completion

### v0.6 Public Beta (Due: May 10, 2026)

- ◻️ Monitoring and analytics setup
- ◻️ Security and penetration testing
- ◻️ Demo video production
- ◻️ Public announcement

### v0.7...v0.9

Polish, incorporate user feedback

### v1.0 Public Release (Due: October 2026)
