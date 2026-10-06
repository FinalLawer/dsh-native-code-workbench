# DSH Web client-half plugin API — exact reference

Source of truth: the extracted runtime copy at `ref\dsh\node_modules\@deepseek-ai\`.
Version of every package cited: **0.2.0-rc.2** (peer `@deepseek-ai/cordis ~4.0.4`).

**Line-number convention.** Every file in this copy has exactly one junk line prepended at line 1
(`。`, `ls>`, `};`, `}}}} {`, …), so the numbers below are as observed in this copy and
**upstream line = observed − 1**. All line numbers below are observed.

**Two independent confirmations are used.** Besides the shipped code, three Inspect providers are
live in this runtime and were queried: `host/Service` (worked), and the
`client/Service`, `client/Event`, `client/Slots`, `client/Theme`, `client/Builtin` providers
(listed, but all client queries **timed out after 10 s — no Harness page is connected to this
session**, so no live client data could be read; everything client-side below comes from the
shipped bundles).

---

## 0. How a client-half plugin is packaged (read this first)

A client plugin is an ordinary npm package with **two halves** and a `package.json` declaration.

### 0.1 `package.json` declaration

`ref\dsh\node_modules\@deepseek-ai\dsh-client-ui-sidebar-files\package.json:14-41`

```json
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":         { "default": "./lib/index.js" },
    "./client":  { "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-workspace-files",
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-shortcuts"
      ],
      "platform": "web"
    }
  },
```

The validator for that block is `parseDshClient(pkgName, value)`
(`dsh-client-modules\lib\client.js:61-75`); accepted members are exactly:

```js
return {
  platform: decl.platform,                       // string, required
  ...inject     !== void 0 ? { inject }     : {}, // string[] — PACKAGE names, not service keys
  ...external   !== void 0 ? { external }   : {}, // string[] — exact non-baseline module requests
  ...decl.immediately !== void 0 ? { immediately: decl.immediately } : {} // boolean
};
```

`immediately: true` appears only on the kernel packages themselves (e.g. `dsh-client-modules\package.json:33-38`).
A plugin that needs a non-baseline shared library lists it under `dsh.client.external`; the baseline
seed is React + Cordis + static UI libraries only (`dsh-client-modules\README.md:47`).

### 0.2 The two halves

| Half | Built from | Runs where | Runtime shape |
|---|---|---|---|
| Host | `lib/index.js` (`main`) | Node process | real Cordis plugin: `export const Config = z.object({…})`, `export function apply(ctx, config)` |
| Client | `lib/client.js` (`./client`), built by tsdown | browser page | a script calling `window.__ModuleLoader__.load({id, factory})`; the factory returns a **lazy-CJS** exports object |

The client bundle preamble (`dsh-client-modules\lib\client.js:2-7`):

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-modules",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
```

and every client plugin bundle ends with the same export shape, e.g.
`dsh-client-ui-sidebar-files\lib\client.js:1020-1022`:

```js
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
```

So the contract a client half must satisfy is **`exports.apply(ctx)` plus an optional
`exports.inject` (array of service keys) and `exports.name`** (e.g.
`dsh-client-hmr\lib\client.js:83-85` sets all three). `exports.Config` exists on exactly one
shipped client half (`dsh-client-ui-conversation\lib\client.js:18460`) — see §7.3.

**Critical:** the `dsh.client.inject` array in `package.json` names **packages** (bundle rows, for
load ordering), while the runtime `exports.inject` array names **service keys**. Do not confuse them.
`dsh-client-ui-sidebar-files\lib\client.js:934-941`:

```js
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs",
			"sidebarRight",
			"remote",
			"remote.workspaceFiles"
		];
```

---

## 1. `dsh-client-modules` — module runtime, lifecycle, `ctx`

### 1.1 Import specifiers and exported symbols

| Specifier | Module | Exports |
|---|---|---|
| `@deepseek-ai/dsh-client-modules` | `lib/index.js` (Node half) | `ClientModuleRegistry`, `default` (= `ClientModuleRegistry`), `bootInjections`, `orderByModuleGraph`, `stripClientSuffix` — single statement at `lib\index.js:981` |
| `@deepseek-ai/dsh-client-modules/client` | `lib/client.js` (browser half) | `ClientModuleSystem`, `apply`, `createClientModuleSystem`, `exactPackageSpecifier`, `inject`, `parseBootManifest`, `parseDshClient`, `stripClientSuffix`, `tearDownEntryFiber` — `lib\client.js:871-879` |
| `@deepseek-ai/dsh-client-modules/invariant` | `lib/invariant.js` | invariant companion (`package.json:26-29`) |

`exports` map: `package.json:17-32`. The `/client` subpath and the bare id resolve to the *same*
exports because "a plugin bundle IS its package's client half" (`lib\client.js:90-100`,
`stripClientSuffix`).

### 1.2 How a bundle is loaded

`createClientModuleSystem(target, bootstrapModule, options)` — `lib\client.js:850-858`:

```js
function createClientModuleSystem(target, bootstrapModule, options) {
  return new ClientModuleSystem({
    manifest: parseBootManifest(options.boot),
    staticModules: options.staticModules,
    registrationTarget: target,
    bootstrapModule,
    ...options.loadBundle === void 0 ? {} : { loadBundle: options.loadBundle }
  });
}
```

`parseBootManifest(wire)` (`lib\client.js:108+`) validates `window.__DSH_BOOT__`:
`{ rev: string, entries: {id,url,rev,inject,external}[], batches: {phase:'bootstrap'|'application',url,rev,entries}[] }`.

`inject = ["loader"]` (line 860) and the plugin body (lines 861-869):

```js
		function apply(ctx) {
			const modules = ctx.loader.internal;
			if (modules?.version !== "client") throw new Error("client-modules: the Loader has no client module system");
			ctx.reflect.provide("modules", modules);
		}
```

### 1.3 `ctx.modules` — the client module system

`class ClientModuleSystem` — `lib\client.js:506`. Public members used elsewhere in the tree:
`version = "client"` (507), `entries` (509, a `ClientEntries`), `import(specifier)` (743),
`prefetch(id)` (758), `invalidate(id, rev)` (824), private `loadCache` / `factories` / `graphRows`.

Load semantics (`README.md:39, 69`): a bundle script only **registers a factory**; module bodies
(including CSS injection) run at first materialization; require cycles throw. Resolution order is
platform seed → memoized record → boot-graph row → registered factory → throw.

### 1.4 What `ctx` is — two different objects

**(a) Installed (static) client plugin.** `apply(ctx)` receives a real Cordis `Context` with the
services its `exports.inject` declared. Available verbs include `ctx.effect(fn, tag)`,
`ctx.inject(services, cb)`, `ctx.on/once`, `ctx.get(name)`, `ctx.provide`, `ctx.reflect.provide`,
`ctx.logger`, and the timer mix-ins. Real usage of service-scoped injection:
`dsh-client-ui-sidebar-files\lib\client.js:948` — `ctx.inject(["shortcuts"], (ctx) => { … })`.

**(b) Dynamic package browser half** (host-runner + client-runner `cordis_run`). Here `apply`
receives a **whitelisting proxy**, not the real Context — `dynamicCordisContext(ctx, env)`,
`dsh-cordis-client-runner\lib\client.js:328-358`. The allowed surface is:

```
CTX_VERBS = effect, on, once, provide, timeout, interval, setTimeout, setInterval, throttle, debounce
ctx.get(name)                       // optional lookup, no declaration needed
ctx.<serviceName>                   // only if declared in the plugin's inject
```

with `set` denied (ctx is read-only) and any service return that is a Cordis `Context` rejected
(`denyContext`, lines 226-229). Timer verbs additionally require `inject: ['timer']` (line 347).
The proxy body (342-357):

```js
			return new Proxy({}, {
				get(_target, prop) {
					if (prop === "get") return (name) => readService(name, false);
					if (typeof prop !== "string") return void 0;
					if (CTX_VERBS.has(prop)) return (...args) => {
						if (TIMER_VERBS.has(prop) && !declared.has("timer")) return denyRead("timer");
						const method = ctx[prop];
						return Reflect.apply(method, ctx, args);
					};
					return readService(prop, true);
				},
				set(_target, prop) {
					return rejectGuard(env, `dynamic ctx is read-only; cannot assign "${String(prop)}"`);
				},
```

Two seats carry extra machinery: `slots` (auto-allocated shadowing `priority` + registration
ledger, lines 250-290) and `theme` (the `overrideTokens` source is **forced** to the package id,
lines 300-319). Note `ctx.inject` is **not** in `CTX_VERBS` — a dynamic plugin cannot do
service-scoped injection; it must declare everything up front.

The dynamic closure is `new Function("React","console","styles","host","harness", …traps,
"process","Buffer", "return (async () => {\n" + clientCode + "\n})()")` —
`dsh-cordis-client-runner\lib\client.js:154-166`. Inside it, `styles.insert(css: string): () => void`
inserts a package-owned stylesheet removed on unload (lines 71-90, 6167-6169), and
`host.call(method, args = null)` reaches the package's own host half (line 173-181).

### 1.5 Client services reachable from a client plugin

The authoritative catalog is `SERVICE_API` in
`dsh-cordis-client-runner\lib\client.js:1125-1666`. It is **complete and short**:

