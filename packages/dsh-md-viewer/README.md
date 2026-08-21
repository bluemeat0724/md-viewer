# dsh-md-viewer — Markdown workspace viewer (DSH plugin)

English | [中文](README.zh.md)

Browse any workspace's Markdown and JSON inside the DeepSeek Harness web GUI, rendered
by the **md-viewer engine** (marked + highlight.js + mermaid into a
  self-contained offline snapshot). The host half reuses the
`@bluemeat0724/md-viewer` programmatic API in-process — no shell spawning, no
external service.

This package is the **DSH plugin wrapper of the md-viewer project**, maintained
in the same repository (`packages/dsh-md-viewer`).

## Capabilities

- One-click snapshot build: pick a workspace (or type any directory path) and
  click "Build & preview"; the host renders every `*.md` / `*.json` into
  `<dir>/.agents/md-viewer/index.html` and caches it in memory.
- Embedded preview: a full-screen overlay shows the result in an iframe
  (`/mdv/<dir>` route) — file tree, full-text search, Mermaid zoom, theme
  toggle, plus open-in-new-tab.
- Two entry points: a conversation header action and a sidebar footer entry.
- Agent tools: `mdv_build [dir]` renders a directory (defaults to the session
  workspace); `mdv_status` lists built snapshots.

## Security model

- Builds are user-driven (GUI click) or explicitly invoked by the agent
  (`mdv_build`); the host writes exactly one file, `<dir>/.agents/md-viewer/index.html`,
  with host-process permissions.
- All `/api/mdv/*` and `/mdv/*` routes carry a loopback-only trust fence.
- Snapshots live in host memory only.

## Install

```sh
# from npm (recommended)
dsh plugin --profile web add @bluemeat0724/dsh-md-viewer

# local development
dsh plugin --profile web add link:/Users/g-air/projects/research/md-viewer/packages/dsh-md-viewer
```

## Development

```sh
cd packages/dsh-md-viewer
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The render pipeline lives in the `@bluemeat0724/md-viewer` dependency (repo
root); this package adds the DSH surfaces (routes, tools, UI). The build preset
`build/tsdown.client.ts` is a self-contained vendored copy (originally from
dsh-web-ui's shared preset); keep it in sync when the DSH SDK moves.
