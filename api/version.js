import { json, methodNotAllowed, readBody } from "../lib/http.js";
import { assertRequestAllowed } from "../lib/security.js";
import { readTreasuryConfig } from "../lib/bankCollections.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    await assertRequestAllowed(req, await readBody(req));

    const url = new URL(req.url, "https://api.local");
    const versionCode = Number(url.searchParams.get("versionCode") || "0");
    if (!Number.isFinite(versionCode) || versionCode <= 0) {
      return json(res, 400, { error: "invalid_version_code" });
    }

    const config = await readTreasuryConfig();
    const minSupportedVersionCode = Number(config.minSupportedVersionCode || 4);
    const updateRequired = versionCode < minSupportedVersionCode;

    return json(res, 200, {
      ok: true,
      updateRequired,
      versionCode,
      minSupportedVersionCode,
      source: "vercel"
    });
  } catch (error) {
    return json(res, error.statusCode || 500, {
      error: error.message || "internal_error"
    });
  }
}
