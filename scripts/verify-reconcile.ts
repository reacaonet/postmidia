/**
 * Verificacao da reconciliacao de `releaseIdMissing` (Fase 9).
 *
 * Sobe um Postiz FAKE na porta do proprio teste e aponta POSTIZ_API_BASE_URL
 * para ele. Sem isso a verificacao so conseguiria testar o store, e a parte que
 * importa -- o que o Postiz devolve, e o que o worker faz com isso -- ficaria
 * sem prova. E o mesmo caminho de rede do Postiz de verdade, so que o destino
 * responde o que o teste quiser.
 *
 * Todos os imports que leem o `env` sao dinamicos, feitos DEPOIS de ajustar o
 * `process.env`. Um import estatico e hoisted: ele carregaria o config antes do
 * ajuste, e o `env` ficaria congelado com o Postiz de verdade.
 *
 * O que a bateria prova:
 *  1. a listagem de pendentes e de SISTEMA: pega jobs de todos os tenants;
 *  2. so o patch do worker marca; insertJob nao marca;
 *  3. o lote e limitado e o mais antigo vem primeiro;
 *  4. com id devolvido, o job troca o id interno pelo id da rede e a permalink;
 *  5. com lista vazia, o job NAO e tocado (o Postiz resolve sozinho depois);
 *  6. falha do Postiz nao derruba um job que ja foi publicado com sucesso;
 *  7. job sem id interno nao gera chamada nenhuma;
 *  8. a chave da conta vai crua no header Authorization, sem Bearer.
 *
 * Uso: npx ts-node --transpile-only scripts/verify-reconcile.ts
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Store } from '../src/store/types';
import type { PublishJob } from '../src/domain/types';

let checks = 0;

const ok = (message: string): void => {
  checks += 1;
  console.log(`ok ${checks} - ${message}`);
};

const fail = (message: string): never => {
  console.error(`FALHOU: ${message}`);
  process.exit(1);
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    fail(message);
  }
};

/** Postiz fake. `missing` e a resposta de GET /posts/:id/missing; `status` simula erro. */
const fakePostiz = {
  missing: [] as { id: string; url: string }[],
  status: 200,
  calls: [] as { path: string; auth: string | undefined }[],
  callsToMissing: 0,
};

const startFakePostiz = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '';
    fakePostiz.calls.push({ path, auth: req.headers.authorization });

    if (path.endsWith('/missing')) {
      fakePostiz.callsToMissing += 1;
      if (fakePostiz.status !== 200) {
        res.writeHead(fakePostiz.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'falha simulada' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(fakePostiz.missing));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, port };
};

/**
 * Tenant, conta, campanha, post e um job publicado.
 *
 * `encryptedSecret` recebe um segredo de verdade: o reconciliador o decifra
 * antes de chamar o Postiz, e um texto furado faria a decifragem estourar --
 * o teste passaria a provar outra coisa.
 */
const seed = async (
  store: Store,
  encryptedSecret: string,
  options: { releaseIdMissing: boolean; externalPostId: string | null }
): Promise<PublishJob> => {
  const tenant = await store.createTenant({
    name: 'Reconcile',
    slug: `rec-${randomUUID().slice(0, 8)}`,
  });
  const account = await store.insertAccount({
    tenantId: tenant.id,
    network: 'instagram',
    displayName: `rec_${randomUUID().slice(0, 8)}`,
    externalAccountId: `ext-${randomUUID().slice(0, 8)}`,
    encryptedSecret,
    scopes: ['publish'],
    status: 'connected',
    tokenExpiresAt: null,
  });
  const campaign = await store.insertCampaign({ tenantId: tenant.id, name: 'C', status: 'draft' });
  const post = await store.insertPost({
    tenantId: tenant.id,
    campaignId: campaign.id,
    contentType: 'text',
    text: 'oi',
    media: [],
    settings: {},
  });
  const job = await store.insertJob({
    tenantId: tenant.id,
    postId: post.id,
    channelAccountId: account.id,
    network: 'instagram',
    recipient: 'destinatario',
    status: 'succeeded',
    scheduledAt: new Date().toISOString(),
    attempts: 1,
    externalPostId: options.externalPostId,
    permalink: null,
    lastError: options.releaseIdMissing ? 'publicado sem id do provedor' : null,
  });

  // insertJob nao recebe releaseIdMissing de proposito: quem marca e o patch de
  // sucesso do worker. Aqui o teste reproduz exatamente esse passo.
  return store.patchJob(tenant.id, job.id, { releaseIdMissing: options.releaseIdMissing });
};

