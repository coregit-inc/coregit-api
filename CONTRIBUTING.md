# Contributing to Coregit

Thanks for your interest in contributing to Coregit! This guide will help you get started.

## Code of Conduct

Be respectful and constructive. We're building open infrastructure together.

## How to Contribute

### Reporting Bugs

Open a [GitHub issue](https://github.com/coregit-inc/coregit-api/issues) using the **Bug Report** template. Include:

- Steps to reproduce
- Expected vs actual behavior
- API response (status code, error body)
- SDK/CLI version if applicable

### Suggesting Features

Open an issue using the **Feature Request** template. Describe the use case, not just the solution.

### Submitting Code

1. Fork the repo and clone your fork
2. Install dependencies: `npm install`
3. Create a branch from `main`: `git checkout -b feat/my-feature`
4. Make your changes
5. Run checks:
   ```bash
   npx tsc --noEmit      # type-check
   npx vitest run         # tests
   ```
6. Push and open a PR against `main`

## Local Development

Coregit runs on Cloudflare Workers. For local dev:

```bash
# 1. Copy environment template
cp .env.example .dev.vars

# 2. Fill in your credentials (Neon DB, etc.)
#    At minimum you need DATABASE_URL and BETTER_AUTH_SECRET

# 3. Start local dev server
npm run dev
```

This starts `wrangler dev` which emulates Workers locally with access to your Cloudflare bindings.

### Database

Coregit uses Neon PostgreSQL with Drizzle ORM. To set up a dev database:

```bash
# Generate migrations from schema
npm run db:generate

# Apply to your Neon database
npm run db:push
```

### Running Tests

```bash
npm test               # run all tests
npx vitest run <file>  # run specific test file
npm run test:bench     # run benchmarks
```

## Guidelines

### Code Style

- **TypeScript strict mode** -- no `any` unless absolutely necessary
- Follow existing patterns in the codebase
- No unnecessary abstractions -- simple, direct code

### Pull Requests

- **One feature or fix per PR** -- keep them focused
- Write tests for new functionality
- Update types in `src/types/index.ts` if adding new env bindings
- Include a clear description of what and why

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add branch protection rules
fix: handle empty tree in diff endpoint
docs: update self-hosting guide
refactor: extract git object parsing
```

### Architecture Notes

- **Routes** go in `src/routes/` -- one file per resource
- **Services** go in `src/services/` -- shared business logic
- **Git internals** go in `src/git/` -- object parsing, storage, packfiles
- **Database schema** is in `src/db/schema.ts` (Drizzle ORM)
- All routes receive `c.env` with Cloudflare bindings (see `src/types/index.ts`)

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0](LICENSE).
