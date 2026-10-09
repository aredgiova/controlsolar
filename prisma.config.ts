import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // No dummy database URL and no connection required for validate/generate.
  // Migration credentials are never used by the web application's runtime pool.
  ...(process.env.DATABASE_MIGRATION_URL ? { datasource: { url: process.env.DATABASE_MIGRATION_URL } } : {}),
});
