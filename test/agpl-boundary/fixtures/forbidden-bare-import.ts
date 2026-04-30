// Intentionally violates the AGPL boundary rule.
// Used by `npm run lint:agpl:fixture` to prove the guard catches bare-module
// imports of proprietary packages. CI expects this to FAIL the lint.

// @ts-expect-error - module is not declared and must never be added as a dep
import { appThing } from 'coregit-app/dist/server';

export const probe = appThing;
