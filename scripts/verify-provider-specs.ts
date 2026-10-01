/**
 * Verificacao da Fase 7: limites autoritativos do provedor.
 *
 * Nao ha framework de teste no projeto, entao isto e um script executavel com
 * node:assert, no mesmo estilo do verify-queue. Roda com:
 *   npx ts-node --transpile-only scripts/verify-provider-specs.ts
 */
import assert from 'node:assert/strict';

import { NETWORK_SPECS } from '../src/domain/networks';
import { validateAgainstNetworkSpec } from '../src/channels/adapter';
import { toProviderSpec } from '../src/channels/postiz/spec-rules';
import { isProviderSpecApplicable } from '../src/domain/networks';
import { buildWhatsappMessagesUrl } from '../src/channels/whatsapp.adapter';
import { env, WHATSAPP_GRAPH_VERSION_SCHEMA } from '../src/config';
import type { ChannelAccount, PublishSpec, ResolvedChannelAccount } from '../src/domain/types';
import type { PostizIntegrationSettings } from '../src/channels/postiz/types';

let passed = 0;
const check = (name: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
};

const accountFor = (
  network: ChannelAccount['network'],
  providerMaxLength: number | null
): ResolvedChannelAccount => ({
  id: 'acc-1',
  tenantId: 'ten-1',
  network,
  externalAccountId: 'ext-1',
  displayName: 'Conta de teste',
  secret: 'irrelevant',
  scopes: [],
  status: 'active',
  tokenExpiresAt: null,
  providerMaxLength,
  providerRules: null,
  specsSyncedAt: providerMaxLength === null ? null : new Date().toISOString(),
  createdAt: new Date().toISOString(),
});

const specWithText = (length: number, network: ChannelAccount['network'] = 'instagram'): PublishSpec => {
  const contentType = NETWORK_SPECS[network].contentTypes[0].id;
  return { text: 'a'.repeat(length), media: [], contentType, settings: {}, recipient: null };
};

const textTooLong = (network: ChannelAccount['network'], length: number) =>
  validateAgainstNetworkSpec(network, specWithText(length, network), accountFor(network, null)).find(
    (issue) => issue.code === 'text_too_long'
  );

// ---------------------------------------------------------------- toProviderSpec

check('maxLength numerico do provedor vira a fonte da verdade', () => {
  const spec = toProviderSpec({ maxLength: 500, rules: 'ate 500', settings: {}, tools: [] } as PostizIntegrationSettings);
  assert.equal(spec.maxLength, 500);
  assert.equal(spec.rules, 'ate 500');
});

check('maxLength ausente ou invalido vira null (fallback), nao 0', () => {
  // Number(null) seria 0, o que reprovaria todo post com texto nao vazio.
  assert.equal(toProviderSpec({} as PostizIntegrationSettings).maxLength, null);
  assert.equal(toProviderSpec({ maxLength: 0 } as PostizIntegrationSettings).maxLength, null);
  assert.equal(toProviderSpec({ maxLength: -5 } as PostizIntegrationSettings).maxLength, null);
  assert.equal(toProviderSpec({ maxLength: 'muitos' } as unknown as PostizIntegrationSettings).maxLength, null);
  assert.equal(toProviderSpec({ maxLength: Number.NaN } as PostizIntegrationSettings).maxLength, null);
});

check('maxLength fracionario e truncado para inteiro', () => {
  assert.equal(toProviderSpec({ maxLength: 2200.7 } as PostizIntegrationSettings).maxLength, 2200);
});

check('rules em branco vira null', () => {
  assert.equal(toProviderSpec({ maxLength: 100, rules: '   ' } as PostizIntegrationSettings).rules, null);
  assert.equal(toProviderSpec({ maxLength: 100 } as PostizIntegrationSettings).rules, null);
});

// ------------------------------------------------------------- aplicabilidade por rede

