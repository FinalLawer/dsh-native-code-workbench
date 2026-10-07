/**
 * Slim monaco entry — the editor core without the dead weight.
 *
 * The stock `monaco-editor` entry bundles all 81 language grammars, the LSP
 * client external, and the 12 MB TypeScript language service (ts.worker). This
 * entry keeps:
 *
 *  - every editor contribution (`features/register.all.js` + the standalone
 *    tails `editor.main` adds): find, suggest, multi-selection, folding, rename,
 *    inline completions, …
 *  - the lightweight JSON language service (28 KB, worker-routed by label)
 *  - a curated grammar set for the languages a workspace actually contains
 *
 * and drops the TypeScript language service (TS/JS keep syntax highlighting
 * from `definitions/typescript` plus every editor feature) and the exotic
 * grammars. Expected effect: the bundle shrinks from ~10.4 MiB to ~4 MiB.
 */

// Editor contributions (the full `features/register.all.js` set).
import 'monaco-editor/features/register.all.js'
// The standalone tails `editor.main` adds beyond `features/register.all.js`.
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
// JSON language service: registers the language and loads its mode lazily; the
// worker is served by label through MonacoEnvironment (see build.mjs).
import 'monaco-editor/languages/features/json/register.js'

// Curated grammars (syntax highlighting).
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/scss/register.js'
import 'monaco-editor/languages/definitions/less/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/mdx/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/sql/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/powershell/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/java/register.js'
import 'monaco-editor/languages/definitions/csharp/register.js'
import 'monaco-editor/languages/definitions/cpp/register.js'
import 'monaco-editor/languages/definitions/go/register.js'
import 'monaco-editor/languages/definitions/rust/register.js'
import 'monaco-editor/languages/definitions/ruby/register.js'
import 'monaco-editor/languages/definitions/php/register.js'
import 'monaco-editor/languages/definitions/kotlin/register.js'
import 'monaco-editor/languages/definitions/swift/register.js'
import 'monaco-editor/languages/definitions/lua/register.js'
import 'monaco-editor/languages/definitions/dart/register.js'
import 'monaco-editor/languages/definitions/dockerfile/register.js'
import 'monaco-editor/languages/definitions/graphql/register.js'

// The API surface, exactly as the stock entry exports it.
export {
  CancellationTokenSource,
  Emitter,
  KeyCode,
  KeyMod,
  MarkerSeverity,
  MarkerTag,
  Position,
  Range,
  Selection,
  SelectionDirection,
  Token,
  Uri,
  editor,
  languages,
} from 'monaco-editor/editor/editor.api.js'
