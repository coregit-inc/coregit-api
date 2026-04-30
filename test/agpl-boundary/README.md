# AGPL boundary fixtures

This directory contains intentionally non-compliant code used to verify the
AGPL boundary CI guard (see `.dependency-cruiser.cjs` and `.github/workflows/agpl-boundary.yml`).

The `fixtures/` directory MUST NOT be moved into `src/`, MUST NOT be imported
from `src/`, and MUST always cause `npm run lint:agpl:fixture` to exit
non-zero. CI inverts the exit code: a passing fixture lint means the guard is
broken.

If you are adding new types of forbidden imports we want to block, add a new
fixture file here and reference it from the workflow.
