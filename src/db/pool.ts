import { Pool, type PoolClient } from 'pg';
import { env } from '../config';

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

pool.on('error', (error) => {
  console.error('[db] erro em cliente ocioso do pool', error);
});

let guardChecked: Promise<void> | undefined;

/**
 * Superuser e BYPASSRLS ignoram Row Level Security mesmo com FORCE ROW LEVEL SECURITY.
 * Se a aplicacao conecta com um desses papeis, o isolamento entre tenants vira decoracao
 * silenciosamente. Verificamos uma vez e recusamos o boot.
 */
const assertRlsEnforced = (): Promise<void> => {
  guardChecked ??= withClient(async (client) => {
    const result = await client.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );

    const role = result.rows[0];
    if (!role) {
      throw new Error('[db] nao foi possivel resolver o papel da conexao');
    }
    if (role.rolsuper || role.rolbypassrls) {
      throw new Error(
        `[db] conexao como "${role.current_user}" ignora RLS (superuser=${role.rolsuper}, bypassrls=${role.rolbypassrls}). ` +
          'Use um papel dedicado para a aplicacao e reserve o papel dono das tabelas para a migration.'
      );
    }

    console.log(`[db] RLS ativo para o papel ${role.current_user}`);
  });

  return guardChecked;
};

const withClient = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
};

export const withTenant = async <T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  withClient(async (client) => {
    await assertRlsEnforced();
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const withSystem = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> =>
  withClient(async (client) => {
    await assertRlsEnforced();
    await client.query('BEGIN');
    try {
      // `app.tenant_id` limpo de proposito: a conexao volta do pool para dentro
      // de outra transacao, e um tenant la esquecido restringiria a leitura de
      // sistema em vez de abre-la.
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      await client.query("SELECT set_config('app.is_system', 'true', true)");
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const closePool = async (): Promise<void> => {
  await pool.end();
};
