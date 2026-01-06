# contxt Font Editor

## Live App

Try the editor live at https://fonteditor-863.pages.dev

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
