import type { ProviderSpec } from '../../store/types';
import type { PostizIntegrationSettings } from './types';

/**
 * Converte o integration-settings do Postiz nos limites que a aplicacao usa.
 *
 * `maxLength` e o unico campo machine-readable e vira a fonte da verdade do
 * limite de texto. `rules` chega como texto descritivo das restricoes da
 * integracao, nao como schema, por isso fica guardado para consulta e auditoria
 * mas nao entra na validacao: parsear prosa quebraria em qualquer reformulacao
 * do provedor. `settings` e o schema dos campos de configuracao, que nao tem
 * papel no limite de conteudo.
 */
export const toProviderSpec = (settings: PostizIntegrationSettings): ProviderSpec => ({
  maxLength:
    typeof settings.maxLength === 'number' &&
    Number.isFinite(settings.maxLength) &&
    settings.maxLength > 0
      ? Math.floor(settings.maxLength)
      : null,
  rules:
    typeof settings.rules === 'string' && settings.rules.trim() !== '' ? settings.rules : null,
});
