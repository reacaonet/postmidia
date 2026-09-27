import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config';
import { readAllPostizQuota, type PostizQuotaUsage, type QuotaState } from '../channels/postiz/quota';
import { requireMetricsToken } from '../http/metrics-auth';
import { asyncHandler } from '../http/async-handler';
import { getOpsMetrics, getTenantOpsMetrics } from '../store';

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pior estado de cota do Postiz na instalacao.
 *
 * O alerta de quota e este campo. Sem ele, o operador precisaria somar o consumo
 * das duas classes na mao para saber se algo esta perto do limite -- que e
 * precisamente o que ninguem faz.
 */
const worstQuota = (quotas: PostizQuotaUsage[]): QuotaState => {
  if (quotas.some((quota) => quota.state === 'exhausted')) {
    return 'exhausted';
  }
  return quotas.some((quota) => quota.state === 'warning') ? 'warning' : 'ok';
};

/**
 * Mais rigido que `requireTenant`, de proposito: ver o painel exige o token de
 * plataforma. O comentario do motivo esta em `http/metrics-auth.ts`.
 *
 * Com `?tenantId=`, a leitura passa a ser por tenant (`withTenant`, RLS comum)
 * em vez de leitura de sistema. O operador usa o drilldown para investigar um
 * cliente, e o caminho mais estreito continua sendo o maisestreito.
 *
 * Nao ha agregado "todos os tenants lado a lado" de proposito: uma lista
 * ordenada de volume por cliente e ela mesma um vazamento entre tenants, e o
 * RLS nao protege o painel por ser leitura de sistema. O operador escolhe o
 * tenant que quer ver, em vez de receber o portfolio inteiro de graca.
 */
router.get(
  '/ops/metrics',
  requireMetricsToken,
  asyncHandler(async (req, res) => {
    const windowHours = z.coerce
      .number()
      .int()
      .min(1)
      .max(720)
      .catch(env.METRICS_WINDOW_HOURS)
      .parse(req.query.windowHours ?? undefined);

    const tenantId = req.query.tenantId;
    if (tenantId !== undefined && (typeof tenantId !== 'string' || !UUID.test(tenantId))) {
      res.status(400).json({ success: false, error: 'tenantId invalido' });
      return;
    }

    const [metrics, quota] = await Promise.all([
      tenantId
        ? getTenantOpsMetrics(tenantId, windowHours)
        : getOpsMetrics(windowHours),
      readAllPostizQuota(),
    ]);

    const quotaState = worstQuota(quota);

    res.json({
      success: true,
      data: {
        ...metrics,
        postizQuota: quota,
        // Repetido no topo para o alerta nao precisar saber onde olhar. O
        // operador cola isso no monitor e nao precisa parsear o resto.
        alerts: {
          postizQuota: quotaState,
          // `exhausted` e o estado que dói: o Postiz comeca a devolver 429 e as
          // publicacoes passam a falhar por cota, nao por conteudo.
          blocking: quotaState === 'exhausted',
        },
      },
    });
  })
);

export default router;
