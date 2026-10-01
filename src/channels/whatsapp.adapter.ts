import axios from 'axios';
import { providerHttp } from './provider-http';
import { env } from '../config';
import type { ResolvedChannelAccount } from '../domain/types';
import {
  assertPublishable,
  isRetryableStatus,
  PublishError,
  validateAgainstNetworkSpec,
  type ChannelAdapter,
  type PublishResult,
  type PublishSpec,
  type ValidationIssue,
} from './adapter';
import { buildWhatsappRequest } from './whatsapp/request';

interface WhatsappSendResponse {
  messaging_product?: string;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string; message_status?: string }[];
  error?: { code: number; title: string; message?: string };
}

/**
 * URL de envio da Cloud API.
 *
 * `externalAccountId` e o phone-number id e vem do cadastro da conta, entao e
 * dado de entrada: sem `encodeURIComponent` um id contendo `/` ou `..`
 * reescreveria o caminho e trocaria o `messages` por outro endpoint da Graph API.
 */
export const buildWhatsappMessagesUrl = (
  externalAccountId: string,
  graphVersion: string = env.WHATSAPP_GRAPH_VERSION
): string =>
  `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(externalAccountId)}/messages`;

export const createWhatsappAdapter = (): ChannelAdapter => ({
  network: 'whatsapp',
  capabilities: {
    nativeScheduling: false,
    twoStepPublish: false,
    metrics: false,
    commentReply: false,
  },

  async validate(spec: PublishSpec, account: ResolvedChannelAccount): Promise<ValidationIssue[]> {
    const issues = validateAgainstNetworkSpec('whatsapp', spec, account);

    if (!spec.recipient) {
      issues.push({
        field: 'account',
        code: 'whatsapp_recipient_required',
        message: 'WhatsApp exige destinatario; informe audience na criacao do post',
      });
    }

    // A Cloud API envia UMA mensagem com no maximo uma midia, e o request usa
    // `spec.media[0]`. A spec da rede diz `maxImages: 1, maxVideos: 1`, o que
    // permitia um post com uma imagem E um video -- e o video sumiria em
    // silencio, sem erro e sem aviso. O limite real e uma midia no total.
    if (spec.media.length > 1) {
      issues.push({
        field: 'media',
        code: 'whatsapp_single_media_only',
        message:
          `WhatsApp envia uma midia por mensagem; o post tem ${spec.media.length} ` +
          `e apenas a primeira seria publicada. Divida em posts separados.`,
      });
    }

    if (!spec.recipient && issues.length === 1) {
      return issues;
    }

    const { issues: requestIssues } = await buildWhatsappRequest(
      account.tenantId,
      spec.recipient ?? '',
      spec.text,
      spec.media[0]?.url ?? null,
      spec.settings
    );

    for (const message of requestIssues) {
      issues.push({ field: 'account', code: 'whatsapp_request_invalid', message });
    }

    return issues;
  },

  async publish(spec: PublishSpec, account: ResolvedChannelAccount): Promise<PublishResult> {
    assertPublishable('whatsapp', spec, account);

    if (!spec.recipient) {
      throw new PublishError('whatsapp_recipient_required', 'Sem destinatario', false);
    }

    const { request, issues } = await buildWhatsappRequest(
      account.tenantId,
      spec.recipient,
      spec.text,
      spec.media[0]?.url ?? null,
      spec.settings
    );

    if (issues.length > 0) {
      throw new PublishError('whatsapp_request_invalid', issues.join('; '), false);
    }

    const url = buildWhatsappMessagesUrl(account.externalAccountId);

  try {
    const response = await providerHttp.post<WhatsappSendResponse>(url, request, {
      headers: {
        Authorization: `Bearer ${account.secret}`,
        'Content-Type': 'application/json',
      },
    });

      const messageId = response.data.messages?.[0]?.id;
      if (!messageId) {
        throw new PublishError(
          'whatsapp_unexpected_response',
          `Resposta da Cloud API sem message id: ${JSON.stringify(response.data)}`,
          false
        );
      }

      return {
        externalPostId: messageId,
        permalink: null,
        releaseIdMissing: false,
    reconcilable: false,
        raw: response.data,
      };
    } catch (error) {
      if (error instanceof PublishError) {
        throw error;
      }
      if (axios.isAxiosError(error)) {
        const status = error.response?.status ?? 0;
        const apiError = (error.response?.data as WhatsappSendResponse | undefined)?.error;
        const authFailure = status === 401 || status === 403 || apiError?.code === 190;
        return Promise.reject(
          new PublishError(
            `whatsapp_${apiError?.code ?? (status || 'network')}`,
            apiError?.message ?? error.message,
            isRetryableStatus(status),
            status,
            authFailure
          )
        );
      }
      throw new PublishError('whatsapp_unexpected', String(error), false);
    }
  },
});
