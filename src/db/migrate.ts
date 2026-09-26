import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { env } from '../config';

const APP_ROLE = 'postmidia_app';

const assertMigrationUrlSet = (): string => {
  if (!env.DATABASE_MIGRATION_URL) {
    throw new Error(
      'DATABASE_MIGRATION_URL nao definido. A migration exige um papel dono das tabelas, separado do papel da aplicacao.'
    );
  }
  return env.DATABASE_MIGRATION_URL;
};

const ensureAppRole = async (client: Client): Promise<void> => {
  await client.query(
    `DO $$
     BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
         CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${env.DATABASE_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
       END IF;
     END
     $$`
  );

  const role = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [APP_ROLE]
  );

  const row = role.rows[0];
  if (!row) {
    throw new Error(`Papel ${APP_ROLE} nao foi criado`);
  }
  if (row.rolsuper || row.rolbypassrls) {
    await client.query(`ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS`);
    console.log(`[db] papel ${APP_ROLE} rebaixado para nao ignorar RLS`);
  }
};

const applySchema = async (): Promise<void> => {
  const client = new Client({ connectionString: assertMigrationUrlSet() });
  await client.connect();

  try {
    await ensureAppRole(client);
    await client.query(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
    console.log(`[db] schema aplicado; papel da aplicacao: ${APP_ROLE}`);
  } finally {
    await client.end();
  }
};

applySchema()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[db] falha na migration:', error.message);
    process.exit(1);
  });
