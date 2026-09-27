import { env, assertProductionSafety } from './config';
import { bootstrapAdapters } from './channels/bootstrap';
import { hasAdapter, resolveAdapter } from './channels/registry';
import { PublishError, type PublishSpec } from './channels/adapter';
import { queue } from './queue';
import { decryptSecret } from './security/secret-box';
import { appendAudit, getAccount, getJob, getPost, patchJob, updateAccountStatus, upsertDeadLetter } from './store';
import { startReconciler, stopReconciler } from './reconcile';
import type { PublishJob, ResolvedChannelAccount } from './domain/types';


const backoffMs = (attempts: number): number =>
  env.PUBLISH_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);

/**
 * Falha terminal do job. `deadLettered` distingue os dois casos que antes
 * caiam no mesmo `fail`: um job que ESGOTOU as tentativas sendo ainda
 * retentavel vai para a fila morta, porque reexecutar pode dar certo; um erro
 * nao retentavel (conteudo invalido, conta removida) nao vai, porque nenhuma
 * reexecucao passaria e a entrada so poluiria a triagem com trabalho doomed.
 */
const fail = async (
  job: PublishJob,
  error: PublishError,
  options: { deadLetter?: boolean } = {}
): Promise<void> => {
  const deadLettered = options.deadLetter === true && error.retryable;

  await patchJob(job.tenantId, job.id, {
    status: 'failed',
    lastError: `${error.code}: ${error.message}`,
  });

  if (deadLettered) {
    // Best-effort, pela mesma razao da auditoria: se a fila morta falhar, o
    // job ja esta marcado como failed e o operador ainda o ve em /jobs.
    await upsertDeadLetter({
      tenantId: job.tenantId,
      jobId: job.id,
      attempts: job.attempts,
      lastError: error.message,
      lastErrorCode: error.code,
    })
      .then((entry) => {
        if (entry) {
          console.error(
            `[worker] job ${job.id} esgotou ${job.attempts} tentativas (${error.code}); na fila morta ${entry.id}`
          );
        }
      })
      .catch((deadLetterError: unknown) => {
        console.error(`[worker] falha ao dead-letterar o job ${job.id}:`, deadLetterError);
      });
  }

  await appendAudit({
    tenantId: job.tenantId,
    actorUserId: null,
    actorEmail: 'worker@system',
    action: deadLettered ? 'publish.dead_lettered' : 'publish.failed',
    entityType: 'publish_job',
    entityId: job.id,
    metadata: {
      network: job.network,
      recipient: job.recipient,
      attempts: job.attempts,
      code: error.code,
      retryable: error.retryable,
      deadLettered,
      error: error.message,
    },
  }).catch((auditError: unknown) => {
    // Auditar e best-effort aqui: perder o registro nao pode impedir o job de
    // ser marcado como falho, senao ele ficaria preso em running para sempre.
    console.error(`[worker] falha ao auditar publish.failed do job ${job.id}:`, auditError);
  });
  console.error(`[worker] job ${job.id} falhou definitivamente - ${error.code}: ${error.message}`);
};


