/**
 * AGPL boundary guard for coregit-api.
 *
 * coregit-api is licensed under AGPL-3.0. Sibling repos coregit-api-wiki
 * and coregit-app are proprietary. An accidental import of proprietary
 * code into coregit-api/src/ would taint the whole api under AGPL-3.0
 * and break the commercial wiki licensing model.
 *
 * See CONTRIBUTING.md#agpl-boundary for the policy.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-proprietary-relative-imports',
      severity: 'error',
      comment:
        'AGPL boundary violation: coregit-api/src/ must not import from sibling proprietary repos (coregit-api-wiki, coregit-app). Such an import would taint coregit-api under AGPL-3.0 and break the commercial licensing model. See CONTRIBUTING.md#agpl-boundary.',
      from: { path: '^src/' },
      to: { path: '(^|/)(coregit-api-wiki|coregit-app)(/|$)' },
    },
    {
      name: 'no-proprietary-bare-imports',
      severity: 'error',
      comment:
        'AGPL boundary violation: bare-module imports of proprietary packages (coregit-api-wiki, coregit-app, @coregit/wiki, @coregit/app) are forbidden in coregit-api/src/.',
      from: { path: '^src/' },
      to: {
        path: '^(coregit-api-wiki|coregit-app|@coregit/(wiki|app))($|/)',
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'unknown'],
      },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['workerd', 'worker', 'node', 'import', 'require'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
