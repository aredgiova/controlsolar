import { ConfigurationError } from "./configuration-error";

export type DatabaseRole = "solar_runtime" | "solar_auth" | "solar_ingest" | "solar_worker";
const sslParameters = new Set(["sslmode", "sslrootcert", "sslcert", "sslkey"]);

// Inspect the same URL that pg receives. Query parameters must not override the
// host, role, TLS or options after validation (pg uses the last duplicate value).
export function validateDatabaseConnection(value: string, role: DatabaseRole, appEnv: string | undefined, field: string, environment: Record<string, string | undefined> = process.env) {
  const fail = (): never => { throw new ConfigurationError(`${field} requiere ${role}, destino explícito y TLS verify-full fuera del desarrollo loopback.`); };
  let url: URL;
  try {
    if (/[\u0000-\u0020\u007f]/.test(value)) return fail();
    url = new URL(value);
    if (!/^postgres(ql)?:$/.test(url.protocol) || decodeURIComponent(url.username) !== role || !url.password ||
      !url.hostname || url.hostname.includes("%") || !/^\/[^/]+$/.test(url.pathname) || url.hash ||
      /[\u0000-\u001f\u007f]/.test(decodeURIComponent(url.pathname))) return fail();
  } catch { return fail(); }
  const seen = new Set<string>();
  for (const [name, parameter] of url.searchParams) {
    if (!sslParameters.has(name) || seen.has(name) || !parameter || /[\u0000-\u001f\u007f]/.test(parameter)) return fail();
    seen.add(name);
  }
  const local = appEnv === "development" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const mode = url.searchParams.get("sslmode");
  if ((!local && mode !== "verify-full") || (mode !== null && !["verify-full", ...(local ? ["disable"] : [])].includes(mode)) ||
    Boolean(url.searchParams.get("sslcert")) !== Boolean(url.searchParams.get("sslkey")) || environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") return fail();
  return url;
}
