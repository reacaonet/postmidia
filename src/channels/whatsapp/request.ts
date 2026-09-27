import type { WhatsappTemplate } from '../../domain/types';
import { findTemplate } from '../../store';

export interface WhatsappSendRequest {
  messaging_product: 'whatsapp';
  to: string;
  type: 'template' | 'text' | 'image' | 'video' | 'document';
  template?: {
    name: string;
    language: { code: string };
    components: unknown[];
  };
  text?: { body: string; preview_url: boolean };
  image?: { link: string; caption?: string };
  video?: { link: string; caption?: string };
  document?: { link: string; caption?: string; filename?: string };
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const textParameter = (value: unknown) => ({ type: 'text', text: asString(value) ?? String(value ?? '') });

const buildTemplateRequest = async (
  tenantId: string,
  recipient: string,
  settings: Record<string, unknown>,
  mediaLink: string | null,
  caption: string
): Promise<{ request: WhatsappSendRequest; issues: string[] }> => {
  const issues: string[] = [];
  const name = asString(settings.templateName);

  if (!name) {
    issues.push('settings.templateName e obrigatorio para publicar template aprovado');
    return { request: { messaging_product: 'whatsapp', to: recipient, type: 'template' }, issues };
  }

  const languageCode = asString(settings.languageCode) ?? 'pt_BR';
  const template: WhatsappTemplate | undefined = await findTemplate(tenantId, name, languageCode);

  if (!template) {
    issues.push(`template "${name}" (${languageCode}) nao existe para este tenant`);
  } else if (template.status !== 'APPROVED') {
    // Este e o criterio de aceite da Fase 6: a mensagem tem que apontar a
    // sincronizacao, nao apenas dizer que o status esta errado. Dizer "so
    // APPROVED publica" deixa o operador sem proximo passo; a rejeicao da Meta
    // tem que vir com o motivo, porque "REJECTED" sem motivo e um beco sem
    // saida para quem esta olhando.
    const detail =
      template.status === 'REJECTED'
        ? 'a Meta reprovou este template; o motivo so aparece na leitura de message_templates da WABA'
        : 'a Meta ainda nao processou este template';
    issues.push(
      `template "${name}" (${languageCode}) esta ${template.status}: ${detail}. ` +
        'Aprovacao e do provedor, nao do postmidia -- o status muda quando o provedor responder, ' +
        'nao por PATCH. Sincronize com GET /whatsapp/templates/sync.'
    );
  }

  const variables = Array.isArray(settings.bodyParams) ? settings.bodyParams : [];
  if (template && variables.length !== template.variableCount) {
    issues.push(
      `template "${name}" espera ${template.variableCount} variaveis, recebido ${variables.length}`
    );
  }

  const components: unknown[] = [];

  if (mediaLink && template?.headerType && template.headerType !== 'NONE') {
    if (template.headerType === 'IMAGE') {
      components.push({ type: 'header', parameters: [{ type: 'image', image: { link: mediaLink } }] });
    } else if (template.headerType === 'VIDEO') {
      components.push({ type: 'header', parameters: [{ type: 'video', video: { link: mediaLink } }] });
    } else if (template.headerType === 'DOCUMENT') {
      components.push({ type: 'header', parameters: [{ type: 'document', document: { link: mediaLink } }] });
    }
  }

  if (variables.length > 0) {
    components.push({ type: 'body', parameters: variables.map(textParameter) });
  }

  if (caption) {
    components.push({ type: 'button', sub_type: 'quick_reply', index: 0, parameters: [{ type: 'payload', payload: caption }] });
  }

  return {
    request: {
      messaging_product: 'whatsapp',
      to: recipient,
      type: 'template',
      template: { name, language: { code: languageCode }, components },
    },
    issues,
  };
};

export const buildWhatsappRequest = async (
  tenantId: string,
  recipient: string,
  text: string,
  mediaUrl: string | null,
  settings: Record<string, unknown>
): Promise<{ request: WhatsappSendRequest; issues: string[] }> => {
  const mode = asString(settings.mode) ?? 'template';

  if (mode === 'text') {
    return {
      request: {
        messaging_product: 'whatsapp',
        to: recipient,
        type: 'text',
        text: { body: text, preview_url: asString(settings.previewUrl) === 'true' },
      },
      issues: [],
    };
  }

  return await buildTemplateRequest(tenantId, recipient, settings, mediaUrl, text);
};
