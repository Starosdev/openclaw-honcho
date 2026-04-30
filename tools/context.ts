import { Type } from "@sinclair/typebox";
// @ts-ignore - resolved by openclaw runtime
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { PluginState } from "../state.js";
import { buildSessionKey } from "../helpers.js";

export function registerContextTool(api: OpenClawPluginApi, state: PluginState): void {
  api.registerTool(
    (toolCtx) => ({
      name: "honcho_context",
      label: "Get User Context",
      description:
        "Retrieve stored knowledge about the user across all sessions. Use 'card' for a quick key-facts list, 'full' for the complete representation.",
      parameters: Type.Object(
        {
          detail: Type.Optional(
            Type.Unsafe<"card" | "full">({
              type: "string",
              enum: ["card", "full"],
              description: "Detail level: 'card' for key facts (default, fast), 'full' for broad representation.",
            })
          ),
          about: Type.Optional(
            Type.String({
              description:
                "Sender ID of the user to query about. Defaults to the last active sender. Pass a specific sender_id to get context about a different participant.",
            })
          ),
        },
        { additionalProperties: false }
      ),
      async execute(_toolCallId, params) {
        const { detail = "card", about } = params as { detail?: "card" | "full"; about?: string };

        const t0 = Date.now();
        api.logger.debug?.(`[honcho] honcho_context: detail=${detail} about=${about ?? "default"}`);

        await state.ensureInitialized();
        const participantPeer = about
          ? await state.getParticipantPeer(about)
          : await state.resolveSessionParticipantPeer(buildSessionKey(toolCtx));

        if (detail === "card") {
          api.logger.debug?.(`[honcho] honcho_context: calling participantPeer.card() peer=${participantPeer.id}`);
          const tCard = Date.now();
          const card = await participantPeer.card().then((r) => {
            api.logger.debug?.(`[honcho] honcho_context: card() completed in ${Date.now() - tCard}ms (total ${Date.now() - t0}ms)`);
            return r;
          }).catch((err) => {
            // Only treat NotFoundError as empty; re-throw others or log
            if (err?.name === "NotFoundError") return null;
            // Optionally log unexpected errors for debugging
            console.warn("honcho_context card() error:", err);
            return null;
          });

          if (!card?.length) {
            return {
              content: [
                {
                  type: "text",
                  text: "No profile facts available yet. The user's profile builds over time through conversations.",
                },
              ],
              details: { detail, factCount: 0 },
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `## User Profile\n\n${card.map((f) => `• ${f}`).join("\n")}`,
              },
            ],
            details: { detail, factCount: card.length },
          };
        }

        // detail === "full"
        api.logger.debug?.(`[honcho] honcho_context: calling participantPeer.representation(full) peer=${participantPeer.id}`);
        const tRepr = Date.now();
        const representation = await participantPeer.representation({
          includeMostFrequent: true,
        });
        api.logger.debug?.(`[honcho] honcho_context: representation() completed in ${Date.now() - tRepr}ms (total ${Date.now() - t0}ms)`);

        if (!representation) {
          return {
            content: [
              {
                type: "text",
                text: "No context available yet. Context builds over time through conversations.",
              },
            ],
            details: { detail, representationLength: 0 },
          };
        }

        return {
          content: [{ type: "text", text: `## User Context\n\n${representation}` }],
          details: { detail, representationLength: representation.length },
        };
      },
    }),
    { name: "honcho_context" }
  );
}
