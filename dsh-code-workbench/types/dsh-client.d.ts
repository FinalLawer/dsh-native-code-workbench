/**
 * The DSH **client-half** surface this plugin consumes.
 *
 * The shipped SDK declares `"types"` in its `package.json` files but does not
 * publish the `.d.ts` files those fields name, so nothing in the installed tree
 * describes `ctx`, the slot registry, or the right-sidebar controllers. These
 * declarations are written by hand against the authoritative reference in
 * `DSH-client-plugin-api-reference.md` (which cites file and line in the shipped
 * bundles for every signature).
 *
 * Scope is deliberate: **only what this plugin touches.** A declaration that
 * tried to model the whole SDK would be a second, unverifiable copy of it — and
 * one that silently drifts. What is here is the subset the two halves of this
 * package actually call, plus the shape of the values they receive.
 *
 * This file is an ambient script (no top-level import/export), so every member
 * lives in the global `DSH` namespace and needs no import at the use site.
 */

declare namespace DSH {
  // -------------------------------------------------------------------------
  // Shared primitives
  // -------------------------------------------------------------------------

  /** A React node, without making this ambient file a module. */
  type ReactNode = import('react').ReactNode
  /** A React element, as `React.createElement` returns. */
  type ReactElement = import('react').ReactElement
  /** A React function component. */
  type Component<P> = (props: P) => ReactNode

  /** Anything that can be torn down. What `ctx.effect` hands back. */
  interface Disposable {
    dispose(): void
  }

  /**
   * A teardown, as Cordis registrations return one.
   *
   * A bare function rather than a `Disposable` object, and the distinction is
   * load-bearing: `ctx.effect(() => ctx.slots.register(…))` returns this, and
   * the `conversation.chat.node` effect collects several of them in an array and
   * calls each one. A `Disposable` there would be an object with no call
   * signature — which is exactly what the compiler caught when this file first
   * declared them as `Disposable`.
   */
  type Disposer = () => void

  /** A Cordis effect body: run now, return the teardown. */
  type EffectBody = () => Disposer | void