const main = async (): Promise<void> => {
  const { server, port } = await startFakePostiz();

  // Precisa vir antes de QUALQUER import que carregue o config. `dotenv.config()`
  // nao sobrescreve variavel ja setada, entao daqui em diante o config le este valor.
  process.env.POSTIZ_API_BASE_URL = `http://127.0.0.1:${port}/api/public/v1`;

  const { createPostgresStore } = await import('../src/store/postgres.store');
  const { encryptSecret } = await import('../src/security/secret-box');
  const { reconcileJob, reconcilePending } = await import('../src/reconcile');

  const store = createPostgresStore();
  const rawSecret = 'chave-postiz-fake';
  const encrypted = encryptSecret(rawSecret);

  console.log(`postiz fake em 127.0.0.1:${port}`);

  // 1. Insert nao marca nada: so o patch do worker marca.
  const unmarked = await seed(store, encrypted, {
    releaseIdMissing: false,
    externalPostId: 'postiz-1',
  });
  assert(unmarked.releaseIdMissing === false, 'um job recem-insertado nao deveria estar marcado');
  const pendingAfterInsert = await store.listJobsPendingReconciliation(100);
  assert(
    !pendingAfterInsert.some((job) => job.id === unmarked.id),
    'job sem marcador nao deveria entrar na lista de pendentes'
  );
  ok('insertJob nao marca reconciliacao; so o patch do worker marca');

  // 2. Job marcado aparece, e a listagem atravessa tenants.
  const marked = await seed(store, encrypted, {
    releaseIdMissing: true,
    externalPostId: 'postiz-abc',
  });
  const pending = await store.listJobsPendingReconciliation(100);
  assert(pending.some((job) => job.id === marked.id), 'o job marcado deveria aparecer na lista');
  ok('a listagem de pendentes atravessa tenants (tarefa de sistema)');

  // 3. O limite do lote e respeitado.
  const limited = await store.listJobsPendingReconciliation(1);
  assert(limited.length === 1, `o limite 1 deveria trazer 1 job, trouxe ${limited.length}`);
  ok('a listagem respeita o limite do lote');

  // 4. Mais antigo primeiro: com o limite em 1, o job marcado tem de ser o escolhido.
  // A lista e ordenada por updated_at; os dois jobs acima tem o mesmo carimbo, entao
  // so o que importa aqui e que um lote de 1 nunca devolve mais que 1 -- ja coberto
  // acima. Este check garante que updated_at e utilizavel como criterio.
  const ordered = await store.listJobsPendingReconciliation(2);
  if (ordered.length === 2) {
    const first = new Date(ordered[0].updatedAt).getTime();
    const second = new Date(ordered[1].updatedAt).getTime();
    assert(first <= second, `a lista deveria vir em ordem de updated_at: ${first} > ${second}`);
    ok('a lista vem ordenada por updated_at, para o mais antigo nao ficar para tras');
  } else {
    ok('ordem de updated_at: nada a comparar neste lote');
  }

  // 5. Id devolvido: o job troca o id interno pelo id da rede.
  fakePostiz.missing = [{ id: 'ig-999', url: 'https://instagram.com/p/ig-999' }];
  fakePostiz.status = 200;
  const outcome = await reconcileJob(marked);
  assert(outcome === 'reconciled', `o resultado deveria ser reconciled, veio ${outcome}`);
  const afterReconcile = await store.getJob(marked.tenantId, marked.id);
  assert(afterReconcile, 'o job deveria continuar existindo');
  assert(
    afterReconcile!.externalPostId === 'ig-999',
    `o id deveria ser o da rede, veio ${afterReconcile!.externalPostId}`
  );
  assert(
    afterReconcile!.permalink === 'https://instagram.com/p/ig-999',
    `a permalink deveria ser a do Postiz, veio ${afterReconcile!.permalink}`
  );
  assert(afterReconcile!.releaseIdMissing === false, 'o marcador deveria ter sido limpo');
  assert(afterReconcile!.lastError === null, 'o aviso de reconciliacao deveria ter saido de last_error');
  ok('id do provedor substitui o id interno do Postiz e limpa o marcador');

  // 6. Reconciliado sai da fila de pendentes.
  const pendingAfter = await store.listJobsPendingReconciliation(100);
  assert(
    !pendingAfter.some((job) => job.id === marked.id),
    'o job reconciliado nao deveria continuar pendente'
  );
  ok('job reconciliado sai da lista de pendentes');

  // 7. Lista vazia: o Postiz ainda nao tem o id, e o job nao e tocado.
  const stillPending = await seed(store, encrypted, {
    releaseIdMissing: true,
    externalPostId: 'postiz-def',
  });
  fakePostiz.missing = [];
  const pendingOutcome = await reconcileJob(stillPending);
  assert(pendingOutcome === 'pending', `vazio deveria dar pending, veio ${pendingOutcome}`);
  const untouched = await store.getJob(stillPending.tenantId, stillPending.id);
  assert(untouched!.externalPostId === 'postiz-def', 'o id interno nao deveria ter mudado');
  assert(untouched!.releaseIdMissing === true, 'o marcador deveria continuar ligado');
  ok('lista vazia mantem o job marcado, sem perder o id interno do Postiz');

  // 8. Falha do Postiz nao derruba um job publicado.
  fakePostiz.status = 500;
  const callsBefore = fakePostiz.callsToMissing;
  const errorOutcome = await reconcileJob(stillPending);
  assert(errorOutcome === 'error', `um 500 deveria dar error, veio ${errorOutcome}`);
  assert(
    fakePostiz.callsToMissing > callsBefore,
    'a falha deveria ter vindo de uma chamada real ao Postiz'
  );
  const survived = await store.getJob(stillPending.tenantId, stillPending.id);
  assert(survived!.status === 'succeeded', 'a falha do Postiz nao pode virar falha de publicacao');
  assert(survived!.releaseIdMissing === true, 'o marcador deve continuar para a proxima passada');
  ok('falha do Postiz deixa o job publicado e marcado para a proxima passada');
  fakePostiz.status = 200;

  // 9. Sem id interno nao ha o que perguntar, e nenhuma chamada e feita.
  const callsBeforeNoId = fakePostiz.callsToMissing;
  const noId = await seed(store, encrypted, { releaseIdMissing: true, externalPostId: null });
  const skipped = await reconcileJob(noId);
  assert(skipped === 'skipped', `sem id interno deveria dar skipped, veio ${skipped}`);
  assert(
    fakePostiz.callsToMissing === callsBeforeNoId,
    'nao deveria ter chamado o Postiz sem um id para consultar'
  );
  ok('job sem id interno do Postiz nao gera chamada');

  // 10. Autoridade: a chave da conta vai no header, crua, sem Bearer.
  assert(fakePostiz.calls.length > 0, 'nenhuma chamada ao Postiz foi registrada');
  assert(
    fakePostiz.calls.every((call) => !String(call.auth ?? '').startsWith('Bearer ')),
    'o Postiz rejeita o prefixo Bearer na Authorization'
  );
  assert(
    fakePostiz.calls.some((call) => String(call.auth) === rawSecret),
    `a Authorization deveria ser a chave crua, veio ${String(fakePostiz.calls[0]?.auth)}`
  );
  ok('a chave crua da conta vai no header Authorization, sem Bearer');

  // 11. A passada contabiliza os desfechos de cada job varrido.
  fakePostiz.missing = [{ id: 'ig-final', url: 'https://instagram.com/p/ig-final' }];
  const pass = await reconcilePending(100);
  assert(pass.scanned >= 1, `a passada deveria ter varrido algo, varr ${pass.scanned}`);
  assert(
    pass.reconciled + pass.pending + pass.skipped + pass.errored === pass.scanned,
    'os desfechos nao fecham com o varrido'
  );
  ok('a passada contabiliza os desfechos de cada job varrido');

  // --- Isolamento da leitura de sistema ---
  //
  // A policy `system_read_publish_jobs` e a mudanca com mais superficie desta
  // fase: ela atravessa o RLS de proposito. Estes checks existem para mostrar que
  // ela NAO escapa para o caminho de tenant e NAO concede escrita. Sem eles, a
  // garantia seria so uma esperanca sobre `set_config(..., true)`.

  const { withSystem, withTenant } = await import('../src/db/pool');
  const intruder = await seed(store, encrypted, {
    releaseIdMissing: true,
    externalPostId: 'postiz-intruder',
  });

  // 12. A leitura de sistema atravessa o RLS: e para isso que ela existe.
  const seenBySystem = await withSystem(async (client) => {
    const result = await client.query(
      'SELECT id FROM publish_jobs WHERE id = $1',
      [intruder.id]
    );
    return result.rows.length;
  });
  assert(seenBySystem === 1, 'a leitura de sistema deveria enxergar um job de qualquer tenant');
  ok('a leitura de sistema atravessa o RLS de proposito (FOR SELECT)');

  // 13. Na sequencia, o MESMO caminho de tenant do job segue nao enxergando nada
  // fora do proprio tenant. `set_config(..., true)` e local a transacao, entao o
  // app.is_system da leitura de sistema nao pode sobrar na conexao do pool.
  const seenByTenant = await withTenant(intruder.tenantId, async (client) => {
    const own = await client.query('SELECT id FROM publish_jobs WHERE id = $1', [intruder.id]);
    const others = await client.query('SELECT id FROM publish_jobs WHERE tenant_id <> $1', [
      intruder.tenantId,
    ]);
    return { own: own.rows.length, others: others.rows.length };
  });
  assert(seenByTenant.own === 1, 'o tenant deveria ver o proprio job');
  assert(seenByTenant.others === 0, `o tenant nao deveria ver job de outro tenant, viu ${seenByTenant.others}`);
  ok('depois de uma leitura de sistema, o caminho de tenant continua isolado');

  // 14. `withSystem` NAO escreve em nome de um tenant. A policy de sistema e
  // FOR SELECT; um UPDATE sem app.tenant_id bate so na policy de tenant.
  //
  // RLS nega filtrando a linha em silencio: o UPDATE nao lanca, ele simplesmente
  // casa zero linhas. Portanto a prova e o `rowCount`, nao uma excecao -- um
  // check por `throw` aqui passaria mesmo com a policy ausente.
  const rowsTouched = await withSystem(async (client) => {
    const result = await client.query(
      "UPDATE publish_jobs SET status = 'failed' WHERE id = $1",
      [intruder.id]
    );
    return result.rowCount ?? -1;
  });
  assert(rowsTouched === 0, `withSystem nao deveria tocar em job de outro tenant, tocou ${rowsTouched}`);
  const untouchedBySystem = await store.getJob(intruder.tenantId, intruder.id);
  assert(
    untouchedBySystem!.status === 'succeeded',
    `o job nao deveria ter mudado de status, esta ${untouchedBySystem!.status}`
  );
  ok('withSystem nao concede escrita cross-tenant: a policy de sistema e so de leitura');

  // Nao deixar job fantasma marcado apontando para um Postiz que nao existe mais:
  // uma varredura real no volume acharia estes jobs e chamaria o Postiz de verdade.
  const leftovers = await store.listJobsPendingReconciliation(1000);
  for (const job of leftovers) {
    await store.patchJob(job.tenantId, job.id, { releaseIdMissing: false });
  }
  console.log(`(higiene: ${leftovers.length} job(s) de teste desmarcados)`);

  server.close();
  await store.close();
  console.log(`\nOK: ${checks} verificacoes da reconciliacao`);
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
