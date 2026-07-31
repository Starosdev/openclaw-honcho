export function registerGatewayHook(api, state) {
    api.on("gateway_start", async (_event, _ctx) => {
        api.logger.info("Initializing Honcho memory...");
        try {
            await state.ensureInitialized();
            const { filePath, peers } = state.peersPersister;
            api.logger.info(`Honcho memory ready — peer map: ${filePath} (${Object.keys(peers).length} known sender${Object.keys(peers).length === 1 ? "" : "s"})`);
        }
        catch (error) {
            api.logger.error(`Failed to initialize Honcho at ${state.cfg.baseUrl}: ${error}`);
        }
    });
}
