/**
 * The one DSH UI library the client half renders with.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is a **baseline** module: the web
 * shell seeds a frozen module table (`PLATFORM_MODULES` — React, Cordis and the
 * static UI libraries) and every dynamic bundle resolves its externals against
 * exactly that table. It is not an npm dependency of this package and is not
 * listed under `dsh.client.external`, which is only for *non*-baseline shared
 * requests. The bundle reaches it through the loader's `require`, which is why
 * `build.mjs` marks the specifier external and this file exists at all.
 *
 * The declarations below are written by hand. The package's `package.json`
 * declares `"types": "lib/types/index.d.ts"` and does not ship the file — the
 * same gap `dsh-client.d.ts` documents for the rest of the SDK. Every signature
 * here was read off the shipped `lib/index.js`:
 *
 *  - `classifyFileType` — `lib/index.js:6207`
 *  - `FileTypeIcon`     — `lib/index.js:6409`, dispatching to `CodeFileIcon`
 *                          (`:5803`, full-colour brand glyphs, own 20×20
 *                          viewBox) for code files and to the category-tinted
 *                          file glyph for everything else.
 *
 * Scope is deliberately the two symbols this plugin calls, and the props it
 * actually passes. A declaration that modelled the package's several hundred
 * exports would be a second, unverifiable copy of it — and the one that matters
 * is the *runtime* shape, not a shape the compiler accepts. See the note on
 * `workspaceFiles.changes` in `dsh-client.d.ts` for what guessing costs.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** The `kind` a file's path classifies to, as `FileTypeIcon` reads it. */
  type FileTypeIconKind = string

  interface FileTypeIconBaseProps {
    /** Rendered width and height in px; the component's own default is 28. */
    size?: number
    /** Passed through to the `<svg>`; the caller owns the box, not the colour. */
    className?: string
  }

  /**
   * A file-type glyph for an already-classified kind.
   *
   * The colour belongs to the component: code files get their brand artwork,
   * everything else a category tint (`code`, `markdown`, `html`, `image`,
   * `video`, `pdf`, `word`, `excel`, `ppt`, `folder`, `other`), each read from a
   * `--dsh-file-type-*` token. There is nothing to style from the outside, and
   * the element carries its own `aria-hidden` — the caller owns the accessible
   * name, which for a tree row is the row's `title`.
   */
  function FileTypeIcon(props: FileTypeIconBaseProps & { kind: FileTypeIconKind }): import('react').ReactElement

  /**
   * Classify a path or basename into a `FileTypeIcon` kind.
   *
   * Upstream takes a second `context` argument for project-sensitive code
   * mappings; this plugin never passes one, and DSH's own file tree
   * (`dsh-client-ui-sidebar-files`) calls it the same way — one argument, the
   * entry name. Declaring only that arity is intentional: a caller who wants
   * `context` should read the upstream signature rather than trust a shape
   * invented here.
   */
  function classifyFileType(path: string): FileTypeIconKind

  /** Props the folder artwork actually reads; it spreads the rest away. */
  interface FolderIconProps {
    /** Rendered width and height in px; the artwork's own default is 16. */
    size?: number
    /** Passed through to the `<svg>`; the artwork strokes with `currentColor`. */
    className?: string
  }

  /**
   * The folder glyphs, one per expansion state.
   *
   * DSH's own file tree (`dsh-client-ui-sidebar-files/lib/client.js`) calls exactly
   * these two for a directory:
   *
   *     expanded ? IconFolderOpenRegular : IconFolderCloseRegular
   *
   * and passes only a `className` — no `size`, because `FolderCloseArtwork` is
   * declared `({ size = 16, className, strokeWidth })` with a `0 0 16 16` viewBox,
   * which is already the width of an icon column. Only those three props are read:
   * the artwork does not spread the rest of its props onto the `<svg>`, so a
   * `style` handed to it would be dropped silently.
   */
  function IconFolderOpenRegular(props: FolderIconProps): import('react').ReactElement
  function IconFolderCloseRegular(props: FolderIconProps): import('react').ReactElement
}
