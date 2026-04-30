// Intentionally violates the AGPL boundary rule.
// Used by `npm run lint:agpl:fixture` to prove the guard catches relative
// imports of sibling proprietary repos. CI expects this to FAIL the lint.
//
// Do not import this file from src/. Do not "fix" the import.

// @ts-expect-error - target path is intentionally unresolved in this repo
import { wikiThing } from '../../../../coregit-api-wiki/src/wiki';

export const probe = wikiThing;
