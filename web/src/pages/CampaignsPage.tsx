import { Fragment, useState } from 'react';
import {
  createCampaign,
  createPost,
  dispatchJobNow,
  getAccounts,
  getCampaigns,
  getJobs,
  getNetworks,
  getPosts,
  reconcileJob,
  rescheduleJob,
  updatePost,
} from '../api';
import { rejectionGroups } from '../api/client';
import type {
  Campaign,
  ChannelAccount,
  JobStatus,
  NetworkContentType,
  NetworkSpec,
  Post,
  PublishJob,
} from '../api/types';
import { useAction, useAsync } from '../useAsync';
import { useSession } from '../session';
import { DateTime, Empty, ErrorBox, ExternalId, JobPill, Loading, Pill } from '../components';
import { extensionCrossesPipeline, isValidMediaUrl, isoUtcPlusMinute, localInputToIsoUtc } from '../format';

const STATUSES: Array<JobStatus | 'all'> = [
  'all',
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
];

export default function CampaignsPage(): JSX.Element {
  const [tab, setTab] = useState<'plan' | 'jobs'>('plan');
  return (
    <>
      <h1 className="page-title">Campanhas e publicações</h1>
      <p className="page-sub">
        Uma campanha agrupa posts; cada post gera um job por conta. A validação é por conta: um post aceito para o
        Instagram pode ser recusado para o WhatsApp.
      </p>

      <div className="card">
        <div className="actions">
          <button className={tab === 'plan' ? 'small' : 'secondary small'} onClick={() => setTab('plan')}>
            Planejamento
          </button>
          <button className={tab === 'jobs' ? 'small' : 'secondary small'} onClick={() => setTab('jobs')}>
            Jobs
          </button>
        </div>
      </div>

      {tab === 'plan' ? <Planning /> : <Jobs />}
    </>
  );
}

/* =========================================================== planejamento */