| Service key | Summary | Defined at |
|---|---|---|
| `layout` | Panel navigation and geometry through `ctx.layout` | 1127 |
| `locale` | Dictionary registry + locale preference | 1170 |
| `sessions` | Sessions-service face (`ctx.sessions`) | 1266 |
| `slots` | Cordis Service layer of the slot system | 1362 |
| `theme` | Theme registry and preference owner | 1399 |
| `timer` | Disposable timer helpers | 1449 |
| `uiWorkspace` | Workspace archive/directory operations | 1486 |
| `workspaces` | Workspace Controller's Client face | 1592 |

Plus the Remote namespaces reached as `ctx.remote.<ns>` (see §5). The catalog is exposed live by
the `client/Service` Inspect provider (`listService`), but reading it requires a connected page.

`EVENT_API` (`lib\client.js:1668-1710`) is equally short — only four client events exist:
`connection/reset` (1670), `locale/change` (1678), `slots/changed` (1689), `theme/change` (1700).

---

## 2. `dsh-client-ui-slots` — the slot contribution API

### 2.1 Import specifiers

| Specifier | Exports | Defined at |
|---|---|---|
| `@deepseek-ai/dsh-client-ui-slots` | `SlotCore`, `SlotOwnershipError`, `StaleAuthorizationError`, `resolveSlotLabel`, `standardHookPropName` | `lib\index.js:576` |
| `@deepseek-ai/dsh-client-ui-renderer` | provides the runtime service `ctx.slots` (`class SlotRegistry extends cordis.Service`) | `lib\client.js:1280` |

`dsh-client-ui-slots` is a **React-free pure registry core** (`README.md:12, 111`). The service you
actually call in a plugin is `ctx.slots`, supplied by `@deepseek-ai/dsh-client-ui-renderer`. You
import `@deepseek-ai/dsh-client-ui-slots` only for types / `SlotCore` / the two error classes.

### 2.2 Exact signatures

`SlotRegistry` prototype methods — `dsh-client-ui-renderer\lib\client.js`:

```js
SlotRegistry.prototype.register        = function register(rawOptions, component)        // :1788
SlotRegistry.prototype.registerFactory = function registerFactory(rawOptions, component) // :1792
inject(key, callback)                                                                     // :1343
_register(options, component)          // :1578   (internal, wrapped in ctx.effect)
_registerFactory(options, component)   // :1599
```

`inject` (documented in the catalog at `dsh-cordis-client-runner\lib\client.js:1384-1394`):

```
inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
```

> "Install an effect for each declaration lifetime of a slot. The callback runs synchronously when
> the declaration already exists; otherwise it runs inside the declaring `register()` call after the
> declaration is committed. Collapse disposes the effect and a later declaration runs it again.
> Callback effects are synchronous disposers; iterable effects install transactionally and dispose
> in reverse order."

`register` / `registerFactory` full typed declaration — `SlotCore` in
`dsh-cordis-client-runner\lib\client.js:2159`, and:

```ts
export interface RegisterFactory {
    <F extends keyof SlotFactoryMap & string>(options: RegisterFactoryOptions<F>, component: SlotComponent<FactoryComponentPropsOf<F>>): () => void;
}
```
(`lib\client.js:2030-2031`)

### 2.3 Shape of a registration

`name` is the slot key. The remaining option fields, from `StoredEntry.options`
(`dsh-cordis-client-runner\lib\client.js:2210-2212`):

```ts
export interface StoredEntry {
    component: unknown;
    options: {
        key?: string;
        id?: string;
        order?: number;
        label?: SlotLabel;          // string | (() => string)
        priority?: number;
    };
    select?: ((owner: never) => unknown) | undefined;   // chain slots
    inject?: ((...args: never[]) => Record<string, unknown>) | undefined;
    children?: Readonly<Record<string, SlotSpec<SlotEntryDef>>> | undefined;
    store?: StoreDecl | undefined;
    locale?: string | undefined;
    registrant?: string | undefined;
}
```

Which of `key` / `id` / `select` is **required** depends on the slot's `kind`:

```ts
export type SlotKind  = 'single' | 'list' | 'keyed' | 'chain';   // :2178-2179
export type SlotScope = 'root' | 'session-maybe' | 'session';    // :2190-2191
export type SlotLabel = string | (() => string);                 // :2182-2183
```

| kind | required option | semantics |
|---|---|---|
| `single` | — | one occupant; a second entry **shadows** (dynamic packages get a lower priority, i.e. they win) |
| `list` | `id` | additive, ordered by `order` (default 0); reusing a shipped `id` replaces that cell |
| `keyed` | `key` | dispatched by the owner with that exact key; reusing an occupied key replaces it |
| `chain` | `select` | entries tried in ascending `priority`; first non-null wins and arrives as `matched` |

### 2.4 How a component is rendered — **a function returning React nodes**

```ts
export type SlotComponent<P> = (props: P) => ReactNode;   // :2154-2156
```

Not a DOM node, not an HTML string, not a JSX *element* — a React function component. The dynamic
runner's own examples build elements with `React.createElement` because the closure has no JSX
(`dsh-cordis-client-runner\lib\client.js:2396`):

```js
example: "return {\n  inject: ['slots'],\n  apply(ctx) {\n    ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register(\n      { name: 'conversation.approval.detail' },\n      () => React.createElement('div', null, 'hello'),\n    ))\n  },\n}",
```

The dynamic guard additionally requires that options be an object with a string `name`
(`dsh-cordis-client-runner\lib\client.js:257-261`):

```js
				return (rawOptions, component) => {
					if (typeof rawOptions !== "object" || rawOptions === null) return rejectGuard(env, "slots.register(options, component) needs an options object with a `name`");
					const options = { ...rawOptions };
					const slot = options.name;
					if (typeof slot !== "string" || slot.length === 0) return rejectGuard(env, `slots.${prop} options need a string \`name\``);
```

### 2.5 Props passed to an occupant — the five framework shares

`ComposedProps` — `dsh-cordis-client-runner\lib\client.js:1766-1768`:

```ts
export type ComposedProps<K, EntryKey, S, H, I, M = never, N = undefined> =
    PropsRuntime<K, EntryKey> & PropsRenderSlots<S> & PropsRenderFactories
  & PropsStore<H> & InjectFace<I> & MatchedShare<SlotMap[K], M> & PropsLocale<N>;
```

- **owner share** — the slot's own owner props (`OwnerOf<K>`), e.g. `{ width, viewportWidth, canShow }` for `rightbar`, `{ absolutePath }` for `sidebar.right.tab.document.actions`, `{ close }` for `settings.section`. `settings.general.item` passes **nothing** (`SettingsGeneralItemOwnerProps { children?: never }`).
- **standard kit** — per scope (`dsh-cordis-client-runner\lib\client.js:2427-2442` for a session slot): `useResource`, `useWorkspaces`, `usePanelInfo`, `useSessions`, `useSessionStatus`, `useSessionRetainInfo`, `useChat`, `useConversation`, `useInput`, `inputActions`, `useSession`, `sessionId`, `useProjection`, `useTrajectory`.
- **child-render share** — `renderSlot` (statically narrowed to declared children) and, for a slot that declares chain children, `renderSlotChain(key, owner, opts?)` plus `SessionProvider` (`PropsRenderSlots`, `:2010-2011`).
- **factory share** — `renderFactorySlot` (`:2006-2007`).
- **store share** — `useStore: SnapshotSelectorHook<T>` and `actions: BakedActions<T, A>` when the registration declared a `store` seat (`PropsStore`, `:2022-2024`).
- **inject share** — whatever the registration's `inject` callback returned (`InjectFace`, `:1858-1859`).
- **locale share** — `t` when the registration declared `locale` (`PropsLocale`, `:2002-2003`).
- plus `matched` for `chain` slots (`MatchedShare`, `:1938-1939`) and any `hooks`/`keyedHooks` declared by the slot's `slotInject`.

Owner fields for a specific slot are published in the slot catalog under `ownerProps`
(e.g. `sidebar.right.tab.document` at `:5222`). Inspect them live with
`cordis_inspect_query(client, Slots, listSubTree, {root})`.

### 2.6 Real tiny occupant registration (shipped)

`dsh-client-ui-sidebar-files\lib\client.js:1001-1017` — a minimal, complete, real registration with
a store seat, an inject face, a declared child slot, and a chip title:

```js
			const store = createFilesStore();
			const inject = filesFace(createList(ctx.remote), createWatch(ctx.remote));
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: FILES_ID,
				locale: NS,
				store,
				inject,
				children: { "sidebar.right.tab.files.actions": {
					kind: "list",
					scope: "session"
				} }
			}, FilesBody)), "ui-sidebar-files: files tab body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: FILES_ID
			}, FilesTitle)), "ui-sidebar-files: files tab title");
