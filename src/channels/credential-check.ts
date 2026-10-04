import axios, { type AxiosResponse } from 'axios';
import type { Network } from '../domain/networks';
import { providerHttp } from './provider-http';
import { env } from '../config';

/**
 * Quem a credencial pertence, segundo o provedor.
 *
 * O `externalAccountId` que o operador digita e o que o provador responde na
 * validacao, e nao o que ele digitou: um `@Estetichat` digitado com `@` a mais, um
 * URN do LinkedIn montado na mao com `person` no lugar de `sub`, um id numerico
 * que o Telegram aceita mas o painel mostra como texto. Comparar os dois e o que
 * pega o erro antes da fila morta.
 */
export type CredentialIdentity = {
  externalAccountId: string;
  displayName: string;
  /** Vasios quando o provedor expoe o bot em vez da conta que publica. */
  actor?: { id: string; displayName: string; username: string | null } | null;
  /** Caminho sugerido no painel do provedor. */
  hint?: string;
};

export type CredentialCheck =
  | { ok: true; identity: CredentialIdentity }
  | { ok: false; error: string; hint?: string };

/**
 * Consulta o provedor para provar que o token existe e descrever o que ele
 * alcanca.
 *
 * Espelha `Telegram_channels::token()` do StackPosts: o token colado no painel
 * e testado contra o provedor ANTES de virar conta, e um token recusado nao
 * chega a ser gravado. Sem isso o `POST /accounts` aceitava qualquer texto como
 * segredo e marcava a conta `active`, e o operador so descobria o problema
 * quando a fila morta aparecia -- com o job ja consumindo cota.
 *
 * Nunca lanca: um provedor fora do ar degrada para `ok: false` com o motivo, em
 * vez de derrubar o cadastro por causa de dependencia externa.
 */
export const checkCredential = async (
  network: Network,
  secret: string,
  externalAccountId: string
): Promise<CredentialCheck> => {
  if (!env.ACCOUNT_CREDENTIAL_CHECK_ENABLED) {
    return { ok: true, identity: { externalAccountId, displayName: externalAccountId } };
  }

  const probe = probes[network];

  if (!probe) {
    // Redes que hoje sao servidas pelo Postiz nao tem probe proprio: la o
    // segredo NAO e um token da rede, e a chave publica do Postiz. Validar
    // `Authorization: <chave do postiz>` contra api.linkedin.com so produziria
    // 401 falso em toda conta boa.
    return { ok: true, identity: { externalAccountId, displayName: externalAccountId } };
  }

  try {
    return await probe(secret, externalAccountId);
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
};

const describe = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as
      | { message?: string; error?: string; description?: string }
      | undefined;
    const fromBody = body?.message ?? body?.error ?? body?.description;
    if (fromBody) {
      return fromBody;
    }
    return `${error.response?.status ?? 0} ${error.message}`.trim();
  }
  return error instanceof Error ? error.message : String(error);
};

const TELEGRAM_API = 'https://api.telegram.org';

type Probe = (secret: string, externalAccountId: string) => Promise<CredentialCheck>;

/**
 * Telegram responde duas perguntas distintas, e o operador erra uma delas sem
 * perceber: o token pode estar certo (`getMe` passa) e ainda assim o bot nao
 * conseguir postar no canal, porque `chat not found` e o Telegram recusando o
 * destino. As duas sao verificadas aqui porque as duas aparecem como "so da
 * falha" do lado do operador.
 */
/**
 * Telegram responde 4xx com `{ ok:false, description }` eaxios trata isso como
 * erro, entao a `description` -- que e a unica frase util que o Telegram
 * devolve -- chega em `error.response.data`. Sem extrair por `description`, o
 * operador veria "400 Request failed with status code 400" no lugar de "chat not
 * found", que e a informacao que resolve o cadastro.
 */
