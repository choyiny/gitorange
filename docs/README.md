# GitOrange documentation

**Deploy and operate**

- [Setup](setup.md) — deploy your own instance by hand (or run `/gitorange-onboarding` in Claude Code).
- [Configuration](configuration.md) — every `wrangler.jsonc` key and secret the worker reads.
- [Architecture](architecture.md) — how the Worker, D1, and Artifacts fit together.
- [Local development](development.md) — run, test, and change GitOrange locally.
- [Reviewer agents and auto-merge](auto-merge.md) — who reviews each pull request commit, when a pull request lands, its states, and stacking.
- [Skipping irrelevant tests](ci-relevance.md) — `gitorange/relevance@v1`: Clef decides which test jobs a change can affect.
