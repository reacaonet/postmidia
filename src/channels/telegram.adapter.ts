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

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
}

const TELEGRAM_API = 'https://api.telegram.org';

const telegramPermalink = (chatId: number, messageId: number): string | null => {
  const asString = String(chatId);
  return asString.startsWith('-100') ? `https://t.me/c/${asString.slice(4)}/${messageId}` : null;
};

const callTelegram = async <T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<T> => {
  let data: TelegramResponse<T> | undefined;

  try {
    const response = await axios.post<TelegramResponse<T>>(
      `${TELEGRAM_API}/bot${botToken}/${method}`,
      body
    );
    data = response.data;
  } catch (error) {
    if (!axios.isAxiosError(error)) {
      throw error;
    }
    const httpStatus = error.response?.status ?? 0;
    data = error.response?.data as TelegramResponse<T> | undefined;
    if (data?.ok === false) {
      const errorCode = data.error_code ?? httpStatus;
      throw new PublishError(
        `telegram_${errorCode}`,
        data.description ?? error.message,
        errorCode === 429 || isRetryableStatus(httpStatus),
        errorCode
      );
    }
    throw new PublishError('telegram_request_failed', error.message, isRetryableStatus(httpStatus), httpStatus);
  }

  if (!data.ok || data.result === undefined) {
    const errorCode = data.error_code ?? 0;
    throw new PublishError(
      `telegram_${errorCode || 'unknown'}`,
      data.description ?? `Telegram recusou ${method}`,
      errorCode === 429
    );
  }

  return data.result;
};

export const createTelegramAdapter = (): ChannelAdapter => ({
  network: 'telegram',
  capabilities: {
    nativeScheduling: false,
    twoStepPublish: false,
    metrics: false,
    commentReply: false,
  },

  async validate(spec: PublishSpec, account: ResolvedChannelAccount): Promise<ValidationIssue[]> {
    return validateAgainstNetworkSpec('telegram', spec, account);
  },

  async publish(spec: PublishSpec, account: ResolvedChannelAccount): Promise<PublishResult> {
    assertPublishable('telegram', spec, account);

    if (!account.secret) {
      throw new PublishError('telegram_not_configured', 'Conta sem bot token', false);
    }

    const chatId = account.externalAccountId;
    const caption = spec.text.slice(0, 1024);
    const images = spec.media.filter((item) => item.kind === 'image');
    const videos = spec.media.filter((item) => item.kind === 'video');

    let message: TelegramMessage;

    if (images.length > 1) {
      const media = images.slice(0, 10).map((image, index) => ({
        type: 'photo',
        media: image.url,
        ...(index === 0 && caption ? { caption } : {}),
      }));
      const album = await callTelegram<TelegramMessage[]>(account.secret, 'sendMediaGroup', {
        chat_id: chatId,
        media,
      });
      message = album[album.length - 1];
    } else if (videos.length > 0) {
      message = await callTelegram<TelegramMessage>(account.secret, 'sendVideo', {
        chat_id: chatId,
        video: videos[0].url,
        ...(caption ? { caption } : {}),
      });
    } else if (images.length === 1) {
      message = await callTelegram<TelegramMessage>(account.secret, 'sendPhoto', {
        chat_id: chatId,
        photo: images[0].url,
        ...(caption ? { caption } : {}),
      });
    } else {
      message = await callTelegram<TelegramMessage>(account.secret, 'sendMessage', {
        chat_id: chatId,
        text: spec.text,
      });
    }

    return {
      externalPostId: String(message.message_id),
      permalink: telegramPermalink(message.chat.id, message.message_id),
      releaseIdMissing: false,
    reconcilable: false,
      raw: message,
    };
  },
});