```

The simplest possible shipped form, `dsh-client-ui-open-in-app\lib\client.js:853`:

```js
			ctx.slots.inject("sidebar.right.tab.files.actions", () => ctx.slots.register({
```

### 2.7 Declaring a slot you own

Declaring a slot is claiming it; the registering entry is the only entry allowed to render that key
(`dsh-client-ui-slots\README.md:46`). Children are declared inside the parent's `register` options
(`children: { key: { kind, scope } }`), as above and in
`dsh-client-ui-sidebar-documentpreview\lib\client.js:6822-6851`.

---

## 3. `dsh-client-ui-sidebar-right` — the right panel / tab system

### 3.1 Two services, both provided by this package

`dsh-client-ui-sidebar-right\lib\client.js:9073-9074`:

```js
			const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs);
			const disposeService  = ctx.reflect.provide("sidebarRight", controller);
```

| Service | Class | Import for types |
|---|---|---|
| `ctx.sidebarRightTabs` | `SidebarRightTabRegistry` (`lib\client.js:8665`) | `@deepseek-ai/dsh-client-ui-sidebar-right` (`main: lib/index.js`, 225 bytes) |
| `ctx.sidebarRight` | the navigation controller (`lib\client.js:6363`) | same |
| `ctx.layout` | panel geometry reporter — **different package** (`dsh-client-ui-layout`) | `@deepseek-ai/dsh-client-ui-layout` |

### 3.2 Adding a tab — `ctx.sidebarRightTabs.register(definition)`

`lib\client.js:8686-8721`:

```js
			/**
			* Register one tab type for the caller's lifetime.
			*
			* The caller holds the returned disposer inside its own `ctx.effect`, so a
			* type's registration lives exactly as long as the plugin that contributed it.
			* An `extension` may register a kind a `builtin` already holds and takes it
			* over until it unregisters; a second registration in the same band, or any
			* registration meeting a `fallback` of the same kind, is a wiring mistake, and
			* so is an `id` already in use.
			* @param definition - the contributed type.
			* @returns idempotent disposer.
			* @throws when the id is taken, or the kind is already registered in a way this one cannot coexist with.
			*/
			register(definition) {
				const { id, kind } = definition;
				const entries = definition.guide ?? [];
				if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error(`sidebarRight: duplicate guide entry id in "${id}"`);
				const band = definition.priority ?? DEFAULT_BAND;
				if (this.ids.has(id)) throw new Error(`sidebarRight: tab type id "${id}" is already registered`);
				const held = this.kinds.get(kind);
				if (held !== void 0 && !coexists(held, band)) throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`);
```

Definition shape (`README.md:83`, verbatim):

```
ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide?, keepMounted? })
```

- `id` — unique across every registration; the shipped guide is `@deepseek-ai/dsh-client-ui-sidebar-right/guide`. The `id` is **also the key the type's body and title register under** in `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`.
- `kind` — a string you choose; "a kind is not unique once an extension may take a builtin's over". Page types (a guide, a file tree) name **no** `patterns` and are opened *by kind*.
- `patterns` — globs over `dsh-resource://` addresses. One containing `:` matches the whole address (`dsh-resource://file/**`); one without matches the URI's path at any depth, case-insensitively (`*.md`).
- `priority` — band: `'extension'` (highest, and the default when none is named), `'builtin'`, `'fallback'`.
- `canOpen(address)` — veto a match.
- `title(address)` — tab chip text, captured at open time.
- `guide` — entry boxes for the guide page.
- `keepMounted`, `multiple` — retain visited bodies across tab/Session switches; allow independent instances (e.g. terminals).

Other registry methods: `candidates(address)` (`:8782`) returns the ranking; `claim(address, kind?)`
(`:8812`) returns the decision.

### 3.3 Opening the panel — `ctx.sidebarRight`

`lib\client.js:6385-6397`:

```js
			openResource(address, options = {}) {
				const { sessionId, actions } = this.require();
				this.placeResource(sessionId, actions, address, options);
			}
			/**
			* Open a page type by kind at the address this package records pages under.
			* @param kind - the page type's kind.
			* @param options - placement and that kind's navigation parameters.
			*/
			openTab(kind, options = {}) {
				const { sessionId, actions } = this.require();
				this.placeTab(sessionId, actions, kind, options);
			}
```

Full public face (`README.md:97-99`): `openResource(address, options?)`, `openTab(kind, options?)`,
`close(tabId)`, `active()`, `isExpanded()`, `toggleExpanded()`, `toggleFullscreen(target)`,
`focus(tabId)`, `split(paneId?)`, `float(tabId, rect?)`, `dock(paneId)`, `tabsIn(sessionId)`,
`openTabs`, `mounted`, `focusedTarget(element?)`, `commandTarget(element?)`,
`isTargetCurrent(target)`. `_undo()` / `_redo()` are `@internal`. `openResourceIn` / `openTabIn` /
`closeIn` are the Tab-domain path, "not part of `ISidebarRight`" (`:6398-6438`).

`openResource` **throws** on an address outside `dsh-resource://`, or one no type claims
(`:6445`); `openTab` throws on an unregistered kind (`:6451`). Both expand the panel:
"the panel expands, because content the user cannot see is not opened" (`README.md:93`).

### 3.4 ⚠ `ctx.layout.openRightbar` does **not** open the panel

This is the single most likely API mistake. From the live `layout` service catalog
(`dsh-cordis-client-runner\lib\client.js:1152-1166`):

```
openRightbar(track: boolean, fullscreen: boolean): void
  "Report the right panel's presentation without changing its expanded state."
  track      – whether the normal panel width reserves a grid track, including beneath a fullscreen overlay
  fullscreen – whether the panel covers the frame and hides its outer resize handle
closeRightbar(): void
  "Report the right panel as hidden: no track, no handle."
```

Other `ctx.layout` methods: `selectPanel(panelId: MainPanelId | null): void` (1132),
`beginNavigation(): AbortSignal` (1141), `toggleSidebar(): void` (1147).
`openRightbar`/`closeRightbar` are the **occupant's** (ui-sidebar-right's) report to the frame; a
third-party plugin opens the panel with `ctx.sidebarRight.openResource/openTab`.

### 3.5 The pane/tab seats and what an occupant receives

Slot contract, `dsh-cordis-client-runner\lib\client.js:5113-5160`:

```
slot:    sidebar.right.pane.tab          kind: keyed   scope: session
owner:   (none)
hooks:   TabHookContext -> useTabInfo()      (slotInject: SidebarRightTabInjected)
declaredBy: an entry in 'rightbar.session' (client-ui-sidebar-right)
occupants: deliverables ReviewTab, plan PlanPreview, schedule ScheduleTaskTab,
           sidebar-browser BrowserBody, sidebar-documentpreview TextPreview,
           sidebar-files FilesBody, sidebar-right GuideBody,
           sidebar-terminal LazyTerminalBody, subagent SidebarChatTab
```

and `sidebar.right.pane.tab.title` (`:5163-5208`) — same key and same info hook, rendered as the
chip (and a floating panel's header).

`useTabInfo()` — `dsh-client-ui-sidebar-right\lib\client.js:8964-9001`:

```js
		const tabInfoFactory = (standard, context) => {
			const { sessionId } = standard;
			const { tabId, title, fullscreen, active, signal, actions, useStore, useTabNavigation, shortcuts } = context;
			return function useTabInfo() {
				const layout = useStore((state) => state.bySession[sessionId]?.layout);
				const navigation = useTabNavigation(tabId);
				return (0, react.useMemo)(() => {
					const tab = layout?.tabs[tabId];
					if (layout === void 0 || tab === void 0 || navigation === void 0) throw new Error(`sidebarRight: tab "${tabId}" is not committed in session "${sessionId}"`);
					const pane = (0, _deepseek_ai_dsh_client_ui_dockkit.findTabPane)(layout, tabId);
					return {
						sidebar: {
							expanded: layout.expanded,
							fullscreen
						},
						panel: { id: pane.id },
						tab: {
							...tab,
							visible: active && (pane.host === "float" || layout.expanded && (title || pane.activeTabId === tabId)),
							navigation,
							signal,
							actions,
							refreshShortcut: shortcuts.find((row) => row.id === "page.refresh")
						}
					};
				}, [ … ]);
			};
		};
```

So the body receives `{ sidebar: { expanded, fullscreen }, panel: { id }, tab: { …record, visible, navigation, signal, actions, refreshShortcut } }`.

`tab.actions` — `lib\client.js:6151-6177`:

```js
					tabActions: {
						bindCommands: (commands) => { … },              // { refresh } for the page-refresh command
						openResource: (address, options = {}) => { … }, // targets THIS tab's session/pane
						openTab: (kind, options = {}) => { … },
						close: () => { … }
					}
```

`tab.navigation` is `{ address, params, revision }`; `params` reach the body as
`navigation.params` with `revision` stepped (`README.md:93`). The text preview declares
`{ line?: number }` into `SidebarRightResourceParamsMap`.

### 3.6 A real, complete right-panel tab type (shipped)

`dsh-client-ui-sidebar-documentpreview\lib\client.js:1079-1088` — the type:

```js
		function textDefinition() {
			return {
				id: TEXTPREVIEW_ID,
				kind: TEXTPREVIEW_KIND,
				patterns: ["dsh-resource://file/**"],
				priority: "fallback",
				canOpen: (address) => parseFileAddress(address)?.scope === "session",
				title: basenameOf
			};
		}
```

registered at `:6811` — `ctx.effect(() => ctx.sidebarRightTabs.register(textDefinition()), "ui-sidebar-documentpreview: text type")`.

`dsh-client-ui-plan\lib\client.js:691-699` — a *page* type (no patterns) with a guide entry:

```js
			ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
```
```js
			ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
```

### 3.7 The `rightbar` / `rightbar.session` slots — do not register here

`rightbar` (single, root) and `rightbar.session` (single, session) are declared by `client-ui-layout`
and **occupied** by `client-ui-sidebar-right`'s `RightbarRoot` / `RightbarSeat`
(`dsh-cordis-client-runner\lib\client.js:4238-4298`). Owner props: `RightbarOwnerProps { width,
viewportWidth, canShow }`. Because they are `single` slots, registering into them **shadows the
shipped right panel entirely**. Add a tab type plus a body instead.

### 3.8 Every `sidebar.right.*` and `rightbar*` slot key

From `CLIENT_SLOT_API` (`dsh-cordis-client-runner\lib\client.js`), with defining line:

| Key | kind | scope | line |
|---|---|---|---|
| `rightbar` | single | root | 4238 |
| `rightbar.session` | single | session | 4265 |
| `sidebar.right.pane.tab` | keyed | session | 5113 |
| `sidebar.right.pane.tab.title` | keyed | session | 5163 |
| `sidebar.right.tab.document` | keyed | session | 5211 |
| `sidebar.right.tab.document.action` | keyed | session | 5260 |
| `sidebar.right.tab.document.actions` | list | session | 5300 |
| `sidebar.right.tab.document.office.pdf` | keyed | session | 5354 |
| `sidebar.right.tab.document.unpreviewable` | list | session | 5394 |
| `sidebar.right.tab.files.actions` | list | session | 5448 |
| `sidebar.right.tab.guide` | chain | session | 5502 |
| `sidebar.right.tab.guide.entry` | keyed | session | 5542 |
| `sidebar.right.tab.menu.item` | list | session | 5582 |

---

## 4. `dsh-client-ui-sidebar-documentpreview` and `dsh-client-ui-sidebar-files`

### 4.1 What a "document" is — a **resource address**, not an object

A file is named by a `dsh-resource://file/…` URI. `dsh-api-workspace-files\README.md:79`:

> "A `session/<sessionId>/<path>` address carries the authorizing Session and a relative or absolute
> path; leading slashes are preserved, as in `dsh-resource://file/session/s//etc/hosts`. … `absolute/<path>`
> remains parseable but has no authorizing Session and fails with `workspace-file/unknown-workspace`."

Build and parse it with `@deepseek-ai/dsh-util-workspace-path` (`lib\index.js:200`):

```js
export { abbreviateHomePath, absoluteFileAddress, fileAddressFor, fileMediaUrl,
         isAbsoluteWorkspacePath, parseFileAddress, pathPartsOf, relativizeToCwd,
         resolveWorkspacePath, sessionFileAddress, workspaceTitleOf };
```

```
fileAddressFor(sessionId, cwd, path)   // :169  — the address builder
parseFileAddress(address)              // :50   — { scope: 'session'|'absolute', sessionId?, path }
```

Real open-a-file call site — `dsh-client-ui-sidebar-files\lib\client.js:650`:

```js
					tabActions.openResource(fileAddressFor(sessionId, state.root, path));
```

The file tree's root comes from `useSessions().byId[sessionId].cwd` (`README.md:38`), and the level
listing from `remote.workspaceFiles.list(sessionId, path, signal)`
(`dsh-client-ui-sidebar-files\lib\client.js:254`).

### 4.2 Text files **can** be rendered — paged, read-only

`dsh-client-ui-sidebar-documentpreview\lib\client.js:242-243`:

```js
		function createReadPage(remote) {
			return (sessionId, path, offset, signal) => remote.workspaceFiles.read(sessionId, path, { offset }, signal);
		}
```

Complete bytes for PDF/HTML/image/spreadsheet (`:6817`):

```js
			const face = textFace(createReadPage(ctx.remote), (file, signal) => ctx.remote.workspaceFiles.readBytes(file.sessionId, file.path, {}, signal), ctx.resources);
```

The tab type registers as `kind: 'text'`, `patterns: ['dsh-resource://file/**']`,
`priority: 'fallback'`, `canOpen: address => parseFileAddress(address)?.scope === 'session'`,
`title: basenameOf` (`README.md:31`, code at `:1079-1088`). The tab body is the keyed
`sidebar.right.pane.tab` seat under the same id, and it declares the document child slots
(`:6822-6851`). Renderers: Markdown, Code (line numbers, language label, copy), plain text, image,
PDF, HTML, xlsx/xls/csv/tsv, and Office→PDF.

### 4.3 Text files **cannot** be edited — explicitly

Evidence, strongest first:

1. `dsh-api-workspace-files\README.md:12` — **"The service exposes no mutation operation."**
2. `dsh-client-ui-sidebar-documentpreview\README.md:85` — *"Charts, drawings/images, pivot tables,
   conditional formatting, **editing**, recalculation, and export are unsupported."*
3. `README.md:66` — Code previews "show a tertiary-colored language label and a copy icon with a
   tooltip"; the only toolbar controls are wrap, reload, renderer choice.
4. Grep for `readOnly` / `onChange` / `contenteditable` / `Monaco` / `CodeMirror` across the
   documentpreview bundle: no editing surface. There is no `save`/`write` call anywhere in it.

**Conclusion for the target plugin:** an *editable* code view must be its own tab type and its own
body. The documentpreview package gives you the pattern to copy (type + keyed body + child slots),
but not an editor.

### 4.4 The document-preview registry (for adding your own renderer)

`ctx.documentPreviews` is provided by documentpreview (`lib\client.js:6809`,
`ctx.reflect.provide("documentPreviews", previews)`) and is the observable registry
`DocumentPreviewRegistry` (`:306`):

```
register(definition): () => void     // :333   { id, extensions, binaryExtensions?, priority, title, loading, wrap? }
getSnapshot(): Definition[]          // :314
subscribe(listener): () => void      // :320
candidates(path): Definition[]       // :352   extension band first, then longest suffix, then registration order
```

`README.md:35` states the two-stage rule verbatim:

> "Document implementations register metadata with
> `ctx.documentPreviews.register({ id, extensions, binaryExtensions?, priority, title, loading, wrap? })`
> and a body under the same `id` in the keyed, Session-scoped `sidebar.right.tab.document` child slot.
> … Bodies receive `resourceAddress`, `content`, `wrap`, `scrollportRef`, `addResource`, `setResources`,
> and the standard `useTabInfo`/`useResource` hooks."

The body's owner contract, `dsh-cordis-client-runner\lib\client.js:5222`:

```ts
export interface DocumentBodyOwner {
  readonly addResource: (address: string) => void
  readonly setResources: (addresses: readonly string[]) => void
  readonly resourceAddress: string
  readonly content: DocumentContent
  readonly wrap: boolean
  readonly scrollportRef: RefCallback<HTMLElement>
}
```

and `DocumentContent` (`:5271`):

```ts
export type DocumentContent =
  | { readonly kind: 'text'; readonly text: string; readonly pages: readonly DocumentTextPage[]; readonly eof: boolean }
  | { readonly kind: 'bytes'; readonly data: Uint8Array<ArrayBuffer> }
  | { readonly kind: 'renderer'; readonly revision: number
      readonly loaded: (version: string) => void
      readonly failed: () => void
      readonly reload: () => void }
```

`loading: 'text-pages' | 'bytes-complete' | 'renderer'` selects which of those you get (`README.md:37`).

### 4.5 `sidebar-files` — the service it uses

`ctx.remote.workspaceFiles.list(sessionId, path, signal)` for listing; opening a file goes through
the sidebar, never through a `files` service of its own:

```js
tabActions.openResource(fileAddressFor(sessionId, state.root, path))
```

Its runtime injects are `slots, locale, sidebarRightTabs, sidebarRight, remote, remote.workspaceFiles`
(`lib\client.js:934-941`). Its declared type is `kind: 'files'`, band `builtin`, no patterns, one
guide entry (`README.md:29`).

---

## 5. Reading and writing workspace files from the client half

### 5.1 READ — exists, exact surface

The client calls the `workspaceFiles` Remote namespace. Exact method set from the generated client
descriptor table `TYPERT_REMOTE` (`dsh-api-workspace-files\lib\typert.remote-client.js:122-336`):

| Method | Mode | Parameters |
|---|---|---|
| `read` | direct | `(workspaceFileScopeId ← SessionId, path, range)` + `signal` (`:201-239`) |
| `readBytes` | direct | `(sessionId, path, options)` + `signal` (`:248-292`) |
| `stat` | direct | `(sessionId, path)` + `signal` (`~:295-320`) |
| `list` | direct | `(sessionId, path)` + `signal` (`:164-198`) |
| `changes` | **stream** | `(sessionId, path)` + `signal` (`:126-161`) |

Host-side counterpart, live-confirmed via `cordis_inspect_query(host, Service, listService, {service:"workspaceFiles"})`:

```
@Remote async read(workspaceFileScope: WorkspaceFileScope, path: string, range: WorkspaceFileRange, signal: AbortSignal): Promise<WorkspaceFileText>
@Remote async readBytes(workspaceFileScope: WorkspaceFileScope, path: string, options: WorkspaceByteReadOptions, signal: AbortSignal): Promise<WorkspaceFileBytes>
@Remote async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceFileStat>
@Remote async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkspaceDirectoryListing>
@Remote({ mode: 'stream' }) changes(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): AsyncIterable<WorkspaceFileWatchFrame>
```

Return shapes (`dsh-api-workspace-files\README.md:30-36`):

```
WorkspaceFileStat    { absolutePath, version, bytes? }
WorkspaceFileText    stat + { offset, text, lines, eof }
WorkspaceFileBytes   stat + { offset, data: Uint8Array, eof }
WorkspaceDirectoryListing { path, entries, truncated }
WorkspaceFileWatchFrame   { kind: 'ready' } | { kind: 'change', change }
```

Caps: `maxBytes` 2 MiB / `maxFileBytes` 32 MiB / `maxLines` 5000 / `maxEntries` 2000 (`README.md:62-67`).
`read` pages by **lines** (`offset` is 1-based, defaults 1); `readBytes` windows by bytes
(`range.offset` 0-based). Failures are `workspace-file/*` codes: `not-found`,
`outside-workspace`, `watch-unsupported`, `too-large`, `not-text`, `not-regular-file`,
`not-directory`, `unknown-workspace`, `unsupported-address` (`README.md:73`).

Required injects from a plugin: `remote.workspaceFiles` (plus `remote`), exactly as
`dsh-client-ui-sidebar-files` declares them (`lib\client.js:939-940`). Host counterpart that must be
mounted: **`@deepseek-ai/dsh-api-workspace-files`** (needs `dsh-fs`, the Session store, and the
Typert Gateway — `README.md:28`).

### 5.2 WRITE — **no client-half file-write RPC exists**

Stated three ways:

1. `dsh-api-workspace-files\README.md:12` — *"The service exposes no mutation operation."*
2. The complete client `SERVICE_API` list is §1.5: `layout`, `locale`, `sessions`, `slots`, `theme`,
   `timer`, `uiWorkspace`, `workspaces`. There is **no** `fs`, `files`, or `workspace`-write service.
   `uiWorkspace`'s directory methods are `listDirectory`, `createDirectory`, `pickDirectory` only
   (`dsh-cordis-client-runner\lib\client.js:1560-1588`).
3. `ctx.fs`'s mutations live on the **Node** service. Every client bundle `require`s only browser
   packages; nothing reaches `ctx.fs`.

`dsh-fs`'s host contract, live-confirmed via `cordis_inspect_query(host, Service, listService, {service:"fs"})`:

```
abstract writeText(target: FsTarget, content: string, expected?: FsWriteIntent,
                   signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsWriteOutcome>
abstract editText (target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion },
                   signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy): Promise<FsEditOutcome>

FsEditRequest  = { oldString: string; newString: string; replaceAll: boolean }
FsWriteIntent  = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: FsVersion }
FsWriteOutcome = { operation: 'create' | 'update'; version; before: string | null; after: string }
FsEditOutcome  = { version; before: string; after: string }
FsError codes  = FS_NOT_FOUND, FS_STALE_VERSION, FS_AMBIGUOUS_EDIT, FS_TOO_LARGE, FS_NOT_TEXT, …
```

Implementations: `dsh-fs-local\lib\index.js:864` (`writeText`) and `:883` (`editText`);
base class `dsh-fs\lib\index.js:58`. `dsh-tool-fs\lib\index.js:668` (`applyEditTool`) is the
**agent-facing** tool over the same seam.

### 5.3 The four wire paths a client half can actually use to cause a write

**(a) Your own host half, over the Typert Remote** — the production pattern. The package's
`lib/index.js` declares a Cordis service and the generated `./typert` (host) + `./remote` (client)
artifacts publish it. Reference artifacts: `dsh-api-workspace-files\lib\typert.host.js`,
`lib\typert.remote-client.js`. The wire is registered by `@deepseek-ai/dsh-api-remotes` and
dispatched by `@deepseek-ai/dsh-api-gateway` (`lib\index.js:624`):

```js
			connectionCtx.connection.rpc.intercept("/api", (endpoint) => this.claimsEndpoint(endpoint), (endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer));
```

with the browser side calling `connection.rpc.call('/api', endpoint, { args }, signal)`
(`dsh-api-gateway\lib\types\client\index.js:278`). Your host half then runs
`const target = await ctx.fs.resolve(path, { cwd }); await ctx.fs.writeText(target, text);`
(optionally guarded with `{ kind: 'replaceIfVersion', version }` from a prior `stat`).

**(b) Your own host half, over an HTTP route.** The live `webServer` host service exposes
`register(route: WebRoute): () => void`, `registerUpgrade`, `registerFallback`,
`tapIndex(transform)`, `renderIndex(html)`. Simpler than Typert, but you own auth and encoding.

**(c) A dynamic package with both halves.** The browser half calls
`host.call(method, args)`; the host half runs in a `node:vm` realm where "Node globals are absent or
redirect to Cordis services (`ctx.fs`, `ctx.web`, `ctx.bash`, the timer helpers)"
(`dsh-cordis-host-runner\README.md:62`). Requires `@deepseek-ai/dsh-cordis-host-runner` **and**
`@deepseek-ai/dsh-cordis-client-runner`, plus a user approval or explicit gesture to run.
`host.call` definition: `dsh-cordis-client-runner\lib\client.js:173-181`. Route:
`ctx.remote.dynamicCordisRunner.invoke(pluginId, pluginRunId, method, args)`
(`dsh-cordis-client-runner\lib\client.js:6604`).

**(d) Route the write through the agent — the shipped pattern for "AI rewrite".** A client plugin
sends a prompt or a command to the Session, and the agent performs the edit with its own fs tools.
`ISession` (`dsh-cordis-client-runner\lib\client.js:1867`):

```ts
    prompt(content: PromptContentPart[], mode: 'queue' | 'steer', signal?: AbortSignal, requestId?: SessionRequestId): Promise<RemoteResult<{ accepted: true }>>;
    command(line: string): Promise<RemoteResult<{ matched: boolean }>>;
```

and the direct Remote — `dsh-client-ui-commands\lib\client.js:1069`:

```js
				const result = await this.ctx.remote.commands.execute(session.sessionId, line, attachments);
```

**(e) Terminal (last resort).** `ctx.remote.terminal.write(agent, id, attachmentId, data)` exists
(live host `terminalController` catalog), i.e. a PTY in the workspace can write files — but it needs
an Agent and a live terminal, and it is not a file API.

### 5.4 Recipe

```
READ a file (client half, read-only, no new host code):
  inject: ['remote', 'remote.workspaceFiles']
  const page = await ctx.remote.workspaceFiles.read(sessionId, path, { offset: 1 }, signal);
  // page.ok ? page.value.text : page.error.code   →  RemoteResult
  const meta = await ctx.remote.workspaceFiles.stat(sessionId, path, signal);
  const bytes = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal);
  const list  = await ctx.remote.workspaceFiles.list(sessionId, absDir, signal);
  const stream = ctx.remote.$stream({ name: 'watch', open: (signal) => ctx.remote.workspaceFiles.changes(sessionId, path, signal), ended: () => new Error('ended') });

WRITE a file:
  → NOT POSSIBLE from the client half. Add a host half with ctx.fs.writeText / ctx.fs.editText
    (path (a), (b) or (c) above), or ask the agent to do it (path (d)).
```

---

## 6. `dsh-client-ui-primitives` and `dsh-client-ui-theme`

### 6.1 Primitives

Import specifier: **`@deepseek-ai/dsh-client-ui-primitives`** (bare); `main: lib/index.js`,
`types: lib/types/index.d.ts`; "Pure React atoms … (zero cordis)". One ESM export statement at
`lib\index.js:12381` with several hundred named symbols. Every component is a React component
returning React elements.

Component catalog (`README.md:37-74`, abridged to the ones that matter for a panel UI):

| Export | What it is |
|---|---|
| `Button` | clickable action; `variant` ∈ `primary` \| `ghost` \| `outline` \| `toolbar`; ref targets the native button |
| `Switch` | two-state toggle 36×20; `label` required |
| `SegmentedControl`, `SegmentedTabs` | tablist / controlled tabs with sliding indicator; `id` seeds `<id>-<value>` and `<id>-<value>-panel` |
| `Checkbox` | labeled native checkbox, caller supplies localized `label` |
| `Input` | **single-line** text entry; ref targets the native input |
| `Menu`, `MenuItemButton`, `MenuGroup`, `observeStickyMenuGroups` | dropdowns, nested submenus, groups |
| `Pill`, `Tag`, `PathLabel`, `StateDot`, `ConnectionIndicator`, `DisclosureRow`, `TextShimmer` | badges, path rendering, status, disclosures |
| `Modal`, `RiskConfirmation`, `Tooltip`, `HoverCard`, `ImageLightbox`, `Toast` | overlays and feedback |
| `SettingsForm`, `SettingsValueField`, `SettingsSecretField`, `SettingsFormModel`, `settingsNumberField`, `settingsTextField` | a plugin's settings page frame + staged-edit model |
| `JsonTree`, `JsonBlock` | read-only JSON inspection |
| `MarkdownText`, `MarkdownDelegateProvider`, `CodeBlock` | untrusted GFM + highlighted code; `CodeBlock` takes `lineNumbers`, `contentRef`, `showHeader` |
| `TerminalBlock`, `ReadBlock`, `DiffBlock`, `SearchBlock`, `WebBlock` | agent-output cards |
| `FileTypeIcon`, `classifyFileType`, `fileExtension` | category-colored file/folder glyph |
| `languageForPath`, `CODE_HIGHLIGHT_EXTENSIONS`, `useCodeHighlighter` | the lazy line-token highlighter (`shiki`) shared by code preview and diff review |
| `icons/*`, `FishLogo`, `BrandWordmark`, `PluginArtwork*`, `GuideArtwork*` | glyphs and artwork |

**There is no code-editor primitive.** `grep -E 'Textarea|contentEditable|Monaco|CodeMirror'` over
`lib\index.js` → **no matches**. `Input` is single-line; `CodeBlock` is read-only. An editable code
pane means bundling your own editor (CodeMirror 6 / Monaco) as a package dependency, externalized
via `dsh.client.external`, or writing a `<textarea>`/`contenteditable` yourself.

### 6.2 How a plugin declares styles — CSS Modules, compiled into the bundle

There is **no** `import "./x.css"` at runtime, **no** `css` tagged-template export, and **no**
inline-style-object convention. The mechanism is a build-time virtual module per `*.module.css`,
emitted as a `const css = "…"` string plus a class-name map, injected into `document.head` *
inside the bundle factory* so it is owned and removed with the plugin.

`dsh-client-ui-theme\lib\client.js:25-41` — verbatim, comment included:

```js
		//#region \0dsh-css:D:\develop\dsh-harness-windows-x64\packages\client\ui-theme\src\client\AppearanceRow.module.css.mjs
		const css$1 = ".v01cdW_group{border-bottom:.5px solid var(--dsw-alias-border-l2);…}";
		const tagId$1 = "@deepseek-ai/dsh-client-ui-theme/AppearanceRow.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-client-ui-theme";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var AppearanceRow_module_css_default = {
			"cubeRow": "v01cdW_cubeRow",
			"group": "v01cdW_group",
			"selected": "v01cdW_selected",
			"themeCube": "v01cdW_themeCube",
			"title": "v01cdW_title"
		};
		//#endregion
```

So: **author `Foo.module.css`, `import styles from './Foo.module.css'`, use `styles.group`**, and
the build inlines it. The virtual-module id is `\0dsh-css:<abs path>.mjs` (a rollup plugin named
`dsh-css`). Scoped class names are hashed with a short prefix (`v01cdW_`, `_0Fr0Ha_`, …).
`data-plugin="<package>"` is what unload uses to remove the plugin's styles
(`dsh-client-modules` teardown / `styles.dispose()`; dynamic packages get
`styles.insert(css: string): () => void` instead — `dsh-cordis-client-runner\lib\client.js:6169`).

CSS files are shipped next to the bundle for reference: `dsh-client-ui-primitives\lib\*.module.css`
and `dsh-client-ui-primitives\package.json:48` (`"files": ["lib/index.js", "lib/**/*.css", …]`).
A build step is therefore **required** for styles (the shared preset runs tsdown with the
`dsh-css` plugin); there is no runtime CSS story for a hand-written client half.

### 6.3 Theme

The service is **`ctx.theme`** (registered by `@deepseek-ai/dsh-client-ui-theme`). Exact method set
from `SERVICE_API` (`dsh-cordis-client-runner\lib\client.js:1399-1446`):

```
getTheme(): ThemeSnapshot
setTheme(id: string): void                  // a registered theme id or 'system'; unknown ids throw
setFontSize(px: number): void               // integer px within FONT_SIZE_MIN..FONT_SIZE_MAX
register(definition: ThemeDefinition): () => void
overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void
```

Event: `theme/change` with a `ThemeSnapshot` (`:1700-1709`). There is **no** `useTheme()` hook in the
catalog — read `ctx.theme.getTheme()` and subscribe to `theme/change`, or read `theme/change`'s
snapshot. (The `--dsw-*` CSS variables are the presentation channel and are what shipped components
actually consume.)

Types (`dsh-cordis-client-runner\lib\client.js`):

```ts
export interface ThemeSnapshot {            // :2246-2248
    preference: ThemePreference; fontSize: number;
    active: ThemeDefinition; themes: readonly ThemeDefinition[]; revision: number;
}
export interface ThemeDefinition {          // :2238-2240
    id: string; colorScheme: 'light' | 'dark'; tokens: ThemeTokens;
}
export type ThemeTokens          = Record<string, string>;                      // :2258-2259
export interface ThemeTokenModes { light: string; dark: string }               // :2250-2251
export type ThemeTokenOverrides  = Record<string, ThemeTokenModes>;             // :2254-2255
```

`overrideTokens` semantics (`:1435-1444`): stacks a partial layer over the active theme; layers
compose in seq order with later layers winning per token; calling again with the same `source`
replaces that source's whole layer. **For dynamic packages the façade forces `source` to the
package id** (`:311-317`), and a bare string token value throws a teaching error — every value must
be `{ light, dark }`.

`ThemeTokenOverrides` example the runner's guard prints (`:312`):
`overrideTokens('mine', { '--dsw-alias-…': { light: '…', dark: '…' } })`.

### 6.4 Theme tokens — `--dsw-*` CSS custom properties

Tokens are plain CSS custom properties, declared in CSS strings compiled into
`dsh-client-ui-theme\lib\client.js`. Grouping and the declaring line:

| Group | Examples | line |
|---|---|---|
| font / motion / radius | `--dsw-font-family`, `--dsw-font-family-brand`, `--ds-font-family-code`, `--ds-ease-in-out`, `--ds-transition-duration{,-fast,-slow}`, `--dsw-radius-{xs,sm,md,lg,xl,panel}` | 1142 (`base_css_default`) |
| static palette | `--dsw-static-{amber,blue,deepseek,green,neutral,neutral-bluish,red,…}-{50…1000}` | 1148 (`design_platform_css_default`) |
| corner shape, focus | `--dsw-corner-shape`, `--dsw-focus-ring-width`, `--dsw-focus-ring-color` | 1145, 1151 |
| scrollbar | `--dsh-scrollbar-thumb`, `-hover`, `-border`, `-track-margin`, `-width` | 1157 |
| elevation / shadow / gradients | `--dsw-shadow-lv1..lv3`, `--dsw-elevation-stroke`, `--dsw-elevation-{panel,prominent,soft}`, `--dsw-mask-blur`, `--dsw-menu-backdrop-filter`, `--dsw-linear-gradient-think` | 1160 |
| content font scale | `--dsh-content-font-size`, `--dsh-content-font-delta`, `--dsw-font-markdown-h1..h6` (+ weight/family/line-height sub-vars) | 1160 |
| code highlight (shiki) | `--shiki-foreground`, `--shiki-background`, `--shiki-token-{constant,string,comment,keyword,parameter,function,punctuation,link}` | 1163 |
| settings surface | `--dsw-alias-settings-card-fill`, `--dsw-alias-settings-card-stroke` | 1142 |

A **named alias subset** is enumerated as data in the package at `lib\client.js:1236-1331`, each
entry `{ name, cssVariable }`: `--dsw-alias-bg-base`, `-bg-layer-1`, `-bg-layer-2`, `-bg-overlay`,
`-border-l1`, `-border-l2`, `-brand-primary`, `-label-primary`, `-label-secondary`,
`-state-error-primary`, `-state-idle-primary`, `-state-success-primary`, `-state-warn-primary`,
`--dsw-specific-sidebar-fill`. Many more aliases are used by shipped CSS but are not in that
enumerated list — e.g. `--dsw-alias-border-l3`/`l4`, `--dsw-alias-interactive-bg-hover`,
`--dsw-alias-bg-module-platform`, `--dsw-alias-label-tertiary`/`-caption`,
`--dsw-alias-markdown-code-block`, `--dsw-alias-switch-thumb`,
`--dsw-static-neutral-bluish-400`, `--dsw-radius-xl` (see `theme\lib\client.js:26` and `:1013`).

**Dark mode** is selected by the attribute `body[data-ds-dark-theme]` (e.g. `:1154`, `:1160`, `:1163`).
The live `client/Theme` Inspect provider (`listTokens`, "Current theme token names and light/dark
override requirements") is the correct authoritative source — it timed out here for lack of a
connected page.

---

## 7. `dsh-client-ui-settings` and the `settings.*` slots

### 7.1 The settings slots

From `CLIENT_SLOT_API` (`dsh-cordis-client-runner\lib\client.js`):

| Key | kind | scope | Owner props | line |
|---|---|---|---|---|
| `settings.general.item` | list | root | `SettingsGeneralItemOwnerProps { children?: never }` — **nothing** | 4400 |
| `settings.section` | list | root | `SettingsSectionOwnerProps { close: () => void }` | 4710 |
| `settings.trigger` | single | root | — | 4762 |
| `settings.header` | — | root | — | 4459 |
| `settings.action` | — | root | — | 4327 |
| `settings.close` | — | root | — | 4373 |
| `settings.launcher` | — | root | — | 4486 |
| `settings.onboarding` | — | root | — | 4618 |
| `settings.models.footer` / `.provider-card` / `.sign-in` | — | — | — | 4513 / 4559 / 4591 |
| `settings.plugins.tab` | — | — | — | 4664 |

`settings.general.item` verbatim doc (`:4403-4404`) — this is the one you want for a simple
preference:

> "One preference row inside the General section — the additive seat for a single setting that needs
> no page of its own (a whole page is `settings.section`) … Options: `id` (row key), `order` (row
> position). The section column only stacks rows, so a row draws its own internals, including its
> label: nothing projects a `label` here and **the owner passes no props at all — copy, current
> value, and the write path are all yours, through your own inject face and `host.call`.** Declared
> at runtime by ui-settings-general's General entry … every registrant already depends on it for
> `ctx.configForms`."

### 7.2 The exact registration call

Both settings slots are **ordinary slots** (`kind: list`), so registration is §2.2:

```js
// settings.general.item — a preference ROW inside General (no owner props)
ctx.slots.inject('settings.general.item', () => ctx.slots.register(
  { name: 'settings.general.item', id: 'my-entry', order: 100, label: 'My entry' },
  MyPreferenceRow,
));
```

Real shipped registrations: `dsh-client-ui-theme\lib\client.js:1603` and `:1618` (Appearance and
Font size), `dsh-client-ui-settings-general\lib\client.js:957`, `:967`, `:1171`,
`dsh-client-ui-shortcuts\lib\client.js:1084`, `dsh-client-ui-permission-presets\lib\client.js:808`,
`dsh-client-locale\lib\client.js:1553`, `dsh-client-ui-settings-web-search\lib\client.js:307`
(this last one wrapped in `ctx.configForms.whileServed([...], () => ctx.slots.inject(…))`).

For a whole page:

```js
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'my-section', order: 100, label: () => t('settings.mySection') },
  MySection,   // receives { close }
));
```

The slot catalog entry (`dsh-cordis-client-runner\lib\client.js:4714`) notes the label is
**registrant-localized**: "the registrant re-registers with
fresh text on locale change, so the shell never subscribes locale state". Owners:
`dsh-client-ui-settings-plugins\lib\client.js:201`, `dsh-client-ui-settings-models\lib\client.js:4059`,
`dsh-client-ui-agent-preset\lib\client.js:1685`, `dsh-client-ui-settings-account\lib\client.js:4501`,
`dsh-client-ui-settings-general\lib\client.js:1171`.

### 7.3 Reading and writing the plugin's own config at runtime — two distinct mechanisms

**(a) Live, persisted, schema-validated: `ctx.configForms`** (preferred).

Provided by `@deepseek-ai/dsh-client-ui-settings`
(`dsh-client-ui-settings\lib\client.js:1283-1284`, `super(ctx, "configForms")`). API, with defining
lines:

```
describe(): DescribeMirror                                  // :1302
get(entryId: string): ConfigFormController                   // :1309   (shared, memoized per entry id)
whileServed(namespaces: string[], register: (served: Set<string>) => () => void): () => void  // :1330
developerTools: DeveloperToolsPreference                     // :1289
```

`ConfigFormController` (`:1111`):

```
getSnapshot()                                   // :1134
subscribe(listener: () => void): () => void      // :1142
set(field, value): Promise<boolean>              // :1152
unset(field): Promise<boolean>                   // :1165
mutate(ops, expectedRevision): Promise<boolean>  // :1177
enqueue(operation)                               // :1212
dispose()                                        // :1291
```

`DescribeMirror` (`:1380`): `getSnapshot()` (`:1390`), `subscribe` (`:1398`), `load()` (`:1406`),
`ensure()` (`:1422`), `acceptView(view)` (`:1435`), `namespace(ns)` (`:1454`).

`README.md:34` on the snapshot and the write verbs, verbatim:

> "Feature adapters use `ctx.configForms.get(entryId)` to obtain accepted values and a write queue
> shared by every editor of that Host entry. Snapshots contain resolved `value`, inherited `base`,
> raw `user`, revision, writability, and persistence mode. `set` and `unset` submit one operation;
> `mutate` submits one atomic operation list. Staged editors pass the revision read before editing;
> conflicts preserve their drafts. Unsetting removes the override and restores inheritance."

The underlying transport is the `ctx.remote.settings` namespace — `describe()`, `mutate(ns, ops,
expectedRevision)`, `update(ns, patch, revision)`, `openSettingsDocument()` (real call sites:
`dsh-client-ui-settings\lib\client.js:1182`, `:1469`; `dsh-client-ui-agent-preset\lib\client.js:1072`;
`dsh-client-ui-settings-general\lib\client.js:822`), plus `ctx.settingsSchema` for
`rehydrate`/`validate`. Host counterpart: `@deepseek-ai/dsh-api-settings-controller`. Limitation:
non-loopback pages get no durable settings and a form starts `unavailable` (`README.md:106`).

**(b) Serve-time config global: `globalThis.__DSH_<NAME>_CONFIG__`.** The package's **host half**
validates its `Config` schema and pushes the value into the served page. Complete real example —
`dsh-client-shortcuts\lib\index.js:1-23`:

```js
import z from "@deepseek-ai/schemastery";
/** Validated deployment settings for fixed keyboard sequences. */
const Config = z.object({ stopSequenceMs: z.natural().min(1).max(2147483646).default(500) });
/**
* Embed validated keyboard settings in product pages.
* @param ctx - Host context serving browser pages.
* @param config - sequence timing adopted when the page loads.
*/
function apply(ctx, config) {
	ctx.on("webserver/index-inject", (table) => {
		table.push({
			kind: "global",
			name: "__DSH_SHORTCUTS_CONFIG__",
			value: config
		});
	});
}
export { Config, apply };
```

and the matching browser read — `dsh-client-shortcuts\lib\client.js:1865`:

```js
				const config = Config(globalThis.__DSH_SHORTCUTS_CONFIG__ ?? {});
```

Identical pattern in `dsh-client-ui-sidebar-documentpreview\lib\index.js:25-33` (`office`/`excel`
limits) and `\lib\client.js:6807` (`__DSH_DOCUMENT_PREVIEW_CONFIG__`). Sibling globals injected by
other packages: `__DSH_LOCALE__` (`dsh-client-locale\lib\client.js:1504`),
`__DSH_HOST_PATHS__` (`dsh-client-ui-conversation\lib\client.js:17924`),
`__DSH_FILE_UPLOAD__` (`dsh-client-file-upload\lib\client.js:159`),
`__DSH_DIRECTORY_PICKER__` (`dsh-client-ui-directory-picker-native\lib\client.js:63`),
`__DSH_TRANSPORT__` (`dsh-client-ui-settings-account\lib\client.js:4409`).

**This is not live:** the value is embedded in the page at serve time.
`dsh-client-ui-sidebar-documentpreview\README.md:96` — *"Settings are embedded in each served page;
reload the browser page after changing YAML."*

**There is no `ctx.config` on the client half.** Only one shipped client bundle exports `Config`
(`dsh-client-ui-conversation\lib\client.js:18460`), and neither it nor the global-injection packages
read a live `ctx.config`. For a real, persisted, user-editable preference use `ctx.configForms.get(...)`;
for a deployment/debug-time constant use the host-injected global.

---

## 8. `dsh-client-hmr` and `dsh-client-store`

### 8.1 `dsh-client-hmr` — automatic, no plugin-side API

The entire browser half is 90 lines — `dsh-client-hmr\lib\client.js`:

```js
		const EVENTS_ROUTE = "/plugins/events".slice(1);            // :45  → "plugins/events" (document-relative)
		const name = "client-hmr";                                   // :49
		const inject = ["modules"];                                  // :51
		function apply(ctx) {                                        // :56
			const entries = ctx.modules.entries;
			const handle = (frame) => {
				(frame.type === "graph"
					? Promise.resolve().then(() => entries.sync(frame.graph))
					: entries.reload(frame.id, frame.rev)).catch((error) => { ctx.logger.error(error); });
			};
			ctx.effect(() => {
				const source = new EventSource(EVENTS_ROUTE);
				source.addEventListener("message", (event) => { … JSON.parse(event.data) … });
				return () => { source.close(); };
			}, "client-hmr: event source");
		}
```

with the frame validator (`:19-40`) accepting exactly two frame types:

```js
				case "rebuilt": return … { type: "rebuilt", id: record.id, rev: record.rev }
				case "graph":   return … { type: "graph",   graph: record.graph }
```

Answering the questions directly:

- **Transport:** `EventSource` (SSE) on the document-relative route `/plugins/events`.
- **Participating hooks:** **none.** There is no `import.meta.hot`, no accept API, no
  `hmr/reload` client event (the full client `EVENT_API` is §1.5: only `connection/reset`,
  `locale/change`, `slots/changed`, `theme/change`). Reload is driven entirely by the module system:
  `invalidate(id, rev)` drops the memoized record, the factory and its `client.*` chunks
  (`dsh-client-modules\lib\client.js:824-838`), the loader re-imports, the fiber is torn down
  (cascading `ctx.effect` disposers and slot entries) and plugin-owned `<style>` tags are removed.
- **What a plugin must declare:** nothing. It is installed automatically for any package with a
  `dsh.client.platform` declaration; the host half of the pair computes revisions from `mtimeMs`,
  `ctimeMs` and size (`dsh-client-modules\README.md:131`).
- **Documented limits** (`dsh-client-modules\README.md:133`): the page retains its modules bootstrap
  and static platform identities, so the bootstrap cannot be replaced without a page reload;
  metadata-only changes can reload a plugin; changes invisible in mtime/ctime/size cannot be
  distinguished. Definitions held by the *dynamic* runner are not restored on refresh at all
  (`dsh-cordis-client-runner\README.md:40`).
- **Is HMR automatic here?** The code path above is unconditional once the package is loaded. But it
  only *reloads* when a bundle is actually rebuilt and the host emits `rebuilt`/`graph` — i.e. it
  needs a running watcher/build. This report cannot verify whether such a watcher is running in this
  workspace; the runtime note for this session says client-plugin changes reload without a refresh
  only while `pnpm run dev:web` is also running.

### 8.2 `dsh-client-store` — reactive store

Import: `@deepseek-ai/dsh-client-store`. **Real ESM** (`lib/index.js`), one export statement at
`:178`:

```js
export { createSnapshotStore, defineStore, notifySubscribers, shallowEqual };
```

Engine (bundled, not re-exported): `zustand/vanilla` + `zustand/middleware` `subscribeWithSelector`
+ `zustand/shallow` + `immer` `produce`/`freeze` — see the imports at `lib\index.js:1-4`.

```js
function createSnapshotStore(init, opts)   // :70
//   opts: { flush?: 'sync' | 'raf', persist?: { name: string } }
//   → { getSnapshot(): T,
//       subscribe(fn: () => void): () => void,
//       update(mutator: (draft: T) => void): void,
//       set(next: T): void }
```
(returned object verbatim at `:90-101`)

```js
function defineStore(decl)                 // :147
//   decl: { init: () => T, persist?: string, actions: ActionsDecl<T> }
//   → StoreHandle { spec, create(scopeKey?) }
// create(scopeKey?) → { actions, getSnapshot, subscribe, store, clearPersisted }   // :162-173
```

```ts
export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>;        // TYPE_API :1714-1715
export type BakedActions<T, A> = { [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never };  // :1726-1727
export interface StoreHandle<T, A> { readonly spec: StoreSpec<T,A>; create(scopeKey?: string): StoreInstance<T,A> }  // :2222-2223
export interface StoreInstance<T, A> { readonly actions; getSnapshot(): T; subscribe(fn): () => void; clearPersisted(): void }  // :2226-2227
export interface StoreSpec<T, A> { init: () => T; persist?: string; actions: A }            // :2230-2231
export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }  // :1942-1943
```

Engine products are **bare observables** — "subscribe/getSnapshot/update/set, NO selector hook. Hook
synthesis is ui-renderer's (the one uSES bridge, cached per source at the binding site)"
(`lib\index.js:11-13`).

**The "Store seat"** is the slot-registration bridge: `ctx.slots.register({ …, store }, Body)` makes
the occupant receive `useStore`/`actions`. From `dsh-cordis-client-runner\lib\client.js:2022-2024`:

```ts
export type PropsStore<H> = H extends StoreHandle<infer T, infer A> ? {
    useStore: SnapshotSelectorHook<T>;
    actions: BakedActions<T, A>;
} : object;
```
```ts
export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S;   // :2202-2203
```

`dsh-client-ui-slots\README.md:42`:

> "A register call may declare a store seat with `store: defineStore(...)`: `init` infers the state
> schema and `actions` is the complete draft-transform write set. Components read through the
> selector hook and write through the baked callbacks; the engine implementation of `defineStore`
> lives in the runtime package and satisfies the `DefineStore` contract exported here."

Real shipped usage — `dsh-client-ui-sidebar-files\lib\client.js:1001-1013` (§2.6 above):
`const store = createFilesStore(); … ctx.slots.register({ name, key, locale, store, inject, children }, FilesBody)`.
The `sidebar-right` package itself declares its layout store the same way —
`dsh-client-ui-sidebar-right\lib\client.js:5241` (`(0, _deepseek_ai_dsh_client_store.defineStore)({ … })`).

---

## 9. The authoritative machine-readable catalogs

Do not guess slot keys, service methods, event names, or theme tokens — the runtime ships them as
data and serves them live.

| Where | What | Location |
|---|---|---|
| Shipped code | `SERVICE_API` (8 client services with full method JSDoc) | `dsh-cordis-client-runner\lib\client.js:1125-1666` |
| Shipped code | `EVENT_API` (4 client events) | `…:1668-1710` |
| Shipped code | `TYPE_API` (~100 exported type declarations referenced by the above) | `…:1712-2273` |
| Shipped code | `CLIENT_SLOT_API` (**every** shipped slot, ~140 entries: key, kind, scope, owner props, register options, occupants, replace risk, a runnable example, and the upstream `source` file:line) | `…:2363-6118` |
| Live | `host/Service.listService`, `host/Event.listEvents`, `host/Config.listConfigs`, `host/Tool.listTools` | `cordis_inspect_query` — **verified working in this session** |
| Live | `client/Service.listService`, `client/Event.listEvents`, `client/Slots.listSubTree`, `client/Theme.listTokens`, `client/Builtin.listBuiltins` | listed by `cordis_inspect_list`; **all timed out here (no connected page)** |

---

## 10. Verdict for the target plugin (code editor in the right panel + inline AI rewrites)

**Buildable, with one hard constraint: the write must live in a host half.**

| Need | Available? | Exact API |
|---|---|---|
| Render a pane in the right panel | **Yes** | `ctx.sidebarRightTabs.register({id, kind, …})` + `ctx.slots.register({name:'sidebar.right.pane.tab', key:id, …}, Body)` |
| Open/focus it | **Yes** | `ctx.sidebarRight.openResource(address, options?)` / `openTab(kind, options?)` (`ctx.layout.openRightbar` is only a geometry report) |
| Render code with highlighting | **Yes** | `CodeBlock`, `useCodeHighlighter`, `languageForPath`, `CODE_HIGHLIGHT_EXTENSIONS` from `@deepseek-ai/dsh-client-ui-primitives` |
| An editable text surface | **No primitive** | bundle CodeMirror/Monaco yourself (declare it in `dsh.client.external`), or a `<textarea>` |
| Read the file | **Yes** | `ctx.remote.workspaceFiles.read(sessionId, path, {offset}, signal)` (and `stat`/`readBytes`/`list`/`changes`); inject `remote` + `remote.workspaceFiles` |
| Know which file is open + its path | **Yes** | `useTabInfo().tab.{contentId, navigation, actions}`; address from `fileAddressFor(sessionId, cwd, path)`; root from `useSessions().byId[sessionId].cwd` |
| **Write the rewritten file** | **No client RPC** | host half with `ctx.fs.writeText` / `ctx.fs.editText` (guarded by `{kind:'replaceIfVersion', version}`), exposed to the browser half via Typert Remote / `ctx.remote.<ns>` / an HTTP route, or via a dynamic package's `host.call` |
| Ask the model for the rewrite | **Yes** | `ctx.remote.commands.execute(sessionId, line, attachments)` (`dsh-client-ui-commands\lib\client.js:1069`), or `ISession.prompt(content, mode, signal, requestId)` / `ISession.command(line)` (`dsh-cordis-client-runner\lib\client.js:1867`) |
| Persist editor preferences | **Yes** | `ctx.configForms.get('<your-host-entry-id>')` → `getSnapshot/subscribe/set/unset/mutate`; UI row into `settings.general.item` |
| Theme-correct styling | **Yes** | CSS Modules + `--dsw-*` tokens; `body[data-ds-dark-theme]` for dark; `ctx.theme.getTheme()` / `theme/change` |
| Hot reload | **Yes, automatic** | `@deepseek-ai/dsh-client-hmr` (SSE `/plugins/events`); nothing to declare |

Suggested architecture for the write path (the only genuinely open decision):

1. **Package with both halves.** Host `lib/index.js` declares `export const Config` and
   `export function apply(ctx, config)`; it registers a Typert Remote namespace whose handler runs
   `ctx.fs.resolve(path, { cwd }) → ctx.fs.stat(target) → ctx.fs.writeText(target, text, { kind:
   'replaceIfVersion', version })`. The browser half injects `remote.<yourNamespace>` and calls it
   exactly like `ctx.remote.workspaceFiles.read(...)`. Persist the "auto-apply" preference through
   `settings.general.item` + `ctx.configForms`.
2. **Or route through the agent** — the browser half sends the rewrite request as a command/prompt,
   and the agent's own fs tools do the edit. This needs **no** host code and matches the shipped
   `dsh-tool-fs` / `dsh-tool-str-replace-editor` behaviour, at the cost of a full model turn.

Things that **do not exist** and should not be assumed:
- any client-half `writeFile` / `applyEdit` / `saveFile` service or RPC (verified by README, by the
  complete `SERVICE_API`, and by `grep writeFile|applyEdit` over every `lib/client.js`);
- an editable code/document renderer in `ui-sidebar-documentpreview`;
- a code-editor (or even multiline text <textarea>) primitive in `ui-primitives`;
- `ctx.config` on the client half;
- any slot-level hook into HMR beyond automatic bundle replacement;
- a `label` projection for `settings.general.item` (owners pass no props — you draw your own row).
