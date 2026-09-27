import type { WhatsappTemplate } from '../../domain/types';

/**
 * Transicoes de status de template, no vocabulario da Meta.
 *
 * **O que o codigo aceitou antes.** Qualquer par de valores do enum. O operador
 * que editasse o proprio template de `REJECTED` para `APPROVED` — que e
 * exatamente o gesto que alguem faz quando a publicacao esta falhando e o
 * operador esta com pressa — produzia um template que a API aceitaria e a Meta
 * recusaria na hora do envio. O erro aparecia como falha de publicacao, com o
 * trabalho todo (job, cota, tentativas, fila morta) jogado fora por causa de um
 * campo digitado.
 *
 * Por isso `REJECTED -> APPROVED` e proibido. Nao existe caminho no produto que
 * faça a Meta aprovar um template que ela reprovou: ou o conteudo e corrigido e
 * ele volta para `PENDING` para ser reprocessado, ou a resposta honesta e dizer
 * que o template nao pode ser usado.
 *
 * **Por que isso nao substitui o sync.** Uma maquina de estado sobre um status
 * que o operador digita so impede os transitorios absurdos; ela nao traz a
 * verdade da Meta. Quem traz e a leitura de `message_templates` na WABA, que
 * depende de credencial que o projeto ainda nao tem (ver "Fase 6" na
 * ARCHITETURA). Ate la, esta e uma rede de seguranca, nao a fonte.
 */
const TRANSITIONS: Record<WhatsappTemplate['status'], readonly WhatsappTemplate['status'][]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['PAUSED', 'DISABLED', 'PENDING'],
  // Voltar para PENDING e o caminho de "corrigi o conteudo, reenvia". Ir
  // direto para APPROVED fingiria uma aprovacao que ninguem concedeu.
  REJECTED: ['PENDING'],
  PAUSED: ['APPROVED', 'DISABLED'],
  // Meta trata DISABLED como recuperavel pela atualizacao de qualidade, mas
  // quem decide isso e o provedor. Pela mao, o unico movimento honesto e
  // reenviar.
  DISABLED: ['PENDING'],
};

export const canTransitionTemplate = (
  from: WhatsappTemplate['status'],
  to: WhatsappTemplate['status']
): boolean => from === to || TRANSITIONS[from].includes(to);

/**
 * Explicacao da recusa, ou `null` quando a transicao vale.
 *
 * A mensagem diz o que fazer, nao apenas o que nao pode: o operador precisa
 * saber se volta para PENDING, se contorna, ou se o template foi para o fim.
 */
export const explainTemplateTransition = (
  from: WhatsappTemplate['status'],
  to: WhatsappTemplate['status']
): string | null => {
  if (canTransitionTemplate(from, to)) {
    return null;
  }

  const allowed = TRANSITIONS[from];
  const list = allowed.length > 0 ? allowed.join(', ') : 'nenhuma';

  if (from === 'REJECTED') {
    return (
      `template reprovado pela Meta nao pode ser marcado como ${to} a mao: ` +
      'a aprovacao e do provedor. Corrija o conteudo e devolva para PENDING.'
    );
  }

  if (from === 'DISABLED') {
    return `template desabilitado so volta por PENDING (a reativacao e do provedor). Transicoes de DISABLED: ${list}.`;
  }

  return `transicao ${from} -> ${to} nao existe. Transicoes de ${from}: ${list}.`;
};
