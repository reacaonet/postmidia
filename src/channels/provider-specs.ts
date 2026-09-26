import type { ChannelAccount } from '../domain/types';
import { decryptSecret } from '../security/secret-box';
import { getAccount, updateAccountProviderSpec } from '../store';
import { isProviderSpecApplicable } from '../domain/networks';
import { postizIntegrationSettings } from './postiz/client';
import { toProviderSpec } from './postiz/spec-rules';

export { isProviderSpecApplicable, toProviderSpec };

export type ProviderSpecSyncResult = {
  account: ChannelAccount;
  /** false quando a rede nao tem provedor autoritativo (Telegram, WhatsApp). */
  applicable: boolean;
  /** false quando a consulta ao provedor falhou e o cache foi preservado. */
  synced: boolean;
  error?: string;
};

/**
 * Busca os limites no provedor e cacheia na conta.
 *
 * Nunca lanca: se o Postiz estiver fora do ar, o erro volta no resultado e a
 * conta segue valendo o fallback do NETWORK_SPECS. Falhar o onboarding por
 * causa de dependencia opcional seria pior do que publicar com limite antigo.
 */
export const syncAccountProviderSpec = async (
  tenantId: string,
  accountId: string
): Promise<ProviderSpecSyncResult> => {
  const account = await getAccount(tenantId, accountId);
  if (!account) {
    throw Object.assign(new Error('Conta nao encontrada'), { statusCode: 404 });
  }

  if (!isProviderSpecApplicable(account.network)) {
    return { account, applicable: false, synced: false };
  }

  try {
    const { output } = await postizIntegrationSettings(
      decryptSecret(account.encryptedSecret),
      account.externalAccountId
    );
    const updated = await updateAccountProviderSpec(tenantId, accountId, toProviderSpec(output));
    if (!updated) {
      throw new Error('Conta nao encontrada');
    }
    return { account: updated, applicable: true, synced: true };
  } catch (error) {
    return {
      account,
      applicable: true,
      synced: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
