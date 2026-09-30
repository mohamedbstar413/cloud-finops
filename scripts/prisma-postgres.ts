/**
 * Production runs on PostgreSQL; local development on SQLite (zero setup).
 * Both use the same data model: this writes prisma/postgres/schema.prisma from
 * prisma/schema.prisma with the PostgreSQL provider. Run after changing the
 * schema, then create a migration:
 *   npm run db:postgres:schema
 *   npx prisma migrate dev --schema prisma/postgres/schema.prisma --name <change>   (against a dev Postgres)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const source = readFileSync("prisma/schema.prisma", "utf8");
const pg = source
  .replace(/datasource db \{[\s\S]*?\}/, 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}')
  .replace(/^\/\/ .*SQLite[\s\S]*?\n\n/m, "// GENERATED from prisma/schema.prisma by scripts/prisma-postgres.ts — do not edit by hand.\n\n");
if (!pg.includes('provider = "postgresql"')) throw new Error("Could not rewrite the datasource block");
mkdirSync("prisma/postgres", { recursive: true });
writeFileSync("prisma/postgres/schema.prisma", pg);
console.log("Wrote prisma/postgres/schema.prisma");