const Planning = (): JSX.Element => {
  const { token, canWrite } = useSession();
  const campaigns = useAsync(() => getCampaigns(token ?? ''), [token]);
  const accounts = useAsync(() => getAccounts(token ?? ''), [token]);
  const networks = useAsync(() => getNetworks(), []);

  const specs = (networks.data?.data.specs ?? {}) as Record<string, NetworkSpec>;

  return (
    <>
      {canWrite && <NewCampaign onCreated={campaigns.reload} />}

      <div className="card">
        <div className="card-title">Campanhas</div>
        {campaigns.loading && <Loading what="campanhas" />}
        {campaigns.error && <ErrorBox message={campaigns.error} onRetry={campaigns.reload} />}
        {!campaigns.loading && !campaigns.error && campaigns.data?.data.length === 0 && (
          <Empty>Nenhuma campanha. Crie a primeira e agende um post.</Empty>
        )}
        {campaigns.data && campaigns.data.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>Status</th>
                <th>Criada</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.data.data.map((campaign) => (
                <tr key={campaign.id}>
                  <td>
                    <strong>{campaign.name}</strong>
                  </td>
                  <td>
                    <CampaignPill campaign={campaign} />
                  </td>
                  <td>
                    <DateTime value={campaign.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {campaigns.data &&
        campaigns.data.data.map((campaign) => (
          <Fragment key={campaign.id}>
            <PostComposer
              campaign={campaign}
              accounts={accounts.data?.data ?? []}
              specs={specs}
              canWrite={canWrite}
              onPublished={campaigns.reload}
            />
            <CampaignPosts campaign={campaign} canWrite={canWrite} onChanged={campaigns.reload} />
          </Fragment>
        ))}
    </>
  );
};

/**
 * Tipos de conteudo aceitos por TODAS as specs escolhidas, pela interseccao dos
 * ids.
 *
 * Preferir a uniao seria pior: o `contentType` e um unico valor por post, e o
 * `validate` roda por conta — um tipo que so existe em uma das redes faz o
 * post inteiro ser recusado com `unknown_content_type`.
 */
const contentTypesCommonTo = (specs: NetworkSpec[]): NetworkContentType[] => {
  const first = specs[0];
  if (!first) return [];
  return first.contentTypes.filter((candidate) =>
    specs.slice(1).every((spec) => spec.contentTypes.some((type) => type.id === candidate.id))
  );
};

const CampaignPill = ({ campaign }: { campaign: Campaign }): JSX.Element => {
  const tone =
    campaign.status === 'finished'
      ? 'ok'
      : campaign.status === 'cancelled'
        ? 'neutral'
        : campaign.status === 'running'
          ? 'info'
          : campaign.status === 'scheduled'
            ? 'warn'
            : 'neutral';
  return <Pill tone={tone}>{campaign.status}</Pill>;
};

const NewCampaign = ({ onCreated }: { onCreated: () => void }): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  const [name, setName] = useState('');

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    await run(async () => {
      await createCampaign(token ?? '', name);
      setName('');
      onCreated();
    });
  };

  return (
    <div className="card">
      <div className="card-title">Nova campanha</div>
      {error && <div className="alert error">{error}</div>}
      <form onSubmit={submit}>
        <div className="row">
          <label>
            <span>Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Setembro" />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Criar campanha'}
          </button>
        </div>
      </form>
    </div>
  );
};

/**
 * Composicao de post.
 *
 * A tela mostra o limite que vale para o conjunto de contas escolhidas, e o
 * mais apertado entre elas. Isso evita o caso comum de escrever 2200 caracteres
 * para Instagram + WhatsApp e receber 422 apenas do WhatsApp, cujo limite e
 * 1024: o operador descobre o limite real antes de apertar enviar.
 */
const PostComposer = ({
  campaign,
  accounts,
  specs,
  canWrite,
  onPublished,
}: {
  campaign: Campaign;
  accounts: ChannelAccount[];
  specs: Record<string, NetworkSpec>;
  canWrite: boolean;
  onPublished: () => void;
}): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error, clear } = useAction();
  const [open, setOpen] = useState(false);
  // Vazio de proposito: os ids de `contentType` sao por rede (`feed`, `reel`,
  // `story`, `carousel`, `template`, ...), nao `IMAGE`/`VIDEO`. Fixar um valor
  // aqui mandaria um `contentType` inexistente e o backend responderia 422 com
  // `unknown_content_type`. A escolha real depende das contas selecionadas.
  const [contentType, setContentType] = useState('');
  const [text, setText] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaKind, setMediaKind] = useState<'image' | 'video'>('image');
  const [selected, setSelected] = useState<string[]>([]);
  const [audience, setAudience] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [result, setResult] = useState<{ jobs: number; scheduledAt: string } | null>(null);
  const [rejections, setRejections] = useState<ReturnType<typeof rejectionGroups>>([]);

  const active = accounts.filter((account) => account.status === 'active');
  const chosen = active.filter((account) => selected.includes(account.id));
  const networksUsed = [...new Set(chosen.map((account) => account.network))];
  // O type-guard e obrigatorio: `filter(Boolean)` deixa o elemento como
  // `NetworkSpec | undefined`, e o `spec.text.maxChars` abaixo deixa de compilar.
  const specsUsed = networksUsed
    .map((network) => specs[network])
    .filter((item): item is NetworkSpec => Boolean(item));

  // `providerMaxLength` tem precedencia sobre o fallback local, entao o minimo
  // efetivo usa o cache quando existe.
  const effectiveMax = specsUsed.length
    ? Math.min(
        ...specsUsed.map((spec) =>
          chosen
            .filter((account) => account.network === spec.network)
            .reduce((min, account) => Math.min(min, account.providerMaxLength ?? spec.text.maxChars), Infinity)
        )
      )
    : null;

  // So oferece tipos que existem em TODAS as redes escolhidas. O backend valida
  // por conta e recusa o post inteiro se um destino nao conhecer o tipo
  // (`unknown_content_type`), entao oferecer a intersao evita montar um post que
  // so funciona para parte das contas.
  const contentTypes = contentTypesCommonTo(specsUsed);
  const activeType = contentTypes.find((type) => type.id === contentType) ?? null;

  // `requiresMedia` na spec da rede e a regra do backend (`media_required`), e
  // ela vale por rede, nao por tipo: Instagram exige midia em qualquer formato.
  //
  // "Exigir" e "permitir" sao coisas diferentes, e usar a mesma flag para as duas
  // escondia o campo de midia inteiro no WhatsApp e no Telegram, cujas specs
  // aceitam imagem e video mas nao obrigam. O operador via um composer so de
  // texto justamente nas duas redes que ele mais usa para cliente.
  const mediaRequired = specsUsed.some((spec) => spec.text.requiresMedia);
  const mediaAllowed = specsUsed.length > 0;

  // A compatibilidade imagem/video e por tipo: `reel` nao aceita imagem, e o
  // painel tem de recusar aqui porque o backend recusaria depois com
  // `image_not_accepted`.
  const kindConflicts =
    mediaUrl.trim() !== '' && activeType !== null
      ? mediaKind === 'image' && !activeType.acceptsImage
        ? `${activeType.label} não aceita imagem.`
        : mediaKind === 'video' && !activeType.acceptsVideo
          ? `${activeType.label} não aceita vídeo.`
          : null
      : null;

  const mediaProblems: string[] = [];
  if (mediaRequired && !mediaUrl.trim()) {
    mediaProblems.push('Esta rede exige mídia.');
  }
  if (mediaUrl.trim()) {
    if (!isValidMediaUrl(mediaUrl.trim())) {
      mediaProblems.push('A URL precisa ser http ou https válida.');
    } else if (extensionCrossesPipeline(mediaUrl.trim())) {
      mediaProblems.push(
        'A extensão da URL não é uma das aceitas pelo pipeline (png, jpg, jpeg, gif, webp, mp4). Se a URL terminar em token de assinatura, informe a extensão real no caminho.',
      );
    }
  }
  if (kindConflicts) {
    mediaProblems.push(kindConflicts);
  }
  if (!mediaRequired && !text.trim()) {
    mediaProblems.push('O post não pode ir vazio: nem texto nem mídia.');
  }

  const blockReason = !canWrite
    ? 'Seu papel não permite criar publicações.'
    : chosen.length === 0
      ? 'Escolha ao menos uma conta ativa.'
      : contentTypes.length === 0
        ? 'As redes escolhidas não compartilham nenhum tipo de conteúdo.'
        : contentType === ''
          ? 'Escolha o tipo de conteúdo.'
          : (text.length > 0 && effectiveMax !== null && text.length > effectiveMax
              ? `Texto acima do limite de ${effectiveMax} caracteres para o conjunto escolhido.`
              : null) ||
            (mediaProblems[0] ?? null);

  const toggle = (id: string): void => {
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setResult(null);
    setRejections([]);
    const scheduledIso = scheduledAt ? localInputToIsoUtc(scheduledAt) : undefined;
    if (scheduledAt && !scheduledIso) {
      return;
    }

    const scheduled = scheduledIso ?? isoUtcPlusMinute();
    await run(async () => {
      try {
        const response = await createPost(token ?? '', campaign.id, {
          contentType,
          text,
          media: mediaUrl.trim() ? [{ kind: mediaKind, url: mediaUrl.trim() }] : [],
          accountIds: selected,
          audience: audience
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
          scheduledAt: scheduled,
        });
        setResult({ jobs: response.data.jobs.length, scheduledAt: response.data.scheduledAt });
        setText('');
        setMediaUrl('');
        setSelected([]);
        setScheduledAt('');
        onPublished();
      } catch (err: unknown) {
        // O 422 traz um grupo por conta; mostrar so a mensagem do primeiro grupo
        // esconderia o resto, entao a lista completa vai para a tela.
        setRejections(rejectionGroups(err));
        throw err;
      }
    });
  };

  return (
    <div className="card">
      <div className="card-title">
        <span>
          Publicar em <strong>{campaign.name}</strong>
        </span>
        <button className="secondary small" onClick={() => { clear(); setOpen(!open); }}>
          {open ? 'Fechar' : 'Novo post'}
        </button>
      </div>

      {open && (
        <form onSubmit={submit}>
          {error && <div className="alert error">{error}</div>}
          {rejections.length > 0 && (
            <div className="alert warn">
              <strong>Recusado por {rejections.length} conta(s).</strong>
              <ul>
                {rejections.map((group) => (
                  <li key={group.accountId}>
                    <span className="mono">{group.network}</span>:{' '}
                    {group.issues.map((issue) => issue.message).join(' ')}
                  </li>
                ))}
              </ul>
              <div className="hint">
                Nenhum job foi criado. Corrija e envie de novo — não é necessário cancelar nada.
              </div>
            </div>
          )}
          {result && (
            <div className="alert ok">
              {result.jobs} job(s) agendados para <DateTime value={result.scheduledAt} />. Acompanhe na aba Jobs.
            </div>
          )}

          <div className="row">
            <label>
              <span>Tipo de conteúdo</span>
              <select
                value={contentType}
                onChange={(e) => setContentType(e.target.value)}
                disabled={contentTypes.length === 0}
              >
                {contentTypes.length === 0 ? (
                  <option value="">escolha as contas primeiro</option>
                ) : (
                  <>
                    <option value="">selecione…</option>
                    {contentTypes.map((type) => (
                      <option key={type.id} value={type.id}>
                        {type.label} ({type.aspect})
                      </option>
                    ))}
                  </>
                )}
              </select>
              <div className="hint">
                {effectiveMax !== null ? `${effectiveMax} caracteres no conjunto escolhido` : 'escolha as contas'}
                {specsUsed.some((item) => item.text.requiresMedia) ? ' · exige mídia' : ''}
                {activeType && !activeType.acceptsImage ? ' · não aceita imagem' : ''}
                {activeType && !activeType.acceptsVideo ? ' · não aceita vídeo' : ''}
              </div>
            </label>

            <label>
              <span>Agendar para (local)</span>
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
              />
              <div className="hint">
                Vazio agenda para agora +1 min. O backend exige UTC; o painel converte e mostra o horário final no
                resultado.
              </div>
            </label>
          </div>

          <label>
            <span>Texto</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder={effectiveMax ? `Até ${effectiveMax} caracteres para as contas escolhidas` : ''}
            />
            <div className="hint">
              {text.length} caracteres
              {effectiveMax !== null && (
                <>
                  {' '}
                  / {effectiveMax}
                  {text.length > effectiveMax && (
                    <strong style={{ color: 'var(--err)' }}> — acima do limite</strong>
                  )}
                </>
              )}
            </div>
          </label>

          {mediaAllowed && (
            <div className="row">
              <label>
                <span>Tipo de mídia</span>
                <select value={mediaKind} onChange={(e) => setMediaKind(e.target.value as 'image' | 'video')}>
                  <option value="image">imagem</option>
                  <option value="video">vídeo</option>
                </select>
                <div className="hint">
                  {activeType
                    ? activeType.acceptsImage && activeType.acceptsVideo
                      ? 'o formato aceita as duas'
                      : activeType.acceptsImage
                        ? 'este formato só aceita imagem'
                        : 'este formato só aceita vídeo'
                    : 'escolha o tipo de conteúdo'}
                </div>
              </label>
              <label style={{ flex: 3 }}>
                <span>URL da mídia {mediaRequired ? '(obrigatória)' : '(opcional)'}</span>
                <input
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  placeholder="https://cdn.exemplo.com/post.jpg"
                />
                <div className="hint">
                  O servidor baixa e guarda uma cópia, preenchendo bytes, mime e dimensões. Não é upload direto pelo
                  painel.
                </div>
              </label>
            </div>
          )}

          <label>
            <span>Contas de destino</span>
            <div className="actions" style={{ marginTop: 4 }}>
              {accounts.length === 0 && <span className="hint">Nenhuma conta cadastrada ainda.</span>}
              {accounts.map((account) => (
                <button
                  type="button"
                  key={account.id}
                  className={selected.includes(account.id) ? 'small' : 'secondary small'}
                  onClick={() => toggle(account.id)}
                  disabled={account.status !== 'active'}
                  title={account.status !== 'active' ? `Conta ${account.status}` : undefined}
                >
                  {specs[account.network]?.label ?? account.network} · {account.displayName}
                </button>
              ))}
            </div>
            <div className="hint">
              Contas não ativas ficam desabilitadas: o backend só publica em conta ativa, e recusar aqui economiza o
              422.
            </div>
          </label>

          <label>
            <span>Público (opcional, separado por vírgula)</span>
            <input
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="para Telegram/WhatsApp: chat ids ou telefones"
            />
            <div className="hint">
              Só faz sentido em redes privadas. Em redes públicas o backend ignora o público.
            </div>
          </label>

          {blockReason && (
            <div className="alert warn">
              {blockReason}
            </div>
          )}

          <button type="submit" disabled={busy || blockReason !== null}>
            {busy ? <span className="spinner" /> : 'Agendar publicação'}
          </button>
        </form>
      )}
    </div>
  );
};

