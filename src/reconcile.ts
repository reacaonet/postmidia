/**
 * Reconciliacao de `releaseIdMissing` (Fase 9).
 *
 * O Postiz responde sucesso com `releaseId: 'missing'` quando a rede ainda nao
 * devolveu o id. Retry nao serviria -- republicaria o post. O caminho correto e
 * pedir o id depois, e o endpoint publico `GET /posts/:id/missing` faz isso.
 *
 * Enquanto o id nao chega, `external_post_id` guarda o id INTERNO do Postiz, e
 * nao o id da rede. E por ele que a reconciliacao encontra o post. A troca
 * desse campo pelo id verdadeiro e o ponto do exercise.
 *
 * Este endpoint nao gasta o orcamento de 90/h do Postiz: o ThrottlerGuard
 * global so intercepta `POST /public/v1/posts`. O custo aqui e tempo, nao cota
 * -- `getMissingContent` pode renovar token e dormir 10s quando a integracao
 * tem `refreshWait`. Da o `RECONCILE_BATCH` ser pequeno e o intervalo longo.
 */
import { env } from './config';
import { postizGetMissingContent } from './channels/postiz/client';
import { decryptSecret } from './security/secret-box';
import { appendAudit, getAccount, listJobsPendingReconciliation, patchJob } from './store';
import type { PublishJob } from './domain/types';

export type ReconcileOutcome =
  /** O id do provedor chegou e foi gravado. */
  | 'reconciled'
  /** O Postiz ainda nao tem o id; tenta na proxima passada. */
  | 'pending'
  /** O job nao se aplica a reconciliacao. */
  | 'skipped'
  /** Falha ao falar com o Postiz. O job segue publicado e marcado. */
  | 'error';

const MAX_AGE_DAYS = 7;

/**
 * Tenta discovering o id do provedor de um job publicado.
 *
 * Nunca lanca: um job que ja foi publicado com sucesso nao pode virar erro
 * por causa de uma consulta de reconciliacao. O que o chamador precisa saber e
 * o resultado, entao tudo vira `ReconcileOutcome`.
 */
export const reconcileJob = async (job: PublishJob): Promise<ReconcileOutcome> => {
  if (job.status !== 'succeeded' || !job.releaseIdMissing) {
    return 'skipped';
  }

  if (!job.externalPostId) {
    // Sem o id interno do Postiz nao ha como nem perguntar. Registrar e seguir:
    // insistir nao produziria nada.
    console.error(
      `[reconcile] job ${job.id} marcado para reconciliar sem externalPostId; nada a consultar`
    );
    return 'skipped';
  }

  const ageDays = (Date.now() - new Date(job.updatedAt).getTime()) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) {
    // Passa a consultar o Postiz todo dia um job que nunca vai reconciliar e
    // custo sem retorno. O job continua publicado e marcado, entao o operador
    // ainda consegue ver o que houve.
    console.error(
      `[reconcile] job ${job.id} ha ${ageDays.toFixed(0)} dias sem id do provedor; ` +
        'ainda consultando, mas o provedor provavelmente nao devolva'
    );
  }

  const account = await getAccount(job.tenantId, job.channelAccountId);
  if (!account) {
    console.error(`[reconcile] job ${job.id} aponta para conta inexistente; nada a consultar`);
    return 'skipped';
  }

  let found;
  try {
    found = await postizGetMissingContent(decryptSecret(account.encryptedSecret), job.externalPostId);
  } catch (error) {
    // Propositalmente nao marca o job: ele foi publicado. Um 500 do Postiz nao
    // pode transformar sucesso em falha.
    console.error(`[reconcile] falha ao consultar o Postiz para o job ${job.id}:`, error);
    return 'error';
  }

  // Lista vazia cobre tres casos indistinguiveis daqui: o Postiz ja resolveu, a
  // rede nao tem handler de missing, ou o provedor ainda nao processou. Nenhum
  // e erro, e nenhum justifica mexer no job.
  if (found.length === 0) {
    return 'pending';
  }

  const resolved = found[0];
  const updated = await patchJob(job.tenantId, job.id, {
    externalPostId: resolved.id,
    permalink: resolved.url || null,
    releaseIdMissing: false,
    lastError: null,
  });

  if (!updated) {
    console.error(`[reconcile] job ${job.id} sumiu entre a leitura e o patch`);
    return 'error';
  }

  await appendAudit({
    tenantId: job.tenantId,
    actorUserId: null,
    actorEmail: 'reconciler@system',
    action: 'publish.reconciled',
    entityType: 'publish_job',
    entityId: job.id,
    metadata: {
      network: job.network,
      postizPostId: job.externalPostId,
      externalPostId: resolved.id,
      permalink: resolved.url,
    },
  }).catch((auditError: unknown) => {
    // A reconciliacao ja teve efeito no job; perder a auditoria nao desfaz isso.
    console.error(`[reconcile] falha ao auditar publish.reconciled do job ${job.id}:`, auditError);
  });

  console.log(`[reconcile] job ${job.id} reconciliado: ${job.externalPostId} -> ${resolved.id}`);
  return 'reconciled';
};

