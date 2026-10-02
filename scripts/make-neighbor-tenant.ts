/**
 * Cria um tenant vizinho e devolve um token de owner, em JSON, na saida padrao.
 *
 * Existe para o E2E probar que uma rota de tenant nao alcanca dados de outro
 * tenant. O caminho normal seria `/auth/signup`, mas `/auth` tem rate limit de
 * 20/min por IP e um signup a mais faz o proprio E2E estourar o limite e derrubar
 * a secao de rate limit — o teste passaria a medir a coisa errada.
 *
 * O token e' forjado com o segredo do proprio processo: nao queremos gastar login
 * para obter uma credencial que o teste so usa como "outro cliente".
 *
 * A saida tem que ser a ULTIMA linha: o store escreve "[store] backend: postgres"
 * e "[db] RLS ativo..." na saida padrao, e o `j` do bash quebra com o prefixo.
 */
import { createTenant, insertUser } from '../src/store';
import { signToken } from '../src/security/jwt';

const slug = `outro-${Date.now().toString(36)}`;

createTenant({ name: 'Outro', slug })
  .then((tenant) =>
    insertUser({
      tenantId: tenant.id,
      email: `outro@${slug}.com`,
      // O E2E nunca faz login com este usuario; a senha e' irrelevante.
      passwordHash: 'nao-usada-pelo-e2e',
      role: 'owner',
    }).then((user) => ({ tenant, user }))
  )
  .then(({ tenant, user }) => {
    console.log(
      JSON.stringify({
        tenantId: tenant.id,
        token: signToken({ sub: user.id, email: user.email, tenantId: tenant.id, role: 'owner' }),
      })
    );
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });