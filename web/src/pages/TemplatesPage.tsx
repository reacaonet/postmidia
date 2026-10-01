import { useState } from 'react';
import { getTemplates, createTemplate, setTemplateStatus } from '../api';
import type { TemplateStatus, WhatsappTemplate } from '../api/types';
import { useAsync, useAction } from '../useAsync';
import { useSession } from '../session';
import { DateTime, Empty, ErrorBox, Loading, Pill, TemplatePill } from '../components';

/**
 * Grafo de transicoes, espelhando `src/channels/whatsapp/template-status.ts`.
 *
 * O backend recusa transicao invalida com 409 e ja diz o que fazer. Este
 * mapa nao substitui essa regra — e impede que o painel offers um botao que
 * so volta erro. A duplicacao e consciente: o backend e a autoridade, e o
 * painel degrada se as duas tabelas divergirem (o 409 aparece).
 */
const TRANSITIONS: Record<TemplateStatus, readonly TemplateStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['PAUSED', 'DISABLED', 'PENDING'],
  REJECTED: ['PENDING'],
  PAUSED: ['APPROVED', 'DISABLED'],
  DISABLED: ['PENDING'],
};

const STATUS_LABEL: Record<TemplateStatus, string> = {
  PENDING: 'Pendente',
  APPROVED: 'Aprovado',
  REJECTED: 'Reprovado',
  PAUSED: 'Pausado',
  DISABLED: 'Desabilitado',
};

export default function TemplatesPage(): JSX.Element {
  const { token, canWrite } = useSession();
  const templates = useAsync(() => getTemplates(token ?? ''), [token]);

  return (
    <>
      <h1 className="page-title">Templates de WhatsApp</h1>
      <p className="page-sub">
        O status é controlado pela Meta. O painel reflete o que o provedor respondeu — mudar o status à mão não
        convence a Meta, e o envio é recusado depois de gastar cota.
      </p>

      <div className="alert warn">
        A leitura do status direto da Meta ainda não está implementada: o campo é mantido à mão e a aprovação real
        depende de credencial da WABA que o projeto ainda não tem. Um template marcado como aprovado aqui pode
        ser recusado pela Meta no envio.
      </div>

      {canWrite && <NewTemplate onCreated={templates.reload} />}

      <div className="card">
        <div className="card-title">
          <span>Templates</span>
          {templates.data && <Pill tone="neutral">{templates.data.data.length}</Pill>}
        </div>

        {templates.loading && <Loading what="templates" />}
        {templates.error && <ErrorBox message={templates.error} onRetry={templates.reload} />}
        {!templates.loading && !templates.error && templates.data?.data.length === 0 && (
          <Empty>Nenhum template cadastrado. Posts de WhatsApp com tipo “template” são recusados sem eles.</Empty>
        )}

        {templates.data && templates.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Idioma</th>
                <th>Categoria</th>
                <th>Status</th>
                <th>Variáveis</th>
                <th>Criado</th>
                <th>Mudar status</th>
              </tr>
            </thead>
            <tbody>
              {templates.data.data.map((template) => (
                <Row key={template.id} template={template} onChanged={templates.reload} canWrite={canWrite} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const Row = ({
  template,
  onChanged,
  canWrite,
}: {
  template: WhatsappTemplate;
  onChanged: () => void;
  canWrite: boolean;
}): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  const allowed = TRANSITIONS[template.status];

  return (
    <tr>
      <td>
        <strong>{template.name}</strong>
        <div className="hint">cabeçalho {template.headerType.toLowerCase()}</div>
      </td>
      <td className="mono">{template.languageCode}</td>
      <td>{template.category.toLowerCase()}</td>
      <td>
        <TemplatePill status={template.status} />
      </td>
      <td className="mono">{template.variableCount}</td>
      <td>
        <DateTime value={template.createdAt} />
      </td>
      <td>
        {canWrite ? (
          <>
            <div className="actions">
              {allowed.length === 0 ? (
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>sem transições</span>
              ) : (
                allowed.map((next) => (
                  <button
                    key={next}
                    className="secondary small"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await setTemplateStatus(token ?? '', template.id, next);
                        onChanged();
                      })
                    }
                  >
                    → {STATUS_LABEL[next]}
                  </button>
                ))
              )}
            </div>
            {error && (
              <div className="alert error" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
                {error}
              </div>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>somente owner/admin</span>
        )}
      </td>
    </tr>
  );
};

const NewTemplate = ({ onCreated }: { onCreated: () => void }): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  const [name, setName] = useState('');
  const [languageCode, setLanguageCode] = useState('pt_BR');
  const [category, setCategory] = useState('MARKETING');
  const [headerType, setHeaderType] = useState('NONE');
  const [variableCount, setVariableCount] = useState(0);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setDone(null);
    await run(async () => {
      // Nasce PENDING de proposito: e o estado honesto para algo que a Meta
      // ainda nao reprovou nem aprovou.
      await createTemplate(token ?? '', { name, languageCode, category, headerType, variableCount, status: 'PENDING' });
      setName('');
      setDone('Template criado como pendente. Só publications com status aprovado passam.');
      onCreated();
    });
  };

  return (
    <div className="card">
      <div className="card-title">Novo template</div>
      {error && <div className="alert error">{error}</div>}
      {done && <div className="alert ok">{done}</div>}

      <form onSubmit={submit}>
        <div className="row">
          <label>
            <span>Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="promo_boas_vindas" />
          </label>
          <label>
            <span>Idioma</span>
            <input value={languageCode} onChange={(e) => setLanguageCode(e.target.value)} required minLength={2} />
            <div className="hint">Faz parte da identidade: o mesmo nome em outro idioma é outro template.</div>
          </label>
        </div>

        <div className="row">
          <label>
            <span>Categoria</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="MARKETING">marketing</option>
              <option value="UTILITY">utility</option>
              <option value="AUTHENTICATION">authentication</option>
            </select>
          </label>
          <label>
            <span>Cabeçalho</span>
            <select value={headerType} onChange={(e) => setHeaderType(e.target.value)}>
              <option value="NONE">nenhum</option>
              <option value="TEXT">texto</option>
              <option value="IMAGE">imagem</option>
              <option value="VIDEO">vídeo</option>
              <option value="DOCUMENT">documento</option>
            </select>
          </label>
          <label>
            <span>Variáveis</span>
            <input
              type="number"
              min={0}
              value={variableCount}
              onChange={(e) => setVariableCount(Number(e.target.value))}
            />
            <div className="hint">O envio precisa de exatamente esta quantidade de parâmetros.</div>
          </label>
        </div>

        <button type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : 'Criar template'}
        </button>
      </form>
    </div>
  );
};
