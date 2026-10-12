/**
 * The DSH **Host-half** surface this plugin consumes.
 *
 * Companion to `dsh-client.d.ts`, and written for the same reason: the shipped
 * SDK declares `"types"` without publishing the files it names. The signatures
 * below follow the reference in `DSH-client-plugin-api-reference.md` §5, which
 * quotes the live `fs` and `connection` service catalogs.
 *
 * The `get()` overloads are the interesting part. `ctx.get(name)` is an
 * optional lookup returning `unknown`, and every call site in `src/host/index.ts`
 * names a service it must then narrow by hand. Giving the four names this
 * package actually asks for their own overload turns that hand-narrowing into a
 * checked one, while the fallback overload keeps the escape hatch honest.
 */

declare namespace DSH {
  // -------------------------------------------------------------------------
  // Filesystem
  // -------------------------------------------------------------------------

  /** An opaque, resolved filesystem location. */
  interface FsTarget {
    /** The identity two targets are compared by. */
    targetKey: string
    /** The path as a person would read it. */
    displayPath: string
  }

  /** What `stat` reports about a target. `version` is opaque. */
  interface FsStat {
    targetKey: string
    displayPath: string
    version: unknown
    size?: number
  }

  /** One directory entry, as `listDir` reports it. */
  interface FsDirectoryEntry {
    name: string
    type: 'file' | 'directory' | 'symlink' | 'other'
    target: FsTarget
    size?: number
  }

  /**
   * What a write expects to find.
   *
   * `createIfAbsent` refuses when the name is taken; `replaceIfVersion` refuses
   * when the file on disk is not the version the caller observed, which is the
   * guard that turns a lost race into `FS_STALE_VERSION` instead of a silent
   * clobber.
   */
  type FsWriteIntent =
    | { kind: 'createIfAbsent' }
    | { kind: 'replaceIfVersion'; version: unknown }

  /** What a write actually did. */
  interface FsWriteOutcome {
    operation: 'create' | 'update'
    version: unknown
    /** The content before the write, or null when the file did not exist. */
    before: string | null
    after: string
  }

  /** The session's standing permission mode, as `sandboxPolicy.resolve` reports it. */
  interface SandboxExecutionPolicy {
    mode: string
  }

  /** The filesystem service. */
  interface FsService {
    resolve(path: string, options?: { cwd?: string }): Promise<FsTarget>
    contains(parent: FsTarget, child: FsTarget): boolean
    stat(target: FsTarget): Promise<FsStat | undefined>
    readText(target: FsTarget, signal?: AbortSignal): Promise<string>
    listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirectoryEntry[]>
    writeText(
      target: FsTarget,
      content: string,
      intent?: FsWriteIntent,
      signal?: AbortSignal,
      policy?: SandboxExecutionPolicy,
    ): Promise<FsWriteOutcome>
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  /** The Host-side session record fields this half reads. */
  interface HostSession {
    header?: { cwd?: string }
  }

  /** The Host sessions service. */
  interface HostSessionsService {
    get(sessionId: string): HostSession | undefined
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  /**
   * The admission decision for one request.
   *
   * An optional field rather than a union, because the runtime answer is a bare
   * `{}` when admitted: the key is simply absent. Callers therefore test
   * `admission.rejection !== undefined`, which is the one form the compiler can
   * narrow — `'rejection' in admission` cannot, since `{}` is structurally
   * assignable to any object type that declares the key as optional.
   */
  interface Admission {
    /** The HTTP status to refuse with; absent when the request is admitted. */
    rejection?: number
  }

  /** One registered HTTP route. */
  interface FetchRoute {
    path: string
    methods: string[]
    /** How the dispatcher should read the body before handing it over. */
    requestBody: 'buffered' | 'stream' | 'none'
    fetch: (request: Request) => Response | Promise<Response>
  }

  /** The Connection service: the shared, authenticated `/api` channel. */
  interface ConnectionService {
    /** Re-check admission for a request the channel already dispatched. */
    admit(request: Request): Admission
    fetch: {
      register(route: FetchRoute): DSH.Disposer
    }
  }

  // -------------------------------------------------------------------------
  // Optional services, reached through `ctx.get`
  // -------------------------------------------------------------------------

  /** Resolves the session's standing sandbox policy. */
  interface SandboxPolicyService {
    workspaceRoot?: string
    resolve(options: { session: HostSession | undefined }): SandboxExecutionPolicy | undefined
  }

  /** The DSH credential store. */
  interface CredentialsService {
    resolve(reference: string): Promise<{ value?: string } | undefined>
  }

  /** The signed-in account's grant issuer. */
  interface DeepseekAccountService {
    /** Answers only for an origin the account service trusts. */
    resolveToken(origin: string): Promise<string | undefined>
  }

  /** Records a line in the session's own record. */
  interface SessionFeedbackService {
    record(entry: { sessionId: string; text: string }): void
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /** The execution handle a tool call receives. */
  interface ToolExecution {
    signal: AbortSignal
    agent?: { session?: HostSession }
  }

  /** One content block a tool renders. */
  interface ToolContent {
    type: string
    text: string
  }

  /** A registry-ready tool definition. */
  interface ToolDefinition<A = Record<string, unknown>, V = unknown> {
    name: string
    description: string
    parameters: Record<string, unknown>
    output: {
      schema: Record<string, unknown>
      render: (args: A, value: V) => ToolContent[]
    }
    timeoutMs: number
    execute(args: A, execution: ToolExecution): Promise<V>
  }

  /** The tool registry. */
  interface ToolsService {
    /** Register one tool. Generic so a typed definition reaches `execute` intact. */
    register<TArgs, TValue>(definition: ToolDefinition<TArgs, TValue>): DSH.Disposer
  }

  // -------------------------------------------------------------------------
  // Settings (Host side)
  // -------------------------------------------------------------------------

  /** One Host config entry, as `describe` reports it. */
  interface SettingsDescription {
    ns: string
    value?: Record<string, unknown>
  }

  /** The Host settings service. */
  interface SettingsService {
    configure(options: { auto: boolean }, fiber: unknown): DSH.Disposer
    describe(options?: { redactSecrets?: boolean }): SettingsDescription[]
  }

  // -------------------------------------------------------------------------
  // The Host context
  // -------------------------------------------------------------------------

  /**
   * `apply(ctx, config)`'s first argument.
   *
   * `inject` is what scopes a handler to the services it declared: the callback
   * runs once every named service exists, and the returned disposers live under
   * `ctx.effect`. The `get` overloads name the four optional services this
   * package looks up; the last overload keeps the general lookup available.
   */
  interface HostContext {
    effect(body: DSH.EffectBody, tag?: string): DSH.Disposable
    inject(services: readonly string[], callback: (scope: HostContext) => void): DSH.Disposable
    on(event: string, listener: (...args: never[]) => void): DSH.Disposable
    logger: DSH.Logger
    /** Present on a plugin loaded with a fiber; the settings service is scoped to it. */
    fiber?: unknown

    connection: ConnectionService
    fs: FsService
    sessions: HostSessionsService
    tools: ToolsService
    settings: SettingsService

    get(name: 'sandboxPolicy'): SandboxPolicyService | undefined
    get(name: 'credentials'): CredentialsService | undefined
    get(name: 'deepseekAccount'): DeepseekAccountService | undefined
    get(name: 'sessionFeedback'): SessionFeedbackService | undefined
    get(name: string): unknown
  }
}