const telegramMessage = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const body = error.response?.data as { description?: string } | undefined;
    if (body?.description) {
      return body.description;
    }
    if (error.response?.status === 401 || error.response?.status === 404) {
      return 'token invalido (o Telegram devolveu 404 para um token que ele nao reconhece)';
    }
  }
  return describe(error);
};

const probeTelegram: Probe = async (secret, externalAccountId) => {
  let me: AxiosResponse<{ ok: boolean; result?: { id: number; username: string }; description?: string }>;
  try {
    me = await providerHttp.get(`${TELEGRAM_API}/bot${secret}/getMe`);
  } catch (error) {
    return { ok: false, error: `Telegram recusou o token: ${telegramMessage(error)}` };
  }

  if (!me.data.ok || !me.data.result) {
    return { ok: false, error: me.data.description ?? 'Telegram recusou o token' };
  }

  const actor = {
    id: String(me.data.result.id),
    displayName: me.data.result.username,
    username: me.data.result.username,
  };

  const chat = externalAccountId.trim();
  if (!chat) {
    return {
      ok: true,
      identity: {
        externalAccountId: '',
        displayName: actor.username,
        actor,
        hint: 'Token valido. Informe o canal ou grupo, com @ (ex.: @Estetichat).',
      },
    };
  }

  let info: AxiosResponse<{
    ok: boolean;
    result?: { id: number; title?: string; username?: string; type: string };
    description?: string;
  }>;
  try {
    info = await providerHttp.get(`${TELEGRAM_API}/bot${secret}/getChat`, { params: { chat_id: chat } });
  } catch (error) {
    return {
      ok: false,
      error: `Token valido, mas o bot nao alcanca ${chat}: ${telegramMessage(error)}`,
      hint:
        'O token funciona e o bot esta correto. Falta o bot como ADMINISTRADOR do canal, ' +
        'ou o @nome esta errado. No celular: adicione o bot no canal e promova a administrador.',
    };
  }

  if (!info.data.ok || !info.data.result) {
    return {
      ok: false,
      error: `Token valido, mas o bot nao alcanca ${chat}: ${info.data.description ?? 'destino invalido'}`,
      hint:
        'O token funciona e o bot esta correto. Falta o bot como ADMINISTRADOR do canal, ' +
        'ou o @nome esta errado.',
    };
  }

  return {
    ok: true,
    identity: {
      externalAccountId: chat,
      displayName: info.data.result.title ?? info.data.result.username ?? chat,
      actor,
    },
  };
};

const LINKEDIN_USERINFO = 'https://api.linkedin.com/v2/userinfo';

/**
 * LinkedIn nao tem "liste minhas paginas": um token de membro carrega um `sub`
 * e as autorizacoes que a pessoa concedeu. `sub` e a unica identidade que o
 * provedor confirma, e ela e o prefixo do URN que a API de postagem exige --
 * por isso o URN devolvido aqui e a forma canonica de gravar a conta, e nao o
 * que o operador digitou.
 */
const probeLinkedin: Probe = async (secret) => {
  const response = await providerHttp.get<{ sub?: string; name?: string }>(LINKEDIN_USERINFO, {
    headers: { Authorization: `Bearer ${secret}` },
  });

  const sub = response.data?.sub;
  if (!sub) {
    return { ok: false, error: 'LinkedIn respondeu sem `sub`: o token nao e de membro' };
  }

  const urn = sub.startsWith('urn:') ? sub : `urn:li:person:${sub}`;

  return {
    ok: true,
    identity: {
      externalAccountId: urn,
      displayName: response.data.name ?? sub,
      hint: `URN confirmado pelo LinkedIn: ${urn}`,
    },
  };
};

const probes: Partial<Record<Network, Probe>> = {
  telegram: probeTelegram,
  linkedin: probeLinkedin,
};

/** Redes que o probe cobre hoje. */
export const VERIFIABLE_NETWORKS: readonly Network[] = ['telegram', 'linkedin'];