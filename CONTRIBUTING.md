# Contributing to GitOrange

Thanks for your interest in contributing.

## Licensing of contributions

GitOrange is licensed under the [Apache License 2.0](LICENSE). There is no CLA. By opening a pull request you agree that your contribution is licensed under the same license, and that you have the right to license it.

## Getting started

1. Fork the repository and clone your fork.
2. `yarn install`
3. Follow [Local development](docs/development.md).

## Making changes

1. Branch from `main`.
2. Make your change, with Vitest coverage for backend behavior (`worker/src/__tests__/`).
3. `yarn format`, `yarn typecheck`, and `yarn test` — CI runs all three, plus `yarn build`.
4. If you changed the schema, run `yarn db:generate` and commit the generated migration. Never hand-write migration SQL or edit `worker/src/db/auth.schema.ts`.
5. Open a pull request against `main` describing what changed and why.

## Code style

- TypeScript strict mode in the Worker and the SPA.
- Hono + Zod OpenAPI routes; Drizzle for D1 queries; `db.batch` for multi-statement writes (D1 has no interactive transactions).
- The UI uses GitHub's Primer CSS classes; match the surrounding components.
- Tests never mock `env.DB`; use the in-memory Artifacts fake for git storage.

## Reporting issues

Open an issue with what you expected, what happened, and steps to reproduce.
