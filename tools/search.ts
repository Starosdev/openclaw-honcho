import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey } from "../helpers.js";
import { collectAntiHits, formatAntiHits, type AntiHit } from "../antihits.js";

export function registerSearchTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_search_conclusions",
      label: "Search Honcho conclusions",
      description:
        "Semantic vector search over stored conclusions about the user. Returns raw memories ranked by relevance. Use for finding specific past context, decisions, or preferences.",
      parameters: Type.Object(
        {
          query: Type.String({
            description: "Semantic search query (keywords, phrases, or natural language)",
          }),
          topK: Type.Optional(
            Type.Number({
              description: "Number of results: 3-5 for focused, 10-20 for exploratory (default: 10)",
              minimum: 1,
              maximum: 100,
            })
          ),
          maxDistance: Type.Optional(
            Type.Number({
              description: "Semantic distance threshold: 0.3 strict, 0.5 balanced (default), 0.7 loose",
              minimum: 0,
              maximum: 1,
            })
          ),
          about: Type.Optional(
            Type.String({
              description:
                "Sender ID of the user to query about. Defaults to the last active sender. Pass a specific sender_id to search conclusions about a different participant.",
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const { query, topK, maxDistance, about } = params as {
          query: string;
          topK?: number;
          maxDistance?: number;
          about?: string;
        };

        await state.ensureInitialized();
        const participantPeer = about
          ? await state.getParticipantPeer(about)
          : await state.resolveSessionParticipantPeer(
              buildSessionKey({ sessionKey: toolCtx.sessionKey, agentId: toolCtx.agentId }),
            );

        const resolvedTopK = topK ?? 10;
        const resolvedMaxDistance = maxDistance ?? 0.5;

        const representation = await participantPeer.representation({
          searchQuery: query,
          searchTopK: resolvedTopK,
          searchMaxDistance: resolvedMaxDistance,
        });

        // Additive and best-effort. A search that returns matches must not fail
        // because the supersession pass did.
        let antiHits: AntiHit[] = [];
        try {
          antiHits = await collectAntiHits(participantPeer.conclusions, query, {
            topK: resolvedTopK,
            maxDistance: resolvedMaxDistance,
            config: state.cfg.antiHits,
          });
        } catch (error) {
          api.logger.warn?.(`honcho_search_conclusions: anti-hits skipped: ${error}`);
        }

        if (!representation) {
          return {
            content: [
              {
                type: "text",
                text: `No memories found matching: "${query}"\n\nTry broadening your search or increasing maxDistance.`,
              },
            ],
            details: { query, resultCount: 0 },
          };
        }

        const antiHitsBlock = formatAntiHits(antiHits);
        const body = antiHitsBlock ? `${representation}\n\n${antiHitsBlock}` : representation;

        return {
          content: [{ type: "text", text: `## Search Results: "${query}"\n\n${body}` }],
          details: {
            query,
            resultCount: representation.split("\n").filter(Boolean).length,
            antiHitCount: antiHits.length,
          },
        };
      },
    }),
    { name: "honcho_search_conclusions" }
  );
}
