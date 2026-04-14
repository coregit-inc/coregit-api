# Contributing to Coregit

Thanks for your interest in contributing!

## Getting Started

1. Fork the repo
2. Clone your fork
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b my-feature`
5. Make your changes
6. Run type checks: `npx tsc --noEmit`
7. Run tests: `npx vitest`
8. Push and open a PR

## Local Development

```bash
cp .dev.vars.example .dev.vars  # fill in your credentials
npx wrangler dev
```

## Guidelines

- TypeScript strict mode — no `any` unless absolutely necessary
- Keep PRs focused — one feature or fix per PR
- Write tests for new functionality
- Follow existing code style

## Reporting Issues

Open a [GitHub issue](https://github.com/coregit-inc/coregit-api/issues) with steps to reproduce.

## License

By contributing, you agree that your contributions will be licensed under AGPL-3.0.