check('só redes bridged pelo Postiz tem provedor de specs', () => {
  for (const network of ['instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'x'] as const) {
    assert.equal(isProviderSpecApplicable(network), true, network);
  }
  // Nativas: nao ha endpoint de specs, e tentar daria 404 sempre.
  assert.equal(isProviderSpecApplicable('telegram'), false);
  assert.equal(isProviderSpecApplicable('whatsapp'), false);
});

// ------------------------------------------------------ validacao autoritativa

check('conta sem sync usa o NETWORK_SPECS', () => {
  const fallback = NETWORK_SPECS.instagram.text.maxChars;
  assert.equal(textTooLong('instagram', fallback + 1) !== undefined, true);
  assert.equal(textTooLong('instagram', fallback) === undefined, true);
});

check('conta sincronizada usa o limite do provedor, mesmo maior que o fallback', () => {
  const fallback = NETWORK_SPECS.instagram.text.maxChars;
  const generous = fallback + 5000;
  const account = accountFor('instagram', generous);
  const issues = validateAgainstNetworkSpec(
    'instagram',
    specWithText(generous + 1),
    account
  );
  assert.equal(issues.find((issue) => issue.code === 'text_too_long') !== undefined, true);
  // Mesma conta, texto que o NETWORK_SPECS reprovaria mas o provedor aceita.
  assert.equal(
    validateAgainstNetworkSpec('instagram', specWithText(fallback + 1), account).find(
      (issue) => issue.code === 'text_too_long'
    ),
    undefined
  );
});

check('provedor mais rigoroso que o fallback reprova antes da constante local', () => {
  // O ponto critico: se a rede encurtou o limite, a constante local nao pode
  // continuar autorizando o post.
  const strict = 100;
  assert.ok(NETWORK_SPECS.instagram.text.maxChars > strict, 'premissa do teste');
  const account = accountFor('instagram', strict);
  const issue = validateAgainstNetworkSpec('instagram', specWithText(strict + 1), account).find(
    (candidate) => candidate.code === 'text_too_long'
  );
  assert.ok(issue, 'provedor mais rigoroso deveria reprovar');
  assert.match(issue!.message, /limite do provedor/);
  // E a divergencia fica visivel, em vez de silenciosamente aceita.
  assert.match(issue!.message, new RegExp(String(NETWORK_SPECS.instagram.text.maxChars)));
});

check('mensagem cita o fallback quando o provedor nao sincronizou', () => {
  const fallback = NETWORK_SPECS.facebook.text.maxChars;
  const issue = textTooLong('facebook', fallback + 1);
  assert.ok(issue);
  assert.match(issue!.message, /limite da rede/);
});

check('rede nativa sem provider spec continua validando pelo fallback', () => {
  const fallback = NETWORK_SPECS.telegram.text.maxChars;
  assert.equal(
    validateAgainstNetworkSpec('telegram', specWithText(fallback + 1), accountFor('telegram', null)).find(
      (issue) => issue.code === 'text_too_long'
    ) !== undefined,
    true
  );
});

// ------------------------------------------------------ URL da Cloud API

check('a versao da Graph API vem do env e nao do codigo', () => {
  // A URL precisa refletir a versao recebida por parametro, e nao uma constante
  // interna: sem isso, configurar o env nao mudaria nada e a falha apareceria
  // so no primeiro envio em producao.
  assert.equal(
    buildWhatsappMessagesUrl('123', 'v19.0'),
    'https://graph.facebook.com/v19.0/123/messages'
  );
  assert.equal(
    buildWhatsappMessagesUrl('123', 'v21.0'),
    'https://graph.facebook.com/v21.0/123/messages'
  );
});

check('o id da conta e escapado, e nao concatenado cru', () => {
  // `externalAccountId` vem do cadastro da conta, entao e dado de entrada. Um
  // id com `/` reescreveria o caminho e trocaria `messages` por outro endpoint
  // da Graph API -- trocar o destino do envio sem erro nenhum.
  const url = buildWhatsappMessagesUrl('../../other_account', 'v21.0');
  assert.ok(!url.includes('/../'), `a URL preservou travessia de caminho: ${url}`);
  assert.ok(
    url.endsWith('/messages'),
    `a URL precisa terminar em /messages mesmo com id hostil: ${url}`
  );
  assert.ok(url.startsWith('https://graph.facebook.com/v21.0/'), url);
});

check('a versao da Graph API e validada no boot, com o formato da Meta', () => {
  // A Graph API rejeita `21.0` (sem o `v`) com 400 e a mensagem nao menciona o
  // formato. Conferir aqui move o erro para a configuracao.
  assert.match(env.WHATSAPP_GRAPH_VERSION, /^v\d+\.\d+$/);
  // O default tem de existir: quem nao configura nao pode quebrar.
  const semConfig = WHATSAPP_GRAPH_VERSION_SCHEMA.safeParse(undefined);
  assert.equal(semConfig.success, true, 'ausente deveria cair no default');
  assert.match(semConfig.data!, /^v\d+\.\d+$/);
  // E o formato errado e recusado.
  assert.equal(WHATSAPP_GRAPH_VERSION_SCHEMA.safeParse('21.0').success, false);
  assert.equal(WHATSAPP_GRAPH_VERSION_SCHEMA.safeParse('v21').success, false);
  assert.equal(WHATSAPP_GRAPH_VERSION_SCHEMA.safeParse('latest').success, false);
});

console.log(`\n${passed} ok, 0 falhas`);
