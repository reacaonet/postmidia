import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config';

/**
 * Autenticacao do painel operacional.
 *
 * **Por que nao reusar `requireTenant`/`requireRole`.** O painel devolve volume
 * por tenant, taxa de falha por rede e pendencias da fila morta da instalacao
 * inteira. O papel `owner` vem do JWT do proprio tenant, e todo tenant tem um:
 * uma rota global protegida por `owner` mostraria a contagem de jobs de todos os
 * clientes para qualquer dono de loja. O RLS nao segura essa rota sozinha,
 * justamente porque a leitura e de sistema.
 *
 * Por isso o gate e um token de plataforma, guardado fora do fluxo de tenants.
 *
 * **Falha fechada.** Sem `METRICS_TOKEN` a rota responde 503, e nao 200 nem
 * "liberado em dev". Um endpoint de observabilidade que abre sozinho quando o
 * segredo nao foi configurado e um endpoint de observabilidade que vaza.
 */
export const requireMetricsToken = (req: Request, res: Response, next: NextFunction): void => {
  const configured = env.METRICS_TOKEN;

  if (!configured) {
    res.status(503).json({
      success: false,
      error: 'Painel operacional desabilitado: METRICS_TOKEN nao configurado',
    });
    return;
  }

  const provided = req.header('x-metrics-token') ?? '';

  // `timingSafeEqual` exige dois buffers do mesmo tamanho; comparar antes
  // transformaria o proprio comprimento em canal lateral.
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  const matches = a.length === b.length && timingSafeEqual(a, b);

  if (!matches) {
    res.status(401).json({ success: false, error: 'x-metrics-token invalido ou ausente' });
    return;
  }

  next();
};