/* ============================================================== conteudo */

/**
 * Um job que nunca executou: o post ainda e rascunho e pode ser corrigido.
 * `failed` conta como executado — o worker chegou a chamar a rede.
 */
const isEditableJob = (job: PublishJob): boolean =>
  job.status === 'queued' || job.status === 'cancelled';

const CampaignPosts = ({
  campaign,
  canWrite,
  onChanged,
}: {
  campaign: Campaign;
  canWrite: boolean;
  onChanged: () => void;
}): JSX.Element => {
  const { token } = useSession();
  const [nonce, setNonce] = useState(0);

  const posts = useAsync(() => getPosts(token ?? '', campaign.id), [token, campaign.id, nonce]);
  const jobs = useAsync(() => getJobs(token ?? '', { campaignId: campaign.id }), [token, campaign.id, nonce]);

  const entries = posts.data?.data ?? [];
  const jobsByPost = new Map<string, PublishJob[]>();
  for (const job of jobs.data?.data ?? []) {
    jobsByPost.set(job.postId, [...(jobsByPost.get(job.postId) ?? []), job]);
  }

  const render = (): JSX.Element => {
    if (posts.loading || jobs.loading) {
      return <Loading what="posts" />;
    }
    if (posts.error) {
      return <ErrorBox message={posts.error} onRetry={posts.reload} />;
    }
    if (entries.length === 0) {
      return <Empty>Nenhum post nesta campanha ainda.</Empty>;
    }

    return (
      <table>
        <thead>
          <tr>
            <th>Conteúdo</th>
            <th>Midia</th>
            <th>Jobs</th>
            <th>Criado</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((post) => {
            const postJobs = jobsByPost.get(post.id) ?? [];
            const locked = postJobs.some((job) => !isEditableJob(job));
            return (
              <PostEditor
                key={post.id}
                post={post}
                jobs={postJobs}
                canWrite={canWrite}
                locked={locked}
                onChanged={() => {
                  setNonce((n) => n + 1);
                  onChanged();
                }}
              />
            );
          })}
        </tbody>
      </table>
    );
  };

  return (
    <div className="card">
      <div className="card-title">
        <span>
          Posts de <strong>{campaign.name}</strong>
        </span>
        <button className="secondary small" onClick={() => setNonce((n) => n + 1)}>
          Atualizar
        </button>
      </div>
      {render()}
    </div>
  );
};

