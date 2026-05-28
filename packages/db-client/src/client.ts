import postgres from 'postgres';
import { MIGRATION_001_INIT, MIGRATION_002_RLS, MIGRATION_003_WHATSAPP } from './migrations/sql.js';

export function createDbClient(url: string, options?: postgres.Options<any>): postgres.Sql {
  let cleanUrl = url;
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('schema')) {
      parsed.searchParams.delete('schema');
      cleanUrl = parsed.toString();
    }
  } catch (err) {
    // Fallback if URL parsing fails
  }
  return postgres(cleanUrl, {
    transform: postgres.camel,
    ...options,
  });
}

export class TenantScopedDb {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async runTenantScoped<T>(
    tenantId: string,
    fn: (tx: postgres.TransactionSql) => Promise<T>
  ): Promise<T> {
    const result = await this.sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE voice_app_user`;
      await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
    return result as any as T;
  }
}

export async function runMigrations(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(MIGRATION_001_INIT);
    await tx.unsafe(MIGRATION_002_RLS);
    await tx.unsafe(MIGRATION_003_WHATSAPP);
  });
}
