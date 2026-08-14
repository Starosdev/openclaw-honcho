# Contributing to Honcho Memory Plugin

## Development Setup

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm
- A Honcho API key from [honcho.dev](https://honcho.dev)

### Clone and Install

```bash
git clone https://github.com/plastic-labs/openclaw-honcho.git
cd openclaw-honcho
pnpm install
```

Note: The `postinstall` script runs `install.js` which attempts to migrate workspace files. For development, you can skip this by setting up a test workspace or ensuring `HONCHO_API_KEY` is not set (it will warn but continue).

## Staros Compatibility Fork

Staros Vega work uses the `Starosdev/openclaw-honcho` fork. The
`plastic-labs/openclaw-honcho` repository is an upstream reference and release
source only; do not push branches or open pull requests there.

For fork work:

1. Fetch upstream for comparison: `git fetch origin --prune`.
2. Keep `Starosdev/openclaw-honcho:main` aligned through a fork-only sync pull request when upstream changes.
3. Create feature branches from `starosdev/main`, then push them to the `starosdev` remote.
4. Run focused tests and `pnpm build` before opening a pull request. Commit compiled `dist/` output because Git installs do not build TypeScript.
5. Open pull requests only against `Starosdev/openclaw-honcho`, then deploy the exact merged fork commit.

Live Vega installs must use a commit from the Starosdev fork. Never use an
upstream branch or commit as a deploy source.

### Build

```bash
pnpm build
```

This compiles TypeScript to `dist/` and generates type declarations.

### Test

```bash
pnpm test
```

### Project Structure

```
openclaw-honcho/
├── index.ts          # Main plugin code (tools, hooks, CLI)
├── config.ts         # Configuration schema (Zod)
├── install.js        # Post-install migration script
├── openclaw.plugin.json  # OpenClaw plugin manifest
├── workspace_md/     # Template files synced to user workspace
│   ├── AGENTS.md
│   ├── BOOTSTRAP.md
│   └── SOUL.md
└── dist/             # Compiled output (generated)
```

### Local Development with OpenClaw

To test the plugin locally with OpenClaw:

1. Build the plugin:
   ```bash
   pnpm build
   ```

2. Link it locally (from the plugin directory):
   ```bash
   pnpm link --global
   ```

3. Link it in your OpenClaw workspace:
   ```bash
   cd ~/.openclaw
   pnpm link --global @honcho-ai/openclaw
   ```

4. Restart the OpenClaw gateway to pick up changes.

### Making Changes

1. **TypeScript source** is in `index.ts` and `config.ts`
2. **Build before testing**: Always run `pnpm build` after changes and commit the resulting `dist/` output
3. **Tool return types**: All tool `execute` functions must return `{ content: [...], details: undefined }`
4. **Hooks vs Tools**: Hooks receive `(event, ctx)` with session context; tools receive `(toolCallId, params, signal?)` without session context

### Install Script Behavior

The `install.js` script runs on `pnpm install` / `npm install` and:

1. **Migrates** existing memory files to Honcho (requires `HONCHO_API_KEY`)
2. **Archives** legacy files to `archive/` directory (with timestamp if conflicts)
3. **Syncs** workspace docs from `workspace_md/` templates

Files are archived *before* being overwritten to prevent data loss.

### Publishing

The package is configured for npm publishing:

```bash
pnpm publish
```

`prepublishOnly` automatically runs `pnpm build` before publishing.

## Code Style

- TypeScript with ESM modules
- No strict mode (for compatibility with OpenClaw plugin SDK)
- Prefer async/await over callbacks
- Use descriptive tool descriptions (they're shown to the AI)

## Questions?

Open an issue at [github.com/plastic-labs/openclaw-honcho](https://github.com/plastic-labs/openclaw-honcho/issues).