const PostEditor = ({
  post,
  jobs,
  canWrite,
  locked,
  onChanged,
}: {
  post: Post;
  jobs: PublishJob[];
  canWrite: boolean;
  locked: boolean;
  onChanged: () => void;
}): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  const [open, setOpen] = useState(false);
  const [contentType, setContentType] = useState(post.contentType);
  const [text, setText] = useState(post.text);
  const [mediaUrl, setMediaUrl] = useState(post.media[0]?.url ?? '');
  const [rejections, setRejections] = useState<ReturnType<typeof rejectionGroups>>([]);
  const [done, setDone] = useState<string | null>(null);

  const mediaKind = post.media[0]?.kind ?? 'image';
  const firstMedia = post.media[0];
  const preview = firstMedia === undefined ? null : firstMedia.url;

  const openForm = (): void => {
    setContentType(post.contentType);
    setText(post.text);
    setMediaUrl(post.media[0]?.url ?? '');
    setRejections([]);
    setDone(null);
    setOpen(!open);
  };

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setRejections([]);
    setDone(null);

    // Midia so entra no corpo quando mudou. Sem media no post e nada digitado,
    // `undefined` mantem o estado; com media que o operador apagou, `[]` remove.
    const media: Array<{ kind: 'image' | 'video'; url: string }> | undefined =
      post.media.length === 0 && mediaUrl.trim() === ''
        ? undefined
        : [{ kind: mediaKind, url: mediaUrl.trim() }];

    await run(async () => {
      try {
        await updatePost(token ?? '', post.id, {
          contentType: contentType.trim(),
          text,
          media,
        });
        setDone('Conteudo atualizado. Os jobs na fila vao publicar a versao nova.');
        onChanged();
      } catch (err: unknown) {
        setRejections(rejectionGroups(err));
        throw err;
      }
    });
  };

  const queued = jobs.filter((job) => job.status === 'queued').length;

  return (
    <>
      <tr>
        <td style={{ maxWidth: 420 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
            {post.contentType}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{post.text || <span style={{ color: 'var(--muted)' }}>(sem texto)</span>}</div>
        </td>
        <td>
          {preview ? (
            <span className="mono" style={{ fontSize: 12 }}>
              {mediaKind} · {preview}
            </span>
          ) : (
            <span style={{ color: 'var(--muted)' }}>—</span>
          )}
        </td>
        <td>
          {jobs.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>—</span>
          ) : (
            <div className="actions">
              {jobs.map((job) => (
                <span key={job.id} className="mono" style={{ fontSize: 12 }}>
                  {job.network}
                  {job.recipient ? `:${job.recipient}` : ''} <JobPill status={job.status} />
                </span>
              ))}
            </div>
          )}
        </td>
        <td>
          <DateTime value={post.createdAt} />
        </td>
        <td>
          {canWrite && !locked && (
            <button className="secondary small" onClick={openForm}>
              {open ? 'Fechar' : 'Editar'}
            </button>
          )}
          {canWrite && locked && (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              já publicado{queued === 0 ? '' : ` · ${queued} na fila`}
            </span>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
            <form onSubmit={save}>
              {error && <div className="alert error">{error}</div>}
              {rejections.length > 0 && (
                <div className="alert warn">
                  <strong>Recusado por {rejections.length} conta(s).</strong>
                  <ul>
                    {rejections.map((group) => (
                      <li key={group.accountId}>
                        <span className="mono">{group.network}</span>: {group.issues.map((issue) => issue.message).join(' ')}
                      </li>
                    ))}
                  </ul>
                  <div className="hint">Nada foi alterado. O post continua como estava.</div>
                </div>
              )}
              {done && <div className="alert ok">{done}</div>}

              <div className="row">
                <label>
                  <span>Tipo de conteudo</span>
                  <input value={contentType} onChange={(e) => setContentType(e.target.value)} />
                  <div className="hint">O id de cada rede: feed, reel, story, carousel, template…</div>
                </label>
                {post.media.length > 0 && (
                  <label style={{ flex: 2 }}>
                    <span>URL da midia</span>
                    <input value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
                    <div className="hint">Vazio remove a midia do post. O tipo atual é {mediaKind}.</div>
                  </label>
                )}
              </div>

              <label>
                <span>Texto</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
                <div className="hint">
                  {text.length} caracteres · vale para os {jobs.length} job(s) ainda na fila deste post.
                </div>
              </label>

              <div className="hint">
                Editar vale para todos os jobs nao executados: o worker le o post do banco na hora de publicar.
              </div>

              <button type="submit" disabled={busy || contentType.trim() === ''}>
                {busy ? <span className="spinner" /> : 'Salvar conteudo'}
              </button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
};

/* ==================================================================== jobs */

const Jobs = (): JSX.Element => {
  const { token, canWrite } = useSession();
  const [status, setStatus] = useState<JobStatus | 'all'>('all');
  const [nonce, setNonce] = useState(0);

  const jobs = useAsync(
    () => getJobs(token ?? '', status === 'all' ? {} : { status }),
    [token, status, nonce]
  );

  const entries = jobs.data?.data ?? [];
  const failed = entries.filter((job) => job.status === 'failed').length;
  const pendingSync = entries.filter((job) => job.releaseIdMissing).length;
  const queuedCount = entries.filter((job) => job.status === 'queued').length;

  return (
    <>
      <div className="card">
        <div className="actions">
          {STATUSES.map((item) => (
            <button
              key={item}
              className={status === item ? 'small' : 'secondary small'}
              onClick={() => setStatus(item)}
            >
              {item}
            </button>
          ))}
          <button className="secondary small" onClick={() => setNonce((n) => n + 1)}>
            Atualizar
          </button>
          <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12 }}>
            {failed > 0 ? `${failed} com falha · ` : ''}
            {entries.length} no filtro
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Jobs</div>
        {jobs.loading && <Loading what="jobs" />}
        {jobs.error && <ErrorBox message={jobs.error} onRetry={jobs.reload} />}
        {!jobs.loading && !jobs.error && entries.length === 0 && (
          <Empty>Nenhum job neste filtro. Agende uma publicação para ver.</Empty>
        )}

        {entries.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Rede</th>
                <th>Destinatário</th>
                <th>Agendado</th>
                <th>Status</th>
                <th>Tentativas</th>
                <th>Publicado</th>
                <th>Id na rede</th>
                <th>Erro</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((job) => (
                <JobRow key={job.id} job={job} canWrite={canWrite} onChanged={jobs.reload} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pendingSync > 0 && (
        <div className="alert info">
          {pendingSync} job(s) publicar e ainda não têm o id da rede conhecido. O worker tenta reconciliar
          automaticamente; use "Reconciliar" se o resultado não aparecer.
        </div>
      )}

      {queuedCount === 0 && entries.length > 0 && (
        <div className="alert info">
          Nenhum job <strong>na fila</strong> neste filtro. &quot;Reagendar&quot; e &quot;Enviar agora&quot; só existem
          em job <span className="mono">queued</span>: um job que já rodou não tem horário para mover, e um job que
          falhou pode ter saído na rede — por isso o botão some em vez de aparecer e devolver 409.
        </div>
      )}
    </>
  );
};

const JobRow = ({
  job,
  canWrite,
  onChanged,
}: {
  job: PublishJob;
  canWrite: boolean;
  onChanged: () => void;
}): JSX.Element => {
  const { token } = useSession();
  const { run, busy, error } = useAction();
  const [outcome, setOutcome] = useState<string | null>(null);
  const [whenOpen, setWhenOpen] = useState(false);
  const [when, setWhen] = useState('');

  const reconcile = () =>
    run(async () => {
      const response = await reconcileJob(token ?? '', job.id);
      if (response.data.outcome === 'pending') {
        // 202 + outcome 'pending': o Postiz ainda nao devolveu o id. Nao e erro.
        setOutcome('O Postiz ainda não devolveu o id. Tente de novo em alguns minutos.');
      } else {
        setOutcome('Id da rede obtido.');
        onChanged();
      }
    });

  const reschedule = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const iso = localInputToIsoUtc(when);
    if (iso === undefined) {
      setOutcome('Horário inválido.');
      return;
    }
    await run(async () => {
      await rescheduleJob(token ?? '', job.id, iso);
      setOutcome(null);
      setWhenOpen(false);
      onChanged();
    });
  };

  const sendNow = () =>
    run(async () => {
      await dispatchJobNow(token ?? '', job.id);
      setOutcome(null);
      setWhenOpen(false);
      onChanged();
    });

  const editable = job.status === 'queued';

  return (
    <tr>
      <td>
        <Pill tone="info">{job.network}</Pill>
      </td>
      <td className="mono">{job.recipient ?? '—'}</td>
      <td>
        <DateTime value={job.scheduledAt} />
      </td>
      <td>
        <JobPill status={job.status} />
      </td>
      <td className="mono">{job.attempts}</td>
      <td>
        <DateTime value={job.publishedAt} />
      </td>
      <td>
        <ExternalId value={job.externalPostId} releaseIdMissing={job.releaseIdMissing} />
        {job.permalink && (
          <div>
            <a href={job.permalink} target="_blank" rel="noreferrer noopener">
              abrir publicação
            </a>
          </div>
        )}
      </td>
      <td style={{ maxWidth: 260 }}>
        {job.lastError ?? <span style={{ color: 'var(--muted)' }}>—</span>}
      </td>
      <td>
        <div className="actions">
          {editable && canWrite && (
            <>
              <button className="secondary small" disabled={busy} onClick={() => setWhenOpen(!whenOpen)}>
                Reagendar
              </button>
              <button className="secondary small" disabled={busy} onClick={sendNow}>
                Enviar agora
              </button>
            </>
          )}
          {job.releaseIdMissing && canWrite && (
            <button className="secondary small" disabled={busy} onClick={reconcile}>
              {busy ? <span className="spinner" /> : 'Reconciliar'}
            </button>
          )}
          {job.releaseIdMissing && !canWrite && (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>somente owner/admin</span>
          )}
        </div>
        {whenOpen && (
          <form onSubmit={reschedule} style={{ marginTop: 6 }}>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              required
            />
            <button type="submit" className="small" disabled={busy || when === ''} style={{ marginTop: 4 }}>
              {busy ? <span className="spinner" /> : 'Confirmar'}
            </button>
            <div className="hint">O backend exige UTC; o painel converte o horário local.</div>
          </form>
        )}
        {outcome && <div className="hint" style={{ marginTop: 4 }}>{outcome}</div>}
        {error && (
          <div className="alert error" style={{ marginTop: 6, marginBottom: 0, fontSize: 12 }}>
            {error}
          </div>
        )}
      </td>
    </tr>
  );
};
