import { hasAdapter, resolveAdapter } from './registry';
import type { PublishSpec, ValidationIssue } from './adapter';
import type { ChannelAccount, ResolvedChannelAccount } from '../domain/types';

/**
 * Redes em que o mesmo post vira um job por destinatario.
 *
 * A audiencia nao e parcial: ou o post vai para todos os contatos informados,
 * ou nao vai. E o mesmo formato ja usado pelo `POST /campaigns/:id/posts`.
 */
const EXPAND_AUDIENCE: Partial<Record<string, true>> = { whatsapp: true };

export interface PostRejection {
  accountId: string;
  network: string;
  issues: ValidationIssue[];
}

export interface PostTarget {
  account: ChannelAccount;
  resolved: ResolvedChannelAccount;
  recipient: string | null;
}

/**
 * Monta um job por conta de destino.
 *
 * O `recipient` entra aqui porque a rede decide a cardinalidade: so o WhatsApp
 * (hoje) precisa de um destinatario por job, e as redes publicas ignoram a
 * audiencia. Um post com duas contas de WhatsApp e tres contatos gera seis
 * jobs, nao dois.
 */
export const expandTargets = (
  accounts: ChannelAccount[],
  resolvedById: Map<string, ResolvedChannelAccount>,
  audience: string[]
): PostTarget[] => {
  const targets: PostTarget[] = [];

  for (const account of accounts) {
    const resolved = resolvedById.get(account.id);
    if (!resolved) {
      continue;
    }
    const needsAudience = EXPAND_AUDIENCE[account.network] === true;
    const recipients = needsAudience && audience.length > 0 ? audience : [null];

    for (const recipient of recipients) {
      targets.push({ account, resolved, recipient });
    }
  }

  return targets;
};

const issueKey = (issue: ValidationIssue): string =>
  `${issue.field}|${issue.code}|${issue.message}`;

/**
 * Valida o mesmo post para cada conta de destino.
 *
 * A validacao e por conta de proposito: o mesmo texto aceito pelo Instagram
 * passa dos 1024 caracteres do WhatsApp, e recusar o post inteiro esconderia o
 * problema real. Por isso o retorno sao recusas agrupadas por conta, e nao um
 * booleano.
 *
 * Como o agrupamento e por conta e nao por job, uma conta de WhatsApp com tres
 * contatos recusados devolve uma recusa so, com os problemas de cada contato.
 * Repetir um contato na audiencia nao pode multiplicar a mesma mensagem no 422.
 */
export const validatePostForTargets = async (
  spec: PublishSpec,
  targets: PostTarget[]
): Promise<PostRejection[]> => {
  const perTarget = await Promise.all(
    targets.map(async ({ account, resolved, recipient }) => {
      if (!hasAdapter(account.network)) {
        return {
          accountId: account.id,
          network: account.network,
          issues: [
            {
              field: 'account' as const,
              code: 'no_adapter',
              message: `Nenhum adapter registrado para ${account.network}`,
            },
          ],
        };
      }

      const issues = await resolveAdapter(account.network).validate(
        { ...spec, recipient },
        resolved
      );

      return issues.length > 0
        ? { accountId: account.id, network: account.network, issues }
        : null;
    })
  );

  const byAccount = new Map<string, PostRejection>();

  for (const entry of perTarget) {
    if (entry === null) {
      continue;
    }

    const existing = byAccount.get(entry.accountId);
    if (existing === undefined) {
      byAccount.set(entry.accountId, {
        accountId: entry.accountId,
        network: entry.network,
        issues: [...entry.issues],
      });
      continue;
    }

    const seen = new Set(existing.issues.map(issueKey));
    for (const issue of entry.issues) {
      if (seen.has(issueKey(issue))) {
        continue;
      }
      seen.add(issueKey(issue));
      existing.issues.push(issue);
    }
  }

  return [...byAccount.values()];
};