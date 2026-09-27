import axios from 'axios';
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

const GRAPH_VERSION = 'v21.0';

interface WhatsappSendResponse {
  messaging_product?: string;
  contacts?: { input: string; wa_id: string }[];
  messages?: { id: string; message_status?: string }[];
  error?: { code: number; title: string; message?: string };
}

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

    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(account.externalAccountId)}/messages`;

    try {
      const response = await axios.post<WhatsappSendResponse>(url, request, {
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
