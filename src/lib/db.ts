import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";
import { Pool, type PoolClient } from "pg";
import { readConfig, ConfigurationError } from "./config";
import { validateDatabaseConnection } from "./database-configuration";

const databaseGlobal = globalThis as unknown as { solarPrisma?: PrismaClient; solarAuthPool?: Pool };

// Lazy construction means compilation and demo requests never contact PostgreSQL.
export function getDatabase() {
  const configuration = readConfig();
  if (configuration.dataAdapter !== "postgres" || configuration.demoMode) {
    throw new ConfigurationError("La demostración usa exclusivamente fixtures; PostgreSQL está deshabilitado.");
  }
  if (!configuration.databaseUrl) {
    throw new ConfigurationError("Falta DATABASE_URL para el adaptador PostgreSQL.");
  }
  validateDatabaseConnection(configuration.databaseUrl, "solar_runtime", configuration.appEnv, "DATABASE_URL");
  if (databaseGlobal.solarPrisma) return databaseGlobal.solarPrisma;
  const adapter = new PrismaPg({
    connectionString: configuration.databaseUrl,
    options: "-c timezone=UTC",
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  const client = new PrismaClient({ adapter });
  databaseGlobal.solarPrisma = client;
  return client;
}

// solar_auth has EXECUTE rights on the narrowly scoped auth_* functions only.
// It has no direct table access and is separate from the tenant runtime connection.
export function getAuthenticationDatabase() {
  const configuration = readConfig();
  if (configuration.demoMode || configuration.dataAdapter !== "postgres") {
    throw new ConfigurationError("La demostración no abre sesiones de identidad real.");
  }
  if (!configuration.authDatabaseUrl || configuration.authDatabaseUrl === configuration.databaseUrl) {
    throw new ConfigurationError("Configura AUTH_DATABASE_URL con el rol de identidad separado.");
  }
  validateDatabaseConnection(configuration.authDatabaseUrl, "solar_auth", configuration.appEnv, "AUTH_DATABASE_URL");
  if (!databaseGlobal.solarAuthPool) {
    databaseGlobal.solarAuthPool = new Pool({
      connectionString: configuration.authDatabaseUrl,
      options: "-c timezone=UTC",
      max: 3,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return databaseGlobal.solarAuthPool;
}

export async function withAuthenticationDatabase<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAuthenticationDatabase().connect();
  try {
    const result = await client.query<{ safe: boolean }>(`
      SELECT current_user = 'solar_auth' AND session_user = 'solar_auth'
        AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole
        AND NOT pg_has_role(current_user, 'solar_security_guard', 'MEMBER')
        AND NOT pg_has_role(current_user, 'solar_migrator', 'MEMBER')
        AND NOT has_table_privilege(current_user, 'public.users', 'SELECT,INSERT,UPDATE,DELETE')
        AND NOT has_table_privilege(current_user, 'public.sessions', 'SELECT,INSERT,UPDATE,DELETE')
        AND NOT EXISTS (SELECT FROM pg_roles privileged
          WHERE (privileged.rolsuper OR privileged.rolbypassrls OR EXISTS (
            SELECT FROM pg_class owned JOIN pg_namespace owned_schema ON owned_schema.oid = owned.relnamespace
            WHERE owned_schema.nspname = 'public' AND owned.relowner = privileged.oid AND owned.relkind IN ('r','p')))
          AND pg_has_role(current_user, privileged.oid, 'MEMBER'))
        AND NOT EXISTS (SELECT FROM pg_class accessible JOIN pg_namespace accessible_schema ON accessible_schema.oid = accessible.relnamespace
          WHERE accessible_schema.nspname = 'public' AND accessible.relkind IN ('r','p')
            AND has_table_privilege(current_user, accessible.oid, 'SELECT,INSERT,UPDATE,DELETE'))
        AND NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relowner = r.oid AND c.relkind IN ('r','p')) AS safe
      FROM pg_roles r WHERE r.rolname = current_user`);
    if (!result.rows[0]?.safe) throw new ConfigurationError("La conexión de identidad requiere el rol restringido solar_auth.");
    return await callback(client);
  } finally { client.release(); }
}
