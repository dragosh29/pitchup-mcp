// Environment handling for the Pitchup MCP server, kept apart from index.ts so the tests can check
// the base-URL rules without starting a server or touching the network.

// Spec `servers`: sandbox "https://www.sandbox.pitchup.com" ("Takes your sandbox key. Nothing here is
// real.") and live "https://www.pitchup.com" ("Real campsites, real bookings, real money."). Every
// documented path starts with /rest/api/.
export const BASE_URLS = {
  sandbox: "https://www.sandbox.pitchup.com",
  live: "https://www.pitchup.com",
} as const;
export type PitchupEnv = keyof typeof BASE_URLS;

// "Versioning": "we recommend that you specify the version in the header of your API request",
// e.g. `Accept: application/json; version=2018-06-18`. 2023-08-25 is the newest dated version the
// guide lists ("prerelease" is also documented and can be chosen with PITCHUP_API_VERSION).
export const DEFAULT_API_VERSION = "2023-08-25";

export interface Config {
  apiKey: string;
  env: PitchupEnv | "custom";
  baseUrl: string;
  apiVersion: string;
  allowWrites: boolean;
}

export class ConfigError extends Error {}

/** Read and check the PITCHUP_* variables. Throws ConfigError with a message for the user. */
export function readConfig(vars: Record<string, string | undefined>): Config {
  // The guide's troubleshooting table: "Invalid token header. Token string should not contain
  // spaces." happens when "Token" is typed twice, so a key pasted with its "Token " prefix is
  // accepted and the prefix dropped.
  const apiKey = vars.PITCHUP_API_KEY?.trim().replace(/^token\s+/i, "").trim();
  if (!apiKey) throw new ConfigError("PITCHUP_API_KEY is not set. Copy the API key from My details in the Pitchup Manager Portal (Sandbox and Live keys are different).");
  if (/\s/.test(apiKey)) throw new ConfigError("PITCHUP_API_KEY contains a space. It should be the key alone, without the word Token.");

  const envName = (vars.PITCHUP_ENV ?? "").trim().toLowerCase() || "sandbox";
  if (envName !== "sandbox" && envName !== "live") throw new ConfigError(`PITCHUP_ENV must be "sandbox" or "live" (got "${vars.PITCHUP_ENV}").`);

  let baseUrl: string = BASE_URLS[envName];
  let env: Config["env"] = envName;
  const override = vars.PITCHUP_BASE_URL?.trim();
  if (override) {
    let u: URL;
    try {
      u = new URL(override);
    } catch {
      throw new ConfigError("PITCHUP_BASE_URL is not a valid URL.");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ConfigError("PITCHUP_BASE_URL must start with https:// (or http:// for a local test server).");
    if (u.username || u.password) throw new ConfigError("PITCHUP_BASE_URL must not contain a username or password.");
    baseUrl = u.origin;
    env = "custom";
  }

  const apiVersion = (vars.PITCHUP_API_VERSION ?? "").trim() || DEFAULT_API_VERSION;
  if (!/^(\d{4}-\d{2}-\d{2}|prerelease)$/.test(apiVersion)) throw new ConfigError(`PITCHUP_API_VERSION must be a dated version such as ${DEFAULT_API_VERSION}, or "prerelease".`);

  return { apiKey, env, baseUrl, apiVersion, allowWrites: /^(1|true|yes)$/i.test(vars.PITCHUP_ALLOW_WRITES ?? "") };
}
