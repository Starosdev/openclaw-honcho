import { createRequire } from "node:module";
import { Honcho } from "@honcho-ai/sdk";
// @ts-ignore - resolved by OpenClaw runtime
import { VERSION as gatewayVersion } from "openclaw/plugin-sdk/cli-runtime";
function readPluginVersion() {
    const require = createRequire(import.meta.url);
    for (const manifest of ["./package.json", "../package.json"]) {
        try {
            const pkg = require(manifest);
            if (pkg.name === "@honcho-ai/openclaw-honcho" && pkg.version)
                return pkg.version;
        }
        catch {
            // The package manifest is above dist/ in the installed plugin.
        }
    }
    return "unknown";
}
const pluginVersion = readPluginVersion();
export function createHonchoClient(options) {
    const versionHeaders = {
        "X-Honcho-Host": gatewayVersion
            ? `openclaw/${gatewayVersion} (${process.platform})`
            : `openclaw (${process.platform})`,
        "X-Honcho-Plugin": `openclaw-honcho/${pluginVersion}`,
    };
    const client = new Honcho({
        ...options,
        defaultHeaders: { ...options.defaultHeaders, ...versionHeaders },
    });
    // SDK 2.5.0 skips defaultHeaders for multipart uploads. Pass only the
    // version headers here so fetch still supplies the multipart boundary.
    const http = client.http;
    const upload = http.upload.bind(http);
    http.upload = (path, formData, requestOptions) => upload(path, formData, {
        ...requestOptions,
        headers: { ...versionHeaders, ...requestOptions?.headers },
    });
    return client;
}