const handleJob = async (job: PublishJob): Promise<void> => {
  const current = await getJob(job.tenantId, job.id);
  if (!current || current.status === 'succeeded' || current.status === 'cancelled') {
    return;
  }

  const attempts = current.attempts + 1;
  await patchJob(job.tenantId, job.id, { status: 'running', attempts });

  const account = await getAccount(job.tenantId, job.channelAccountId);
  if (!account) {
    await fail({ ...current, attempts }, new PublishError('account_not_found', 'Conta removida', false));
    return;
  }

  if (!hasAdapter(job.network)) {
    await fail(
      { ...current, attempts },
      new PublishError('no_adapter', `Sem adapter para ${job.network}`, false)
    );
    return;
  }

  const post = await getPost(job.tenantId, job.postId);
  if (!post) {
    await fail({ ...current, attempts }, new PublishError('post_not_found', 'Post removido', false));
    return;
  }

  const resolvedAccount: ResolvedChannelAccount = {
    ...account,
    secret: decryptSecret(account.encryptedSecret),
  };

  const spec: PublishSpec = {
    text: post.text,
    media: post.media,
    contentType: post.contentType,
    settings: post.settings,
    recipient: current.recipient,
    idempotencyKey: job.id,
  };

  const adapter = resolveAdapter(job.network);

  try {
    const result = await adapter.publish(spec, resolvedAccount);
    await patchJob(job.tenantId, job.id, {
      status: 'succeeded',
      externalPostId: result.externalPostId,
      permalink: result.permalink,
      // O marcador so fica ligado quando o id ainda pode aparecer. No modo
      // UPLOAD do TikTok nunca aparecera, e deixar aceso faria o reconciliador
      // consultar o Postiz para sempre em busca de algo que nao existe.
      releaseIdMissing: result.reconcilable,
      // Mede a latencia de publicacao. `updated_at` nao serve: a reconciliacao
      // patcha o job horas depois e o numero passaria a medir a reconciliacao.
      publishedAt: new Date().toISOString(),
      lastError: result.releaseIdMissing
        ? 'publicado sem id do provedor; reconciliar via releaseIdMissing'
        : null,
    });
    await appendAudit({
      tenantId: job.tenantId,
      actorUserId: null,
      actorEmail: 'worker@system',
      action: 'publish.succeeded',
      entityType: 'publish_job',
      entityId: job.id,
      metadata: {
        network: job.network,
        recipient: current.recipient,
        externalPostId: result.externalPostId,
        permalink: result.permalink,
        releaseIdMissing: result.releaseIdMissing ?? false,
        reconcilable: result.reconcilable ?? false,
        attempts,
      },
    }).catch((auditError: unknown) => {
      console.error(`[worker] falha ao auditar publish.succeeded do job ${job.id}:`, auditError);
    });
    console.log(`[worker] job ${job.id} publicado em ${job.network} -> ${result.externalPostId}`);
  } catch (error) {
    const publishError =
      error instanceof PublishError ? error : new PublishError('unexpected', String(error), false);

    if (publishError.authFailure) {
      await updateAccountStatus(job.tenantId, job.channelAccountId, 'expired');
      await appendAudit({
        tenantId: job.tenantId,
        actorUserId: null,
        actorEmail: 'worker@system',
        action: 'account.credential_rejected',
        entityType: 'channel_account',
        entityId: job.channelAccountId,
        metadata: { network: job.network, jobId: job.id, code: publishError.code },
      }).catch((auditError: unknown) => {
        console.error(`[worker] falha ao auditar credential_rejected:`, auditError);
      });
      console.error(`[worker] credencial de ${job.network} rejeitada; conta marcada como expired`);
    }

    if (publishError.retryable && attempts < env.PUBLISH_MAX_ATTEMPTS) {
      const delay = backoffMs(attempts);
      await patchJob(job.tenantId, job.id, { status: 'queued', lastError: publishError.message });
      await appendAudit({
        tenantId: job.tenantId,
        actorUserId: null,
        actorEmail: 'worker@system',
        action: 'publish.retry_scheduled',
        entityType: 'publish_job',
        entityId: job.id,
        metadata: { network: job.network, attempt: attempts, delayMs: delay, code: publishError.code },
      }).catch((auditError: unknown) => {
        console.error(`[worker] falha ao auditar retry_scheduled do job ${job.id}:`, auditError);
      });
      console.warn(

        `[worker] job ${job.id} falhou (${publishError.code}); reagendando tentativa ${
          attempts + 1
        } em ${Math.round(delay / 1000)}s`
      );
      await queue.enqueue({ ...current, attempts, status: 'queued' }, delay);
      return;
    }

    // Esgotou as tentativas: so vai para a fila morta se o erro ainda for
    // retentavel. A reexecucao manual e o que o operador tera disponivel, e
    // ela so faz sentido para o que ainda pode passar.
    await fail({ ...current, attempts }, publishError, { deadLetter: true });
  }
};

const startWorker = (): void => {
  bootstrapAdapters();
  queue.start(handleJob);
  console.log('[worker] worker de publicacao iniciado');
  // O reconciliador mora no worker porque e ele que tem o segredo da conta e
  // o Postiz ja aberto. So o worker liga a varredura; a API e o frontend nao
  // tem o que reconciliar.
  startReconciler();
};

const shutdown = async (): Promise<void> => {
  stopReconciler();
  await queue.close();
  process.exit(0);
};

if (require.main === module) {
  assertProductionSafety();
  startWorker();
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}


export { handleJob, queue, startWorker };
