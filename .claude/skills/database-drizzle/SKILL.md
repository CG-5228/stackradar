---
name: database-drizzle
description: >-
  Domain knowledge for PostgreSQL database patterns using Drizzle ORM: schema
  definitions, migrations, repository patterns, and transactions. Use when
  creating tables, writing migrations, adding repositories, or working with
  Drizzle queries.
---

# Database & Drizzle Patterns

## Stack

- **ORM**: Drizzle ORM (`drizzle-orm/postgres-js`)
- **Driver**: `postgres` (postgres.js)
- **Database**: PostgreSQL 18
- **Config**: `server/drizzle.config.ts`
- **Default URL**: `postgres://postgres:postgres@localhost:5444/server`

## DB Instance (`server/src/db/index.ts`)

```typescript
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

const client = postgres(config.database.url);
export const db = drizzle(client, { schema });
export type Database = typeof db;
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
```

## Schema Layout (`server/src/db/schema/`)

One file per domain, all re-exported from `index.ts`. The file list is the
source of truth (`ls server/src/db/schema/`); do not keep a copy of it here.
The maintained reference is [`server/src/db/schema/README.md`](../../../server/src/db/schema/README.md)
(the core ingest path, by domain) and [`server/src/db/SCHEMA.md`](../../../server/src/db/SCHEMA.md)
(every table). Three facts worth knowing before reading them:

- `users.ts` is a profile mirror only. The Auth.js tables (`users`, `sessions`,
  `accounts`, `verification_tokens`) belong to the *client's* Drizzle project
  (`client/src/db/schema/`) and live in the `auth` schema of the **same**
  database, with their own journal (`auth.__drizzle_migrations`).
- `images` is cluster-scoped: identity is `(cluster_id, digest)` (ADR 0006), and
  `sboms` holds one row per image via `sboms_image_id_unique`; there is no
  `is_current` flag.
- The OSV mirror writes advisories into `vulnerabilities` /
  `vulnerability_affected_packages`; `osv-mirror.ts` is bookkeeping only
  (`osv_sync_state`, `osv_sync_runs`, `osv_sync_failures`). There are no
  `osv_vulns` / `osv_affected_packages` tables.

## Table Definition Pattern

```typescript
import { pgTable, uuid, varchar, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const things = pgTable("things", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("things_name_org_unique").on(table.name, table.orgId),
]);

export type Thing = typeof things.$inferSelect;
export type NewThing = typeof things.$inferInsert;
```

### Conventions
- **IDs**: `uuid().primaryKey().defaultRandom()` — except high-insert churn tables (`components`, `workload_containers`), which use ``.default(sql`uuidv7()`)`` (PG18) for PK index locality
- **Timestamps**: `timestamp(..., { withTimezone: true }).notNull().defaultNow()` for `createdAt` and `updatedAt`
- **Foreign keys**: `.references(() => table.id, { onDelete: "cascade" })`
- **Indexes**: third argument to `pgTable` returns array
- **Composite PKs**: `primaryKey({ name: "...", columns: [...] })`
- **Type inference**: `$inferSelect` for reads, `$inferInsert` for writes

## Repository Pattern

```typescript
export const imageRepository = {
  async findAll(): Promise<Image[]> {
    return db.select().from(schema.images);
  },
  async findById(id: string): Promise<Image | undefined> {
    const [result] = await db.select().from(schema.images).where(eq(schema.images.id, id));
    return result;
  },
  async create(data: NewImage, tx?: Transaction): Promise<Image> {
    const [result] = await (tx ?? db).insert(schema.images).values(data).returning();
    return result!;
  },
  async update(id: string, data: Partial<NewImage>): Promise<Image | undefined> {
    const [result] = await db.update(schema.images).set(data).where(eq(schema.images.id, id)).returning();
    return result;
  },
  async delete(id: string): Promise<boolean> {
    const result = await db.delete(schema.images).where(eq(schema.images.id, id));
    return result.count > 0;
  },
};
```

### Conventions
- Object of async methods (not a class)
- CRUD naming: `findAll`, `findById`, `create`, `update`, `delete`
- Optional `tx?: Transaction` parameter for transactional operations
- `(tx ?? db)` pattern to support both transactional and standalone calls
- Re-export from `server/src/repositories/index.ts`

## Transactions

```typescript
return db.transaction(async (tx) => {
  const sbom = await sbomRepository.create(data, tx);
  await componentRepository.batchCreate(components, tx);
  return sbom;
});
```

## Migrations (`server/drizzle/`)

- Journal: `drizzle/meta/_journal.json`
- Files: `{index}_{descriptive-name}.sql` (e.g. `0002_add-cvss-score-to-vulnerabilities.sql`)
- Generate: `pnpm db:generate`
- Apply: only against a database you own. Your local Compose database:
  `MIGRATE_ON_START=true pnpm dev`. Self-hosted installs apply the chain at
  boot the same way (`src/db/migrate.ts`, under an advisory lock shared with
  the client's migrator); hosted deployments apply it from their deploy
  pipeline. Never run `pnpm db:migrate`, `db:reset` or drizzle-kit
  migrate/push against a shared or hosted database — ship the generated file
  with the release and let that environment's normal path apply it (root
  `AGENTS.md`, "Database Setup").
- Studio: `pnpm db:studio`

## Common Drizzle Imports

```typescript
import { eq, and, desc, sql, count, inArray } from "drizzle-orm";
import { db, schema, type Transaction } from "../db/index.js";
```

## Docker Compose Database

- Port: `5444` (mapped to container `5432`)
- One database, `server`: the server owns the `public` schema, the client's Auth.js tables live in its `auth` schema
- Init script: `scripts/init-db.sql`
