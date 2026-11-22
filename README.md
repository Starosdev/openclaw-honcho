# Honcho Memory Plugin for OpenClaw

[![Honcho Banner](./assets/honcho_claw.png)](https://honcho.dev)

AI-native memory with dialectic reasoning for OpenClaw. Uses [Honcho's](https://honcho.dev) peer paradigm to build and maintain separate models of the user and the agent — enabling context-aware conversations that improve over time. No local infrastructure required.

This plugin uses OpenClaw's slot system (`kind: "memory"`) to replace the built-in memory plugins (`memory-core`, `memory-lancedb`). During setup, existing memory files can be migrated to Honcho. Workspace docs (`SOUL.md`, `AGENTS.md`, `BOOTSTRAP.md`) can be updated manually to reference Honcho's tools instead of the old file-based system.

## Fork Note

The `Starosdev/openclaw-honcho` fork carries one downstream compatibility backport for
older Staros OpenClaw runtimes that cannot yet load upstream `v1.2.0+`.

- Live Staros pin: commit `1080c2cf6ad18e940c243f72e023f9e46cd80626`
- Backport package version: `1.1.1-staros.1`
- Original backport branch: `fix/backport-session-key-cap-1.1.1`
- Fork `main` now contains the merge commit that preserves that backport history,
  but Staros should keep pinning the exact backport commit rather than tracking
  the fork head.

## Install

```bash
openclaw plugins install @honcho-ai/openclaw-honcho
openclaw honcho setup
openclaw gateway restart
```

`openclaw honcho setup` prompts for your Honcho API key, writes the config, and optionally uploads any legacy memory files to Honcho.

<details>
<summary>Alternative: ClawHub Skill</summary>

Use the `honcho-setup` skill to run migration interactively from within a chat session:

```bash
# 1. Install the skill
npx clawhub install honcho-setup
# 2. Restart OpenClaw to pick up the new skill
# 3. Install the plugin
openclaw plugins install @honcho-ai/openclaw-honcho
# 4. Restart the gateway
openclaw gateway restart
# 5. Open an agent session and invoke the skill
#    The skill will prompt for your Honcho API key and run setup interactively
```
</details>

## Migrating Legacy Memory

If you have existing workspace memory files (`USER.md`, `MEMORY.md`, `IDENTITY.md`, `memory/`, `canvas/`, etc.), `openclaw honcho setup` will detect them and offer to migrate them.

Migration is **non-destructive** — files are uploaded to Honcho. Originals are never deleted or moved.

### Legacy files

**User/owner files** (content describes the user):
- `USER.md`, `MEMORY.md`
- All files in `memory/` and `canvas/` directories (treated as user content)

**Agent/self files** (content describes the agent):
- `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md`, `BOOTSTRAP.md`

### Upload to Honcho

Files are uploaded via `session.uploadFile()`. User/owner files go to the owner peer; agent/self files go to the agent peer (`agent-{agentId}`, e.g. `agent-main`).

### Update workspace docs

The plugin ships template files in `node_modules/@honcho-ai/openclaw-honcho/workspace_md/`. Copy or merge these templates into your workspace for `AGENTS.md`, `SOUL.md`, and `BOOTSTRAP.md`. These templates reference the Honcho tools (`honcho_context`, `honcho_search_conclusions`, `honcho_ask`, `honcho_search_messages`, `honcho_session`) instead of the old file-based memory system.

## Configuration

Run `openclaw honcho setup` to configure interactively, or set values directly in `~/.openclaw/openclaw.json` under `plugins.entries["openclaw-honcho"].config`.

| Key                    | Type       | Default                    | Description                               |
| ---------------------- | ---------- | -------------------------- | ----------------------------------------- |
| `apiKey`               | `string`   | —                          | Honcho API key (required for managed; omit for self-hosted). |
| `workspaceId`          | `string`   | `"openclaw"`               | Honcho workspace ID for memory isolation. |
| `baseUrl`              | `string`   | `"https://api.honcho.dev"` | API endpoint (for self-hosted instances). |
| `noisePatterns`        | `string[]` | built-in defaults          | Patterns to skip messages. User-provided patterns are merged with built-in defaults (unless `disableDefaultNoisePatterns` is set). |
| `disableDefaultNoisePatterns` | `boolean` | `false`           | When `true`, built-in noise patterns are not applied — only `noisePatterns` entries are used. |
| `crossSessionSearch`   | `boolean`  | `true`                     | Default scope for `memory_search`. `true` = results span every session the participant peer has written to; `false` = scope to the active session. `memory_search` accepts an optional `crossSessionSearch` boolean parameter to override this per-call. |
| `ownerObserveOthers`   | `boolean`  | `false`                    | Whether the owner peer observes agent messages in Honcho's social model. |
| `peerName`             | `string`   | `owner`                    | Explicit owner peer ID in the Honcho workspace. Use it to reuse an owner peer from another integration. |

`enableWorkspaceChat` defaults to `false`. Set it to `true` to register `honcho_workspace_chat`. Only verified direct operators can use it, and its answers can draw from the entire Honcho workspace. Requester-scoped memory tools keep their existing access rules.

Changing `peerName` leaves historical messages on their original peer. New custom-owner capture requires verified owner attribution. Use requester-aware tools such as `memory_search` and `memory_get` from a verified owner session. Honcho records protected owners as members of the workspace's message-free `openclaw-owner-policy` session. This preserves owner protection after you change or remove `peerName`, including for automatic prompt recall and requester-less memory lookup.

Set `enableSharedConfigCredentials: true` to reuse an `apiKey` and `environmentUrl` from `~/.honcho/config.json`. Plugin configuration and `HONCHO_API_KEY` take priority. The root and `hosts.openclaw` each supply a complete pair. When the file supplies the key, the configured endpoint must match its HTTP(S) origin. Workspace selection remains in OpenClaw. Setup edits the active OpenClaw profile, keeps the shared key in the shared file, and requires a newly entered key to change the origin of an existing authenticated connection.
| `recall` | `object` | see below | How far each recall path may reach. See [Recall Boundaries](#recall-boundaries). |

### Self-Hosted / Local Honcho

Run `openclaw honcho setup`, enter a blank API key, and set the Base URL to your instance (e.g., `http://localhost:8000`).

For setting up a local Honcho server, see the [Honcho local development guide](https://github.com/plastic-labs/honcho?tab=readme-ov-file#local-development).

### Noise Filtering

The plugin automatically drops messages that match noise patterns before saving to Honcho. Built-in defaults filter:

- `HEARTBEAT_OK` — assistant heartbeat acknowledgments
- `A scheduled reminder has been triggered` — cron reminder boilerplate
- `Execute your Session Startup sequence now` — session startup commands
- `Queued messages from` — queued message wrapper headers

Add custom patterns via `noisePatterns` in your config:

```json
{
  "plugins": {
    "entries": {
      "openclaw-honcho": {
        "config": {
          "noisePatterns": ["my custom noise string"]
        }
      }
    }
  }
}
```

Custom patterns are merged with the built-in defaults. Each pattern matches if the message **equals** it or **starts with** it. Patterns starting with `/` are treated as anchored regex (e.g., `/^HEARTBEAT/i`).

### Owner Peer Observation

Honcho's `observeOthers` controls whether a peer forms representations of other peers based on messages it witnessed in shared sessions. The owner, participant, and agent peers default to `observeOthers: false`. The agent peer still observes its own messages, while the owner peer remains the canonical source for user conclusions. This avoids duplicate `agent-main` → `owner` conclusions.

Set `ownerObserveOthers: true` to let owner and participant peers observe agent messages. This gives Honcho perspective-aware memory: those peers store conclusions about the agent based on what they witnessed. The agent peer remains self-observing and does not create a second model of the owner.

### Peer Mappings

Map `sender_id` → Honcho peer ID in `~/.honcho/openclaw-peers.json` (override with `OPENCLAW_HONCHO_PEERS_FILE`). New senders are added automatically; edit `peers` to alias or merge identities, then **`openclaw gateway restart`** so the gateway reloads the file.

```json
{
  "version": 1,
  "defaultUnknownPolicy": "per-sender",
  "peers": {
    "U0EXAMPLE01": "user",
    "telegram-1234567890": "user"
  }
}
```

- **`defaultUnknownPolicy`** controls how unknown `sender_id`s are seeded into `peers`:
  - `per-sender` — default for fresh installs. Each new sender becomes its own peer; the seeded peer ID is the `sender_id` sanitized to `[A-Za-z0-9_-]` and truncated to Honcho's 100-char limit.
  - `owner` — default for pre-existing files missing the field (preserves legacy behavior). All unknown senders merge into the owner peer.
- **Auto-seeded, manually overridable.** The plugin only adds entries for senders not already in the map.
- **Adding a mapping after messages exist splits history.** Messages already stored under the original peer stay there; new messages land under the new peer. Remap before the peer accumulates history.

### Multi-Peer Participants

Honcho attributes captured messages to sender peers in group chats and DMs. Capture uses the Gateway's `ctx.senderId` for the user row that matches the current run. For other rows, it uses each row's persisted sender ID when available. Ordinary capture can fall back to `sender_id` in the legacy "Conversation info (untrusted metadata)" text block when structured identity is absent.

Automatic recall prefers the current run's structured sender when choosing a peer. Requester-aware tools resolve the peer from trusted Gateway tool context. The [peers file](#peer-mappings) controls aliases and the policy for unknown senders. A fresh install uses `per-sender`, while the legacy `owner` policy groups unknown senders under `owner`. Ordinary capture can fall back to `owner` for rows without a sender. Verified owners can use the optional `peerName`. Existing stored rows keep their original peer IDs. Each OpenClaw agent has its own peer, typically `agent-{id}`.

## Shared direct-message sessions

On Vega's pinned Gateway, Telegram and Discord DMs that share an OpenClaw main session use a separate Honcho session per channel and trusted sender. Capture, automatic recall, and session-scoped tools use the same session key. Peer mapping and wider recall scope still follow their own settings. Configurations that route groups to main globally or through a binding retain shared-main behavior.

Replay selects each sender's turns using persisted sender and channel metadata before applying capture checkpoints. When the pinned Gateway rebuilds an in-memory user row with only its idempotency key, Honcho looks up the matching durable transcript entry. Compaction and reset can flush each sender's attributed pending turns even when the hook has no sender. Prior shared Honcho rows remain under their original key.

## ClawTalk capture on Vega

Vega assigns Honcho to `plugins.slots.memory` with the value `openclaw-honcho`. ClawTalk capture uses the verified device's own Honcho peer. For each captured turn, the matching user message row carries both `openclawMessageId` and `openclawRunId`. Before writing the user message on replay or retry, capture checks for a row with both IDs in the Honcho session and skips the duplicate.

## How it works

Once installed, the plugin works automatically:

- **Message Observation** — After every AI turn, the conversation is persisted to Honcho. Both user and agent messages are observed, allowing Honcho to build and refine its models. Message capture starts when the plugin is active for a session, and preserves original timestamps for captured messages. Messages are also flushed before session compaction and `/new`/`/reset`, so no conversation data is lost.
- **Tool-Based Context Access** — The AI can query Honcho mid-conversation using tools like `honcho_context`, `honcho_search_conclusions`, and `honcho_ask` to retrieve relevant context about the user. Context is injected during OpenClaw's `before_prompt_build` phase, ensuring accurate turn boundaries.
- **Multi-Peer Model.** Honcho maintains separate representations for the peers associated with each participant and agent. See [sender attribution](#multi-peer-participants) for how capture, recall, and tools choose peers.
- **Clean Persistence** — Platform metadata (conversation info, sender headers, thread context, forwarded messages) is stripped before saving to Honcho, ensuring only meaningful content is persisted. Noise messages (heartbeat acks, cron boilerplate, startup commands) are dropped entirely via configurable pattern filters.

Honcho handles all reasoning and synthesis in the cloud.

## Multi-Agent Support

OpenClaw uses a multi-agent architecture where a primary agent can spawn **subagents** to handle specialized tasks. The Honcho plugin is fully aware of this hierarchy:

- **Automatic Subagent Detection** — When OpenClaw spawns a subagent, the plugin parses the trusted requester session key from the `subagent_spawned` hook to track the parent→child relationship. Each subagent session records its `parentPeerId` in metadata.
- **Parent Observer Peer** — The spawning agent is added as a silent observer in the subagent's Honcho session (`observeMe: false, observeOthers: true`). This gives Honcho visibility into the full agent tree — the parent can see what its subagents are doing without its own messages being attributed to the subagent session.

## Workspace Files

The plugin manages markdown files in your workspace:

| File           | Contents                                               |
| -------------- | ------------------------------------------------------ |
| `SOUL.md`      | Agent profile — OpenClaw's self-model and personality. |
| `IDENTITY.md`  | Static agent identity. Uploaded to the agent peer in Honcho during setup; the local file is not modified. |
| `AGENTS.md`    | Agent capabilities and tool descriptions.              |
| `TOOLS.md`     | Tool definitions and usage instructions for the agent. |
| `BOOTSTRAP.md` | Initial context and instructions for the agent.        |

**Migration:** Legacy files (`USER.md`, `MEMORY.md`, `memory/` directory) are uploaded to Honcho during `openclaw honcho setup`. Originals are preserved in place.

## AI Tools

The plugin provides 5 tools — 3 data retrieval (cheap, no LLM) and 2 interactive (LLM-powered).

| Tool                     | Type | Description                                                                                     |
| ------------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| `honcho_context`         | Data | User knowledge across all sessions. `detail='card'` for key facts, `'full'` for broad representation. |
| `honcho_search_conclusions` | Data | Semantic vector search over stored conclusions. Returns raw memories ranked by relevance.      |
| `honcho_search_messages`  | Data | Find specific messages across all sessions. Filter by sender (user/agent/all), date, metadata.   |
| `honcho_session`         | Data | Current session history and summary. Supports semantic search within the session.               |
| `honcho_ask`             | Q&A  | Ask Honcho a question about the user. `depth='quick'` for facts, `'thorough'` for synthesis.   |
| `honcho_workspace_chat`  | Q&A  | Ask about participants, sessions, and agents across the entire workspace. Available to verified direct operators when enabled. |

## CLI Commands

```bash
openclaw honcho setup                           # Configure API key and migrate legacy files
openclaw honcho status                          # Show current installation and setup state
openclaw honcho ask <question>                  # Query Honcho about the user
openclaw honcho search <query> [-k N] [-d D]    # Semantic search over memory (topK, maxDistance)
```

## Recall Boundaries

A Honcho workspace is the memory universe: a peer's representation is synthesized
across every session in it, and that synthesis is the point. Recall is therefore
workspace-wide by default on every path.

Narrowing is opt-in, per path, when you want recall focused on the conversation at
hand rather than everything the peer has ever said:

```jsonc
{
  "recall": {
    "automatic": "workspace",  // context injected before every prompt
    "ask": "workspace",        // honcho_ask
    "scopeName": "client-a"    // Honcho scope used by either path set to "scope"
  }
}
```

| value | Conclusions | Peer card |
|---|---|---|
| `workspace` | Every session the peer has written to. The default. | Full card. |
| `session` | The current Honcho session only. | **Dropped.** |
| `scope` | The sessions belonging to `scopeName`, a [Honcho scope](https://docs.honcho.dev). Needs a workspace-level API key. A scope that exists but has no member sessions returns nothing rather than widening; a missing or blank `scopeName` falls back to `session` (see below). | The scope's own card. |

`automatic: "session"` discards the peer card because a card has no session
dimension. This also covers older Honcho servers that still return the workspace
card with session filtering.

`ask: "session"` scopes conclusions but not the card: `peer.chat` fetches it
unconditionally upstream. `automatic: "session"` is a true boundary; `ask: "session"`
is a partial one.

Subagent prompts use peer recall in place of session context. Session and
named-scope modes inject only the scoped representation for subagents.
Participant resolution can still look up session metadata before recall.

A path set to `scope` with a missing or blank `scopeName` falls back to `session`
rather than silently widening.

The explicitly invoked tools (`honcho_context`, `honcho_search_conclusions`,
`honcho_search_messages`) are always workspace-wide. They cannot be bounded
uniformly on the current SDK surface — `peer.card()` takes no scoping and
`peer.search()` takes only filters — so rather than ship a setting that applies to
some of their calls and quietly skips others, they are left alone.

### Keeping tenants apart

These settings tune relevance, not tenancy. If one agent serves several clients,
accounts or teams whose memory must not mix, **give them separate workspaces** —
`workspaceId` is per plugin entry — or put each tenant's sessions in their own
Honcho scope and point `scopeName` at it. Narrowing recall inside a shared
workspace limits what any one turn retrieves, but the memory is still derived and
stored together.

## Local File Search (QMD Integration)

Honcho's `memory_search` and `memory_get` compatibility aliases are off by default. Set `plugins.entries.openclaw-honcho.config.enableMemoryCompatibilityTools` to `true` on gateways that do not supply requester-scoped tools with those names. Vega's Gateway revision `609bc7d` needs this opt-in when Honcho owns its memory slot. This setting controls tool registration. Honcho's memory slot, recall hooks, and capture hooks use their existing settings.

### Setup

1. **Install QMD** on your server ([QMD documentation](https://github.com/tobi/qmd))

2. **Configure OpenClaw** to use QMD as the memory backend in `~/.openclaw/openclaw.json`:

```json
{
  "memory": {
    "backend": "qmd",
    "qmd": {
      "limits": {
        "timeoutMs": 120000
      }
    }
  }
}
```

3. **Set up QMD collections** for your files:

```bash
qmd collection add ~/Documents/notes --name notes
qmd update
```

4. **Restart OpenClaw**:

```bash
openclaw gateway restart
```

### Available Tools

When QMD is configured, you get both Honcho and local file tools:

| Tool            | Source | Description                                              |
| --------------- | ------ | -------------------------------------------------------- |
| `honcho_*`      | Honcho | Cross-session memory, user modeling, dialectic reasoning |
| `memory_search` | QMD    | Search local markdown files                              |
| `memory_get`    | QMD    | Retrieve file content                                    |

### Troubleshooting

#### QMD not found by OpenClaw

OpenClaw runs as a systemd service with a different PATH. Create a symlink:

```bash
sudo ln -s ~/.bun/bin/qmd /usr/local/bin/qmd
```

#### Search times out

QMD operations can take a while, especially first-time queries that download ~2GB of models. Increase the timeout in `~/.openclaw/openclaw.json`:

```json
{
  "memory": {
    "qmd": {
      "limits": {
        "timeoutMs": 120000
      }
    }
  }
}
```

The default timeout is 4000ms which depending on your hardware may be too short and cause errors. Setting it to 120000ms (2 minutes) gives QMD enough time. You can verify it's working in the logs:

```
19:09:02 tool start: memory_search
19:09:14 tool end: memory_search   # 12 seconds — within the 120s limit
```

You can also pre-warm QMD to avoid first-run delays:

```bash
qmd query "test"
```

## Known Issues

### OpenClaw 2026.4.5: Hooks silently stop firing

OpenClaw 2026.4.5 has a plugin loader bug where reentrant provider snapshot loads during initialization can cause hooks to register into a registry that is later discarded. The result is that `agent_end` (and potentially other hooks) never fire — the plugin appears loaded and no errors are logged, but no sessions are written to Honcho.

**Affected versions:** OpenClaw 2026.4.5 only.

**Symptoms:**
- Plugin logs `Honcho memory plugin loaded` at startup
- No errors in gateway logs
- `honcho_search_messages` returns nothing after the upgrade date
- Honcho queue shows 0 pending (deriver has nothing to process)
- Manual Honcho API calls still work

**Fix:** Update OpenClaw to **2026.4.6 or later**. The upstream fixes landed in the 4.6 changelog:

> Plugins/provider hooks: stop recursive provider snapshot loads from overflowing the stack during plugin initialization. (#61922, #61938, #61946, #61951)

```bash
# Update OpenClaw
npm install -g openclaw@latest
# or
brew upgrade openclaw

# Restart the gateway
openclaw gateway restart
```

**Verified working:** OpenClaw 2026.3.22 through 2026.4.4, and 2026.4.6+.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development setup, building from source, and contribution guidelines.

## License

[MIT License](./LICENSE)

## Community

- GitHub Issues: [Open an Issue](https://github.com/plastic-labs/honcho/issues)
- Discord: [Join the Community](https://discord.gg/honcho)
- X (Twitter): [Follow @honchodotdev](https://x.com/honchodotdev)
- Blog: [Read about Honcho and Agents](https://blog.plasticlabs.ai)