  /**
   * The outcome of a Remote call.
   *
   * A discriminated union rather than a throwing call: `ok: false` carries the
   * typed `workspace-file/*` code the panel switches on, and the read failures
   * that mean "hand this to the document preview" are decided on that code.
   */
  type RemoteResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: { code: string; message?: string } }

  /** The host logger, as reached from either half. */
  interface Logger {
    debug(...args: unknown[]): void
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }

  // -------------------------------------------------------------------------
  // The slot contribution API (ctx.slots)
  // -------------------------------------------------------------------------

  /** A slot entry's chip label. */
  type SlotLabel = string | (() => string)

  /** How a slot dispatches among its occupants. */
  type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

  /** Which lifecycle a slot's occupants live under. */
  type SlotScope = 'root' | 'session-maybe' | 'session'

  /**
   * The options a registration passes.
   *
   * Which of `id` / `key` / `select` is required depends on the slot's `kind`:
   * a `list` needs `id`, a `keyed` slot needs `key`. The union is not modelled
   * here because the keys are only known at runtime from the slot catalog.
   */
  interface SlotRegistration {
    /** The slot key being contributed to. */
    name: string
    /** The cell identity, for `list` slots. */
    id?: string
    /** The dispatch key, for `keyed` slots. */
    key?: string
    /** Ordering within a `list` slot. */
    order?: number
    /** Shadowing band. */
    priority?: number
    /** The chip label. */
    label?: SlotLabel
    /** Child slots this entry declares it will render. */
    children?: Record<string, { kind: SlotKind; scope?: SlotScope }>
    /** Props this entry injects into its own component. */
    inject?: () => Record<string, unknown>
  }

  /** One committed entry in a slot, as `entries()` reports it. */
  interface SlotEntry {
    options: {
      name: string
      key?: string
      id?: string
      order?: number
      label?: SlotLabel
      priority?: number
    }
    /** The occupant, when it is a plain function component. */
    component?: unknown
  }

  /** The slot registry service. */
  interface SlotRegistry {
    /** Contribute an occupant to a slot. */
    register<P>(options: SlotRegistration, component: Component<P>): Disposer
    /** Contribute an occupant built lazily. */
    registerFactory<P>(options: SlotRegistration, component: Component<P>): Disposer
    /**
     * Install an effect for each declaration lifetime of a slot. Runs
     * synchronously when the declaration already exists, otherwise inside the
     * declaring `register()` call.
     */
    inject(key: string, callback: () => Disposer | void): Disposer
    /** The entries currently committed to a slot key. */
    entries(key: string): SlotEntry[]
  }

  // -------------------------------------------------------------------------
  // Settings (ctx.configForms)
  // -------------------------------------------------------------------------

  /** One write in a `mutate` batch. */
  interface ConfigOperation {
    op: 'set' | 'unset'
    path: string[]
    value?: unknown
  }

  /** The resolved view of one Host config entry. */
  interface ConfigFormSnapshot {
    value?: Record<string, unknown>
    base?: Record<string, unknown>
    user?: Record<string, unknown>
    revision: number
    writable: boolean
    status?: string
  }

  /** The controller for one Host config entry. */
  interface ConfigFormController {
    getSnapshot(): ConfigFormSnapshot
    subscribe(listener: () => void): Disposer
    set(field: string, value: unknown): Promise<boolean>
    unset(field: string): Promise<boolean>
    mutate(operations: ConfigOperation[], expectedRevision: number): Promise<boolean>
    enqueue(operation: unknown): void
    dispose(): void
  }

  /** The settings service. */
  interface ConfigForms {
    get(entryId: string): ConfigFormController
    describe(options?: { redactSecrets?: boolean }): unknown
    whileServed(namespaces: string[], register: (served: Set<string>) => Disposer): Disposer
  }

  // -------------------------------------------------------------------------
  // The right sidebar
  // -------------------------------------------------------------------------

  /** One guide-page entry box for a tab type. */
  interface SidebarRightGuideEntry {
    id: string
    order?: number
    title: () => string
    description?: () => string
  }

  /** A tab type's registration. */
  interface SidebarRightTabDefinition {
    /** Unique across every registration; also the key the body registers under. */
    id: string
    /** The page kind. Page types name no `patterns` and are opened by kind. */
    kind: string
    /** Globs over `dsh-resource://` addresses. */
    patterns?: string[]
    /** Shadowing band. */
    priority?: 'extension' | 'builtin' | 'fallback'
    /** Veto a pattern match. */
    canOpen?: (address: string) => boolean
    /** The tab chip text, captured at open time. */
    title: (address: string) => string
    /** Entry boxes for the guide page. */
    guide?: SidebarRightGuideEntry[]
    keepMounted?: boolean
    multiple?: boolean
  }

  /** The tab-type registry. */
  interface SidebarRightTabs {
    register(definition: SidebarRightTabDefinition): Disposer
  }

  /**
   * The navigation controller.
   *
   * `openResource` and `openTab` expand the panel themselves; `ctx.layout`'s
   * `openRightbar` only reports geometry and would leave it closed. Both throw
   * on an address or kind nothing claims, which is why the callers here treat
   * the boolean answer as the licence to report success.
   */
  interface SidebarRight {
    openResource(address: string, options?: Record<string, unknown>): void
    openTab(kind: string, options?: Record<string, unknown>): void
    close(tabId: string): void
    active(): unknown
    isExpanded(): boolean
    toggleExpanded(): void
    focus(tabId: string): void
  }

  // -------------------------------------------------------------------------
  // Workspace files (the read-only Remote namespace)
  // -------------------------------------------------------------------------

  /** How much of a file one `read` page asks for. */
  interface WorkspaceFileRange {
    /** 1-based first line. */
    offset?: number
    /** How many lines. */
    lines?: number
  }

  /** What `stat` reports. `version` is opaque to this plugin. */
  interface WorkspaceFileStat {
    absolutePath: string
    version: unknown
    bytes?: number
  }

  /** One page of text. */
  interface WorkspaceFileText extends WorkspaceFileStat {
    offset: number
    text: string
    lines: number
    eof: boolean
  }

  /** One directory entry. */
  interface WorkspaceDirectoryEntry {
    name: string
    type: 'file' | 'directory' | 'symlink' | 'other'
    size?: number
  }

  /** One directory listing. */
  interface WorkspaceDirectoryListing {
    path: string
    entries: WorkspaceDirectoryEntry[]
    truncated: boolean
  }

  /** One frame from the file watch stream. */
  type WorkspaceFileWatchFrame =
    | { kind: 'ready' }
    | { kind: 'change'; change?: unknown }

  /**
   * The `remote.workspaceFiles` namespace.
   *
   * `read` / `stat` / `list` answer a `RemoteResult`; `changes` does not. A
   * stream's frames arrive bare — `{ kind: 'ready' }` and
   * `{ kind: 'change', change }` — because the transport surfaces a stream
   * failure by ending the iteration rather than by yielding an error frame.
   * Wrapping them in a result type reads plausibly and is wrong: it makes every
   * frame fail an `ok === true` test, so the watch silently never reports ready
   * and never sees a change.
   */
  interface WorkspaceFilesRemote {
    read(
      sessionId: string,
      path: string,
      range: WorkspaceFileRange | undefined,
      signal?: AbortSignal,
    ): Promise<RemoteResult<WorkspaceFileText>>
    stat(sessionId: string, path: string, signal?: AbortSignal): Promise<RemoteResult<WorkspaceFileStat>>
    list(sessionId: string, path: string, signal?: AbortSignal): Promise<RemoteResult<WorkspaceDirectoryListing>>
    changes(sessionId: string, path: string, signal?: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
  }

  /** The `remote.session` namespace, reduced to the one call this panel makes. */
  interface SessionRemote {
    openWorkspacePath(
      request: { path: string; action: string },
      signal?: AbortSignal,
    ): Promise<RemoteResult<unknown>>
  }

  /** The envelope one `$stream` iteration yields. */
  interface StreamEnvelope<T> {
    value: T
    /** Acknowledge the frame, so the producer may advance. */
    accept(): void
  }

  /** A live stream: async-iterable, and disposable when the panel closes. */
  interface Stream<T> extends AsyncIterable<StreamEnvelope<T>> {
    dispose(): void
  }

  /** What `remote.$stream` is called with. */
  interface StreamSpec<T> {
    name: string
    open: (signal: AbortSignal) => AsyncIterable<T>
    ended: () => Error
  }

  /** `ctx.remote.$stream`, as the tab's inject face publishes it. */
  type StreamFactory = <T>(spec: StreamSpec<T>) => Stream<T>

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /** The session record fields this panel reads. */
  interface SessionRecord {
    cwd?: string
  }

  /** The sessions store, as `useSessions` selects from it. */
  interface SessionsState {
    byId?: Record<string, SessionRecord | undefined>
  }

  /** The `useSessions` hook the framework hands a session-scoped occupant. */
  type UseSessions = <T>(selector: (state: SessionsState) => T) => T

  /**
   * A Session scope, as `sessions.scope(id)` resolves it.
   *
   * `bail` is the scope's event dispatch: it runs the handler and reports
   * whether one accepted. The `slash/input-insert-reference` event is the
   * channel that puts a reference chip into the composer's draft.
   */
  interface SessionScope {
    bail(scope: SessionScope, event: string, payload: unknown): unknown
  }

  /** The sessions service face. */
  interface SessionsService {
    scope(sessionId: string): SessionScope | undefined
  }

  /** The composer's insertion actions, as the occupant receives them. */
  interface InputActions {
    /** Capture the caret span a reference should be spliced into. */
    captureInsertion(): unknown
  }

  // -------------------------------------------------------------------------
  // Input triggers (the `@` reference codec)
  // -------------------------------------------------------------------------

  /** What a reference expands to at submit time. */
  interface ReferenceCodec {
    serialize(reference: Record<string, unknown>): Promise<string>
  }

  /** A source of `@`-triggered references. */
  interface InputTriggerSource {
    trigger: string
    name: string
    label?: () => string
    codec: ReferenceCodec
  }

  /** The input-trigger service. */
  interface InputTriggers {
    registerSource(source: InputTriggerSource): Disposer
  }

  // -------------------------------------------------------------------------
  // Shortcuts
  // -------------------------------------------------------------------------

  /** One key chord. */
  interface ShortcutBinding {
    code: string
    modifiers: string[]
  }

  /** One read-only reference row in the shell's shortcut settings. */
  interface ShortcutCommand {
    id: string
    label: () => string
    keys: string[]
    bindings: ShortcutBinding[]
    group: string
  }

  /** The shortcuts service. */
  interface ShortcutsService {
    registerFixed(command: ShortcutCommand): Disposer
  }

  // -------------------------------------------------------------------------
  // The client context
  // -------------------------------------------------------------------------

  /**
   * `apply(ctx)`'s argument on the client half.
   *
   * An installed (static) plugin receives the real Cordis Context with the
   * services its `exports.inject` declared, so the service members below are
   * only populated for the names in that list. `remote` is reached as a whole
   * because `$stream` is a helper on the facade rather than a namespace.
   */
  interface ClientContext {
    effect(body: EffectBody, tag?: string): Disposable
    inject(services: readonly string[], callback: (scope: ClientContext) => void): Disposable
    on(event: string, listener: (...args: never[]) => void): Disposable
    once(event: string, listener: (...args: never[]) => void): Disposable
    get(name: string): unknown
    logger: Logger

    slots: SlotRegistry
    sidebarRightTabs: SidebarRightTabs
    sidebarRight: SidebarRight
    sessions: SessionsService
    shortcuts: ShortcutsService
    inputTriggers: InputTriggers
    configForms: ConfigForms
    remote: { $stream: StreamFactory }
    'remote.workspaceFiles': WorkspaceFilesRemote
    'remote.session': SessionRemote
  }

  // -------------------------------------------------------------------------
  // The tab body's props
  // -------------------------------------------------------------------------

  /**
   * What the renderer hands `CodePanel`.
   *
   * The body is registered as an occupant of `sidebar.right.pane.tab`, so it
   * receives the framework's session-scoped standard kit (`useSessions`,
   * `inputActions`, `sessionId`) plus whatever the registration's `inject`
   * callback returned — which is where the Remote namespaces and the settings
   * controller travel, under their dotted names.
   */
  interface CodePanelProps {
    sessionId: string
    useSessions: UseSessions
    inputActions: InputActions
    sidebarRight: SidebarRight
    'remote.workspaceFiles': WorkspaceFilesRemote
    'remote.session': SessionRemote
    'remote.stream': StreamFactory
    'sessions.scope': (sessionId: string) => SessionScope | undefined
    'settings.form': ConfigFormController | undefined
  }

  /** What the `settings.section` occupant receives. */
  interface SettingsSectionProps {
    renderSlot: (key: string, owner: Record<string, unknown>) => ReactNode
  }

  /** What the `settings.code-workbench.item` occupant receives. */
  interface SettingsItemProps {
    form: ConfigFormController | undefined
  }
}
