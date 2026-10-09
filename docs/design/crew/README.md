# Crew redesign mockup

The clickable reference for `docs/superpowers/specs/2026-10-08-crew-redesign-design.md`. Plain HTML, CSS and
JavaScript with sample data; the repository files, commits and branches in `repo-data.js` are a snapshot of
`choyiny/gitorange` from 8 October 2026.

```bash
python3 -m http.server -d docs/design/crew 8765
```

Then open http://localhost:8765/ (routes are hash routes, e.g. `#branches`, `#agent-data`, `#approvals`).
Theme preview: `?themeId=github`, `?themeId=claret&theme=dark`, `?pin=1`.

The mockup loads `agent-robot-avatar` from jsDelivr; the app bundles it from npm.
