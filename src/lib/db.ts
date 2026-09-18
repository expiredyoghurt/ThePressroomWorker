// Thin D1 helpers. Deliberately not an ORM — the schema is small and stable
// enough (migrations/0001_init_schema.sql) that hand-written SQL stays
// readable and lets every route be explicit about exactly what it touches.

import type { Env } from "../types";

export async function queryFirst<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T | null> {
  const row = await env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
  return row ?? null;
}

export async function queryAll<T>(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<T[]> {
  const result = await env.DB.prepare(sql)
    .bind(...params)
    .all<T>();
  return result.results ?? [];
}

export async function execute(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<D1Result> {
  return env.DB.prepare(sql)
    .bind(...params)
    .run();
}

/** Runs several statements as one D1 batch (atomic). Use this for any write
 * that touches more than one table (e.g. writing an attempt AND updating
 * task_progress AND logging XP) so a mid-way failure can't leave the tables
 * inconsistent. */
export async function batch(env: Env, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  return env.DB.batch(statements);
}
