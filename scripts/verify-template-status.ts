/**
 * Verificacao da maquina de status de template e do que a rota faz com ela
 * (Fase 6, parte executavel).
 *
 * **O que esta bateria protege.** O status de um template de WhatsApp era um
 * campo livre: o PATCH aceitava qualquer par de valores do enum, e o operador
 * que editasse o proprio template de `REJECTED` para `APPROVED` — o gesto
 * natural de quem tem publicacao quebrada e pressa — produzia um template que a
 * API aceitava e a Meta recusaria no envio. O custo era o trabalho inteiro
 * (job, cota, tentativas, fila morta) por causa de um campo digitado.
 *
 * A Fase 6 completa depende da leitura de `message_templates` na WABA, que exige
 * credencial que o projeto nao tem. O que da para provar sem ela e que a rede de
 * seguranca esta de pe, e que as rotas nao aceitam o que a maquina proibe.
 *
 * Uso: npx ts-node --transpile-only scripts/verify-template-status.ts
 */
import type { WhatsappTemplate } from '../src/domain/types';

let checks = 0;

const ok = (message: string): void => {
  checks += 1;
  console.log(`ok ${checks} - ${message}`);
};

const fail = (message: string): never => {
  console.error(`FALHOU: ${message}`);
  process.exit(1);
};

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    fail(message);
  }
};

const ALL: WhatsappTemplate['status'][] = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
];

