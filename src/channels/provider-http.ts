import axios, { type AxiosInstance } from 'axios';

/**
 * Cliente HTTP para chamadas de provider feitas pelo worker.
 *
 * **Por que um modulo so.** O client do Postiz ja tinha `timeout: 60_000`, e os
 * adapters de WhatsApp e Telegram faziam `axios.post` sem timeout nenhum. Nao e
 * um detalhe: um Graph API travado segurava o job do BullMQ em `running` para
 * sempre, sem backoff e sem DLQ, porque a promessa nunca resolvia. O worker
 * inteiro para de drainar enquanto um provider nao responde.
 *
 * `PROVIDER_TIMEOUT_MS` deixa esse limite ajustavel por ambiente: o default e
 * generoso de proposito (publicar leva tempo), mas o importante e que ele EXISTA.
 */
export const PROVIDER_TIMEOUT_MS = 60_000;

/**
 * Instancia compartilhada. axios reaproveita keep-alive por agente, e um
 * `axios.create` por chamada perderia a conexao reaproveitada a cada publicacao.
 */
export const providerHttp: AxiosInstance = axios.create({
  timeout: PROVIDER_TIMEOUT_MS,
});
