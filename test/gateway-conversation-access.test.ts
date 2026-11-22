import { expect, it, vi } from "vitest";
import { registerGatewayHook } from "../hooks/gateway.js";

it.each([
  { consent: undefined, warns: true },
  { consent: false, warns: true },
  { consent: true, warns: false },
])("keeps startup read-only with conversation access $consent", async ({ consent, warns }) => {
  const hooks = consent === undefined ? {} : { allowConversationAccess: consent };
  const config = { plugins: { entries: { "openclaw-honcho": { hooks } } } };
  const original = JSON.stringify(config);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const on = vi.fn();
  const ensureInitialized = vi.fn(async () => undefined);
  registerGatewayHook(
    { config, logger, on } as never,
    { ensureInitialized, peersPersister: { filePath: "peers.json", peers: {} } } as never,
  );

  const [name, start] = on.mock.calls[0]!;
  expect(name).toBe("gateway_start");
  await start({}, {});
  expect(ensureInitialized).toHaveBeenCalledOnce();
  expect(JSON.stringify(config)).toBe(original);
  expect(logger.warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  if (warns) {
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      "plugins.entries.openclaw-honcho.hooks.allowConversationAccess",
    ));
  }
});
