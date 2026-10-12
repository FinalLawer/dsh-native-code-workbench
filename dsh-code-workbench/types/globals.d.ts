/**
 * Ambient declarations for the non-TypeScript edges of this package.
 *
 * Three things live here, none of which any installed `.d.ts` covers:
 *
 *  - the CSS import the client half performs, which esbuild inlines into the
 *    bundle but TypeScript has no module for;
 *  - the test seam the render smoke suite installs before loading the bundle;
 *  - the deep monaco-editor entry points, which the slim entry imports by file
 *    path because the package's own entry would pull in 81 grammars.
 */

/** esbuild turns a CSS import into an inlined stylesheet; TypeScript sees a module. */
declare module '*.css' {
  const css: string
  export default css
}

/**
 * The render smoke suite's Monaco substitution seam is deliberately **not**
 * declared in this file.
 *
 * `__CODE_WORKBENCH_TEST_MONACO__` exists only inside `test-client-smoke.mjs`,
 * which installs it on `globalThis` before evaluating the bundle. Declaring it
 * as a bare global — `declare var __CODE_WORKBENCH_TEST_MONACO__: unknown` —
 * makes a bare reference type-check, and that reference then throws
 * `ReferenceError` in a real page, where nothing defines it. It shipped once:
 * the tab body crashed, the shell logged `slot entry crashed in
 * "sidebar.right.pane.tab"`, and the right panel rendered blank.
 *
 * `src/client.ts` reads it as `globalThis.__CODE_WORKBENCH_TEST_MONACO__`,
 * which is a property access — `undefined` when absent, at compile time and at
 * runtime alike. Leaving the declaration out is what keeps it that way: a bare
 * reference to this name can no longer compile.
 */

/**
 * The loader the shipped client bundle registers itself with.
 *
 * `client.js` is a classic script, not a module: the DSH client module runtime
 * provides this global and reads the factory it is handed.
 */
declare var __ModuleLoader__: {
  load(entry: { id: string; factory: (require: (specifier: string) => unknown) => unknown }): void
}