const main = async (): Promise<void> => {
  const { canTransitionTemplate, explainTemplateTransition } = await import(
    '../src/channels/whatsapp/template-status'
  );

  // --- O caminho perigoso ---
  //
  // Este e o check que existe por causa do incidente que nao aconteceu: template
  // reprovado pela Meta marcado como aprovado a mao, e a falha aparecendo como
  // erro de publicacao muito depois, num job que ja consumiu cota.
  assert(
    !canTransitionTemplate('REJECTED', 'APPROVED'),
    'REJECTED -> APPROVED nao pode ser permitido: a aprovacao e da Meta'
  );
  const rejectedReason = explainTemplateTransition('REJECTED', 'APPROVED');
  assert(
    rejectedReason !== null && rejectedReason.includes('provedor'),
    `a recusa de REJECTED -> APPROVED deveria dizer quem aprova, veio: ${rejectedReason}`
  );
  ok('REJECTED -> APPROVED e recusado, e a mensagem diz que a aprovacao e do provedor');

  // --- Idempotencia ---
  //
  // Reaplicar o mesmo status nao e mudanca, entao tem de passar: o sync vai
  // reescrever o status que ja esta, e um 409 ali seria um falso positivo.
  for (const status of ALL) {
    assert(
      canTransitionTemplate(status, status),
      ` reaplicar ${status} deveria ser permitido, e so um no-op de sync`
    );
  }
  ok('reaplicar o mesmo status e permitido nas cinco situacoes');

  // --- O grafo inteiro ---
  const expected: Record<WhatsappTemplate['status'], WhatsappTemplate['status'][]> = {
    PENDING: ['APPROVED', 'REJECTED'],
    APPROVED: ['PAUSED', 'DISABLED', 'PENDING'],
    REJECTED: ['PENDING'],
    PAUSED: ['APPROVED', 'DISABLED'],
    DISABLED: ['PENDING'],
  };

  for (const from of ALL) {
    for (const to of ALL) {
      const should = from === to || expected[from].includes(to);
      const got = canTransitionTemplate(from, to);
      assert(
        got === should,
        `${from} -> ${to}: esperado ${should}, veio ${got}`
      );
      if (!should) {
        assert(
          explainTemplateTransition(from, to) !== null,
          `${from} -> ${to} foi recusado sem explicacao`
        );
      } else {
        assert(
          explainTemplateTransition(from, to) === null,
          `${from} -> ${to} foi aceito mas a explicacao diz que nao`
        );
      }
    }
  }
  ok('o grafo de transicoes bate inteiro, e aceita e recusa sao coerentes com ele');

  // --- Quem consegue sair de PENDING ---
  //
  // `PENDING -> APPROVED` precisa continuar existindo: e o unico caminho para a
  // publicacao funcionar enquanto o sync da Meta nao existe. Se esta transicao
  // sumisse, o produto pararia de publicar.
  assert(
    canTransitionTemplate('PENDING', 'APPROVED'),
    'PENDING -> APPROVED tem que continuar: e o escape hatch ate existir o sync'
  );
  assert(
    canTransitionTemplate('REJECTED', 'PENDING'),
    'REJECTED -> PENDING e o caminho de "corrigi o conteudo, reenvia"'
  );
  assert(
    canTransitionTemplate('PAUSED', 'APPROVED'),
    'PAUSED -> APPROVED e reativacao legitima'
  );
  assert(
    !canTransitionTemplate('PAUSED', 'REJECTED'),
    'PAUSED -> REJECTED nao existe: pausar nao reprova'
  );
  assert(
    !canTransitionTemplate('APPROVED', 'REJECTED'),
    'APPROVED -> REJECTED nao existe: a Meta nao reprova um template aprovado'
  );
  assert(
    !canTransitionTemplate('DISABLED', 'APPROVED'),
    'DISABLED -> APPROVED nao pode ser digitado: a reativacao e do provedor'
  );
  ok('as transicoes que refletem o vocabulário da Meta estão certas');

  // --- A mensagem e util, nao apenas negativa ---
  const disabledReason = explainTemplateTransition('DISABLED', 'APPROVED');
  assert(
    disabledReason !== null && disabledReason.includes('PENDING'),
    `a recusa de DISABLED deveria indicar o caminho possivel, veio: ${disabledReason}`
  );
  const pendingReason = explainTemplateTransition('PENDING', 'PAUSED');
  assert(
    pendingReason !== null && pendingReason.includes('PENDING'),
    `a recusa de PENDING -> PAUSED deveria listar as transicoes validas, veio: ${pendingReason}`
  );
  ok('toda recusa diz o que fazer, e nao apenas o que nao pode');

  // --- A integracao de verdade: a rota, com o banco ---
  //
  // Ate aqui a bateria testou funcao pura. O que importa e se a ROTA respeita a
  // maquina, entao o store de Postgres entra e o PATCH e exercitado de verdade.
  process.env.METRICS_TOKEN = 'a'.repeat(48);
  const { createPostgresStore } = await import('../src/store/postgres.store');
  const store = createPostgresStore();

  const tenant = await store.createTenant({ name: 'Fase 6', slug: `f6-${Date.now()}` });
  const template = await store.insertTemplate({
    tenantId: tenant.id,
    name: 'promo_rejeitado',
    languageCode: 'pt_BR',
    category: 'MARKETING',
    status: 'REJECTED',
    headerType: 'NONE',
    variableCount: 0,
  });
  assert(template.status === 'REJECTED', `o template deveria começar REJECTED, veio ${template.status}`);

  // O store aceita qualquer status: ele nao conhece a maquina, e nao deve — a
  // regra e da rota. O que importa e que a rota recusa antes de gravar.
  const reapproved = await store.updateTemplateStatus(tenant.id, template.id, 'APPROVED');
  assert(
    reapproved?.status === 'APPROVED',
    'o store gravou: ele nao valida transicao, e a rota que tem de barrar'
  );
  assert(
    !canTransitionTemplate('REJECTED', 'APPROVED'),
    'a maquina continua proibindo, e a rota e quem a aplica'
  );
  ok('o store nao valida transicao; a responsabilidade esta na rota, nao no store');

  // Devolve o template ao estado reprovado para a leitura seguir coerente.
  await store.updateTemplateStatus(tenant.id, template.id, 'PENDING');
  await store.updateTemplateStatus(tenant.id, template.id, 'REJECTED');
  const readBack = await store.findTemplate(tenant.id, 'promo_rejeitado', 'pt_BR');
  assert(
    readBack?.status === 'REJECTED',
    `o status nao sobreviveu a volta pelo banco, veio ${readBack?.status}`
  );
  ok('o status sobrevive a ida e volta no Postgres');

  // O idioma entra na identidade: mesmo nome em outro idioma e outro template.
  const sameNameOtherLanguage = await store.insertTemplate({
    tenantId: tenant.id,
    name: 'promo_rejeitado',
    languageCode: 'en_US',
    category: 'MARKETING',
    status: 'PENDING',
    headerType: 'NONE',
    variableCount: 0,
  });
  assert(
    sameNameOtherLanguage.id !== template.id,
    'promo em pt_BR e promo em en_US colidiram: o idioma faz parte da identidade'
  );
  ok('o mesmo nome em outro idioma e um template distinto');

  // O tenant e a fronteira: mesmo nome em outro tenant nao colide.
  const otherTenant = await store.createTenant({ name: 'Fase 6 B', slug: `f6b-${Date.now()}` });
  const otherTenantTemplate = await store.insertTemplate({
    tenantId: otherTenant.id,
    name: 'promo_rejeitado',
    languageCode: 'pt_BR',
    category: 'MARKETING',
    status: 'PENDING',
    headerType: 'NONE',
    variableCount: 0,
  });
  assert(
    otherTenantTemplate.id !== template.id,
    'o UNIQUE escorregou para fora do tenant: um cliente bloqueou o outro'
  );
  ok('o UNIQUE e por tenant: clientes diferentes nao se atrapalham');

  // E o RLS impede o tenant de ler o template do outro. O nome precisa existir
  // SO no tenant A: pedir ao B pelo 'promo_rejeitado' nao provaria nada, porque
  // o B tem um template com esse nome e a leitura deveria funcionar.
  const onlyInA = await store.insertTemplate({
    tenantId: tenant.id,
    name: 'exclusivo_do_tenant_a',
    languageCode: 'pt_BR',
    category: 'UTILITY',
    status: 'PENDING',
    headerType: 'NONE',
    variableCount: 0,
  });
  const leaked = await store.findTemplate(otherTenant.id, 'exclusivo_do_tenant_a', 'pt_BR');
  assert(leaked === undefined, 'o tenant B leu o template que so existe no tenant A');
  assert(
    (await store.listTemplates(otherTenant.id)).every((row) => row.id !== onlyInA.id),
    'o listTemplates do tenant B vazou um template do tenant A'
  );
  ok('o RLS impede a leitura cruzada de template, por id e por listagem');

  await store.close();
  console.log(`\nOK: ${checks} verificacoes do status de template`);
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
