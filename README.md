# Counterpunch Font Editor

## Live App

Try the editor live:

- Latest official release (using `release.sh`): https://editor.counterpunch.space
- Latest preview (updated after each succesful push): https://preview.editor.counterpunch.space

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

### Pre-babelfont-ts Foundation (Due: Feb 2, 2026)

Website and subscription system while waiting for `babelfont-ts`

- [x] Cloudflare setup
- [x] Cloudflare Workers - AI Assistant Relay
- [x] Authentication system - Passwordless
- [x] Usage metering and billing sync
- [x] User dashboard
- [x] Stripe setup
- [x] Website content
- [x] Terms of service, privacy policy
- [x] Configure custom domains
- [x] Website design
- [x] Canvas plugin system

### v0.2 (Due: Feb 15, 2026)

`babelfont-ts` object model integration

- [x] .glyphs I/O
- [ ] .glyphspackage I/O
- [ ] .ufo I/O
- [x] .babelfont I/O
- [ ] .designspace I/O
- [ ] Glyph overview
- [ ] Glyph search and filtering
- [ ] Basic layer/glyph operations
- [ ] API documentation

### v0.3 (Due: Mar 10, 2026)

Core editing features

- [ ] Contour point manipulation
- [ ] Component editing
- [ ] Anchor editing
- [ ] Guideline editing
- [ ] Layer management UI
- [ ] Undo/redo system
- [ ] Clipboard operations
- [ ] Selection tools
- [ ] Grid and guides
- [ ] Font info editing
- [ ] avar2 editor
- [ ] variable components
- [ ] Master/instance management
- [ ] Multiple font windows
- [ ] Path operations (boolean)
- [ ] Transform tools

### v0.4 (Due: Apr 1, 2026)

Feature code, plugins, ccmp

- [ ] OpenType feature code editor
- [ ] Feature code validation
- [ ] Plugin system architecture
- [ ] Glyph composition UI (OpenType ccmp)

### v0.5 (Due: Apr 21, 2026)

Cleanup, documentation, testing, videos

- [ ] Performance optimization
- [ ] Memory usage optimization
- [ ] Unit test coverage
- [ ] Integration test suite
- [ ] End-to-end tests
- [ ] Browser compatibility testing
- [ ] Code documentation
- [ ] Load testing
- [ ] User guide completion

### v0.6 Public Beta (Due: May 10, 2026)

- [ ] Monitoring and analytics setup
- [ ] Security and penetration testing
- [ ] Demo video production
- [ ] Public announcement