export type ReconcilePass = {
  scanned: number;
  reconciled: number;
  pending: number;
  skipped: number;
  errored: number;
};

/**
 * Uma passada de reconciliacao sobre os jobs pendentes de todos os tenants.
 *
 * Sequencial de proposito: `getMissingContent` pode bloquear 10s, e o lote e
 * pequeno justamente por isso. Uma concorrencia alta transformaria a passada em
 * muchas requisicoes lentas ao mesmo Postiz.
 */
export const reconcilePending = async (limit: number): Promise<ReconcilePass> => {
  const pass: ReconcilePass = { scanned: 0, reconciled: 0, pending: 0, skipped: 0, errored: 0 };
  const jobs = await listJobsPendingReconciliation(limit);

  for (const job of jobs) {
    pass.scanned += 1;
    const outcome = await reconcileJob(job);
    if (outcome === 'reconciled') {
      pass.reconciled += 1;
    } else if (outcome === 'pending') {
      pass.pending += 1;
    } else if (outcome === 'skipped') {
      pass.skipped += 1;
    } else {
      pass.errored += 1;
    }
  }

  if (pass.reconciled > 0) {
    console.log(
      `[reconcile] passada: ${pass.reconciled} reconciliado(s) de ${pass.scanned} varrido(s)`
    );
  }

  return pass;
};

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Liga a varredura periodica. Só o worker chama, e apenas com
 * `RECONCILE_ENABLED=true`.
 *
 * Duas passadoas nunca se sobrepoem: se uma passada estourar o intervalo, a
 * seguinte e simplesmente pulada. Sem isso, um Postiz lento geraria passadoes
 * empilhadas, cada uma com seu lote, todas cutucando o mesmo endpoint.
 */
export const startReconciler = (): void => {
  if (!env.RECONCILE_ENABLED) {
    console.log('[reconcile] varredura desligada (RECONCILE_ENABLED)');
    return;
  }

  if (timer) {
    return;
  }

  const tick = async (): Promise<void> => {
    if (running) {
      return;
    }
    running = true;
    try {
      await reconcilePending(env.RECONCILE_BATCH);
    } catch (error) {
      // A varredura e acessoria: uma falha dela nao pode derrubar o worker,
      // que e quem consome a fila de publicacao.
      console.error('[reconcile] falha na passada periodica:', error);
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => void tick(), env.RECONCILE_INTERVAL_MS);
  // unref para o timer nao segurar o processo aberto em testes.
  timer.unref?.();

  console.log(
    `[reconcile] varredura a cada ${Math.round(env.RECONCILE_INTERVAL_MS / 1000)}s, ` +
      `ate ${env.RECONCILE_BATCH} job(s) por passada`
  );

  // Uma passada imediata: sem ela, um worker recem-reiniciado levaria um
  // intervalo inteiro sem tocar no backlog -- e reinicio e justamente quando o
  // backlog acumula, se o worker anterior morreu com pendencias.
  void tick();
};

export const stopReconciler = (): void => {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
};
