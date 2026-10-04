import { Router } from 'express';
import { ZodError } from 'zod';
import { NETWORK_SPECS } from '../domain/networks';
import { describeCapabilities, listRegisteredNetworks } from '../channels/registry';
import { POSTIZ_BRIDGED_NETWORKS } from '../channels/bootstrap';
import { rateLimitByIp } from '../http/rate-limit';
import accountRoutes from './accounts';
import authRoutes from './auth';
import campaignRoutes from './campaigns';
import deadLetterRoutes from './dead-letters';
import oauthRoutes from './oauth';
import opsRoutes from './ops';
import whatsappRoutes from './whatsapp';

const router = Router();

router.get('/health', (_req, res) =>
  res.status(200).json({
    status: 'ok',
    service: 'postmidia',
    timestamp: new Date().toISOString(),
  })
);

router.get('/networks', (_req, res) =>
  res.json({
    success: true,
    data: {
      registered: listRegisteredNetworks(),
      bridgedViaPostiz: POSTIZ_BRIDGED_NETWORKS,
      specs: NETWORK_SPECS,
    },
  })
);

router.get('/capabilities', (_req, res) => res.json({ success: true, data: describeCapabilities() }));

// Endpoints publicos e caros de abusar: limite apertado por IP.
router.use('/auth', (req, res, next) => {
  void rateLimitByIp(req.ip ?? 'desconhecido', 20, 60_000).then((result) => {
    res.setHeader('X-RateLimit-Limit', String(result.limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({ success: false, error: 'Muitas tentativas; tente novamente em instantes' });
      return;
    }
    next();
  });
});

router.use(authRoutes);
router.use(oauthRoutes);
router.use(accountRoutes);
router.use(campaignRoutes);
router.use(whatsappRoutes);
router.use(deadLetterRoutes);
router.use(opsRoutes);

router.use((error: unknown, _req: unknown, res: any, _next: unknown) => {
  if (error instanceof ZodError) {
    res.status(400).json({ success: false, error: 'Payload invalido', data: error.flatten() });
    return;
  }

  // `status` e `statusCode` sao aceitos porque os dois nomes ja circulam no
  // codigo (o handler usava so `status`, e `provider-specs` lanca com
  // `statusCode`): ler so um deles fazia um 404 virar 400 na resposta. O `hint`
  // viaja quando presente porque e a parte que diz ao operador o QUE fazer --
  // sem ele, "chat not found" fica sem a instrucao de adicionar o bot como
  // administrador, que e o que efetivamente resolve.
  const thrown = error as { status?: number; statusCode?: number; message?: string; hint?: string };
  const status = thrown?.status ?? thrown?.statusCode ?? 400;

  res.status(status).json({
    success: false,
    error: thrown?.message ?? 'Erro interno',
    ...(thrown?.hint ? { hint: thrown.hint } : {}),
  });
});

export default router;
