/**
 * Side-effect-only monaco entry points that ship without type declarations.
 *
 * `src/monaco-entry.ts` imports these by file path to pull their editor
 * contributions into the bundle — find, suggest, folding, inline completions,
 * and the standalone string table. Each one is imported for its side effect
 * alone: nothing is bound, so the only thing TypeScript needs to know is that
 * the module exists.
 *
 * The package publishes `.d.ts` files for 31 of the 41 paths the slim entry
 * imports; these 10 are the remainder, and monaco exposes them through its
 * `"./*.js": "./esm/vs/*.js"` export map rather than as a typed subpath.
 * Declaring them here is narrower than relaxing `noImplicitAny` and keeps the
 * untyped surface visible in one place.
 */

declare module 'monaco-editor/editor/browser/coreCommands.js'
declare module 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
declare module 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js'
declare module 'monaco-editor/editor/contrib/find/browser/findController.js'
declare module 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
declare module 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js'
declare module 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
declare module 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
declare module 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js'
declare module 'monaco-editor/editor/common/standaloneStrings.js'
