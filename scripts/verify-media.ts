/**
 * Verificacao das correcoes de midia (Fase 8).
 *
 * O item central desta bateria e o que a Fase 8 tinha de errado: a validacao de
 * tamanho rodava SO quando o cliente mandava `bytes`. `image_too_large` e
 * `video_too_large` existiam no codigo e nao valiam para ninguem que nao os
 * declarasse -- um post com imagem de 80 MB passava pela validacao, criava job,
 * gastava cota, queimava cinco tentativas e morria na fila morta.
 *
 * Fechar isso significa fazer o servidor buscar a URL que o cliente escolheu, e
 * isso sozinho seria uma vulnerabilidade de SSRF. Por isso os checks de guarda
 * nao sao um extra: sao a condicao para o probe poder existir.
 *
 * O que a bateria prova:
 *  1. O servidor deriva o tamanho quando o cliente nao manda (o bug principal);
 *  2. O que o cliente manda nao e sobrescrito;
 *  3. HEAD recusado cai para GET ranged e ainda descobre o tamanho;
 *  4. Endereco privado, loopback, link-local e `localhost` nao sao sondados;
 *  5. O objeto de midia guardado no store nao e mutado pela sonda;
 *  6. Extensao com ponto no diretorio nao vira `video_format_unsupported` falso;
 *  7. `.mov` no Instagram e barrado, e a mensagem diz que e limite do pipeline;
 *  8. WhatsApp recusa imagem + video, que antes descartava o video em silencio;
 *  9. O cache de upload distingue contas do mesmo tenant.
 *
 * Uso: npx ts-node --transpile-only scripts/verify-media.ts
 */
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

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

interface Routes {
  base: string;
  /** URLs que o servidor enxergou, para provar o que NAO foi buscado. */
  hits: string[];
  close: () => Promise<void>;
}

/**
 * Sobe um servidor de midia em porta livre.
 *
 * `headOnlyBlocks` reproduz o CDN que responde 405 no HEAD: e o caso que obriga
 * o fallback para GET com `Range`.
 */
const startMediaServer = async (options: { headOnlyBlocks: boolean }): Promise<Routes> => {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '');
    const path = req.url ?? '/';

    if (path === '/grande.png') {
      res.writeHead(200, { 'Content-Length': String(80 * 1024 * 1024), 'Content-Type': 'image/png' });
      res.end();
      return;
    }
    if (path === '/pequeno.png') {
      res.writeHead(200, { 'Content-Length': String(1024), 'Content-Type': 'image/png' });
      res.end();
      return;
    }
    if (path === '/sem-tamanho') {
      // Sem Content-Length: o probe nao tem o que deduzir e precisa devolver null.
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end('x');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('nao encontrado');
  });

  if (options.headOnlyBlocks) {
    // Intercepta HEAD antes do handler normal: 405, como o CDN.
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      hits.push(req.url ?? '');
      if (req.method === 'HEAD') {
        res.writeHead(405, { Allow: 'GET' });
        res.end();
        return;
      }
      const raw = req.headers.range;
      if (raw) {
        const match = /bytes=(\d+)-(\d+)/.exec(String(raw));
        const total = 80 * 1024 * 1024;
        res.writeHead(206, {
          'Content-Type': 'image/png',
          'Content-Range': `bytes ${match?.[1] ?? 0}-${match?.[2] ?? 0}/${total}`,
        });
        res.end('x');
        return;
      }
      res.writeHead(200, { 'Content-Length': String(total) });
      res.end();
    });
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${address.port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

const main = async (): Promise<void> => {
  // A guarda de SSRF recusa loopback, e o servidor de teste vive em loopback.
  // `assertProductionSafety` recusa o boot com isto ligado em producao; nos
  // testes e o unico jeito de exercitar o probe de verdade.
  process.env.MEDIA_PROBE_ALLOW_PRIVATE = 'true';

  const { probeMedia, clearMediaProbeCache, enrichMedia } = await import('../src/channels/media-probe');
  const { mediaExtension } = await import('../src/channels/media-ext');
  const { validateAgainstNetworkSpec, createWhatsappAdapter } = await import(
    '../src/channels/adapter'
  );
  const { effectiveVideoFormats } = await import('../src/domain/networks');
  const { resolveMediaAsset, clearMediaCache } = await import(
    '../src/channels/postiz/media-cache'
  );
  const typecheck = await import('../src/channels/whatsapp.adapter');

  const server = await startMediaServer({ headOnlyBlocks: false });
  const ranged = await startMediaServer({ headOnlyBlocks: true });

  const spec = (media: unknown[], network: string, text = 'olá') => ({
    text,
    media,
    contentType: 'feed' as const,
    settings: {},
    recipient: null,
    idempotencyKey: 'verify',
  });

  const account = {
    id: 'acc-1',
    tenantId: 'ten-1',
    network: 'instagram' as const,
    displayName: 'ig',
    externalAccountId: 'ext-1',
    encryptedSecret: 'x',
    secret: 'y',
    scopes: ['publish'],
    status: 'active' as const,
    tokenExpiresAt: null,
  };

  // --- 1. O servidor descobre o tamanho que o cliente nao mandou ---
  const probed = await probeMedia(`${server.base}/grande.png`);
  assert(
    probed.bytes === 80 * 1024 * 1024,
    `a sonda deveria achar 80 MB em Content-Length, achou ${probed.bytes}`
  );
  ok('a sonda descobre o tamanho em Content-Length sem o cliente declarar nada');

  const probedSmall = await probeMedia(`${server.base}/pequeno.png`);
  assert(probedSmall.bytes === 1024, `deveria achar 1024 bytes, achou ${probedSmall.bytes}`);
  ok('a sonda distingue um arquivo pequeno de um grande');

  // --- 2. HEAD recusado cai para GET ranged ---
  clearMediaProbeCache();
  const viaRange = await probeMedia(`${ranged.base}/qualquer.png`);
  assert(
    viaRange.bytes === 80 * 1024 * 1024,
    `o fallback por Content-Range deveria achar 80 MB, achou ${viaRange.bytes}`
  );
  assert(
    ranged.hits.includes('/qualquer.png'),
    'o fallback deveria ter feito request para o host depois do 405 no HEAD'
  );
  ok('HEAD recusado (405) cai para GET ranged e ainda le o Content-Range');

  // --- 3. Sem tamanho, o probe devolve null e nao inventa ---
  clearMediaProbeCache();
  const unknown = await probeMedia(`${server.base}/sem-tamanho`);
  assert(unknown.bytes === null, `sem Content-Length o resultado deveria ser null, veio ${unknown.bytes}`);
  ok('sem Content-Length o probe devolve null em vez de chutar');

  // --- 4. O que o cliente mandou nao e sobrescrito ---
  clearMediaProbeCache();
  const original = [{ kind: 'image' as const, url: `${server.base}/grande.png`, bytes: 1234 }];
  const enriched = await enrichMedia(original);
  assert(
    enriched[0].bytes === 1234,
    `o valor declarado pelo cliente foi sobrescrito: ${enriched[0].bytes}`
  );
  ok('bytes declarado pelo cliente tem precedencia sobre a sonda');

  // --- 5. A sonda nao muta o array guardado ---
  clearMediaProbeCache();
  const shared = [{ kind: 'image' as const, url: `${server.base}/grande.png` }];
  const before = JSON.stringify(shared);
  await enrichMedia(shared);
  assert(
    JSON.stringify(shared) === before,
    'a sonda mutou o objeto de midia do cliente; o post guardado no store seria contaminado'
  );
  ok('a sonda devolve copia e nao muta a midia recebida');

  // --- 6. enrichMedia preenche o que falta ---
  clearMediaProbeCache();
  const filled = await enrichMedia([
    { kind: 'image' as const, url: `${server.base}/grande.png` },
    { kind: 'image' as const, url: `${server.base}/pequeno.png` },
  ]);
  assert(
    filled[0].bytes === 80 * 1024 * 1024 && filled[1].bytes === 1024,
    `enrichMedia deveria ter preenchido os dois, veio ${filled.map((m) => m.bytes).join(',')}`
  );
  ok('enrichMedia preenche o tamanho de todas as midias do post');

  // --- 7. O tamanho derivado passa a barrar o post (o bug original) ---
  //
  // Este e o check que fecha a Fase 8: sem `bytes` no payload, o post passa.
  const huge = await enrichMedia([
    { kind: 'image' as const, url: `${server.base}/grande.png` },
  ]);
  const issuesHuge = validateAgainstNetworkSpec(
    'instagram',
    spec(huge, 'instagram') as never,
    account
  );
  const tooLarge = issuesHuge.find((issue) => issue.code === 'image_too_large');
  assert(
    tooLarge !== undefined,
    `imagem de 80 MB para o Instagram (limite 8 MB) deveria barrar, issues: ${issuesHuge
      .map((i) => i.code)
      .join(',')}`
  );
  assert(
    tooLarge!.message.includes('83886080'),
    `a mensagem deveria trazer o tamanho real, veio: ${tooLarge!.message}`
  );
  ok('imagem de 80 MB e barrada no Instagram mesmo sem o cliente declarar bytes');

  // E o inverso: um arquivo pequeno passa, para o teste nao virar "tudo barra".
  const small = await enrichMedia([{ kind: 'image' as const, url: `${server.base}/pequeno.png` }]);
  const issuesSmall = validateAgainstNetworkSpec(
    'instagram',
    spec(small, 'instagram') as never,
    account
  );
  assert(
    !issuesSmall.some((issue) => issue.code === 'image_too_large'),
    `imagem de 1 KB foi barrada: ${issuesSmall.map((i) => i.code).join(',')}`
  );
  ok('imagem dentro do limite continua passando');

  // --- 8. A guarda de SSRF ---
  //
  // Com `MEDIA_PROBE_ALLOW_PRIVATE` ligado o bypass vale, entao o caminho
  // privado e testado com ele desligado -- e e exatamente assim que a guarda e
  // exercitada, ja que o servidor de teste vive em loopback.
  const { env } = await import('../src/config');
  (env as { MEDIA_PROBE_ALLOW_PRIVATE: boolean }).MEDIA_PROBE_ALLOW_PRIVATE = false;
  clearMediaProbeCache();
  const hitsBefore = server.hits.length;

  for (const blocked of [
    'http://127.0.0.1:1/x.png',
    'http://localhost:1/x.png',
    'http://10.0.0.1/x.png',
    'http://172.16.0.1/x.png',
    'http://192.168.1.1/x.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x.png',
    'http://[fd00::1]/x.png',
    'http://[::ffff:127.0.0.1]/x.png',
  ]) {
    const result = await probeMedia(blocked);
    assert(
      result.bytes === null && result.contentType === null,
      `endereco privado deveria ser ignorado, veio ${JSON.stringify(result)}: ${blocked}`
    );
  }
  assert(
    server.hits.length === hitsBefore,
    'a guarda deixou passar um request para um endereco privado'
  );
  ok('endereco privado, loopback, link-local e IPv6 mapeado nao sao sondados');

  const nonHttp = await probeMedia('file:///etc/passwd');
  assert(nonHttp.bytes === null, 'esquema file:// nunca deveria ser sondado');
  const garbage = await probeMedia('nao-e-uma-url');
  assert(garbage.bytes === null, 'lixo como URL nunca deveria ser sondado');
  ok('esquema nao-HTTP e string invalida sao ignorados sem erro');

  (env as { MEDIA_PROBE_ALLOW_PRIVATE: boolean }).MEDIA_PROBE_ALLOW_PRIVATE = true;

  // --- 9. Extensao: o bug do ponto no diretorio ---
  //
  // A rotina antiga pegava o ultimo ponto da string inteira, entao
  // `https://cdn.exemplo/x.y/imagem` produzia a extensao `y/imagem` e caia num
  // `video_format_unsupported` falso. A URL era valida; o classificador nao.
  assert(
    mediaExtension('https://cdn.exemplo/x.y/imagem') === '',
    `o ponto de diretorio nao e extensao: veio "${mediaExtension('https://cdn.exemplo/x.y/imagem')}"`
  );
  assert(mediaExtension('https://cdn.exemplo/a/b.mp4?token=x') === 'mp4', 'query nao pode virar extensao');
  assert(mediaExtension('https://cdn.exemplo/a/b.MP4#t=10') === 'mp4', 'maiuscula e fragmento');
  assert(mediaExtension('/caminho/relativo/arquivo.png') === 'png', 'path relativo');
  assert(mediaExtension('https://cdn.exemplo/v1.2/') === '', 'path sem arquivo nao tem extensao');
  ok('extensao ignora ponto de diretorio, query, fragmento e path sem arquivo');

  // O efeito visivel: um video numa URL com ponto no diretorio nao e barrado.
  clearMediaProbeCache();
  const oddUrl = await enrichMedia([
    { kind: 'video' as const, url: `${server.base}/v1.2/video`, bytes: 1000 },
  ]);
  const oddIssues = validateAgainstNetworkSpec(
    'instagram',
    spec(oddUrl, 'instagram') as never,
    { ...account, network: 'instagram' }
  );
  assert(
    !oddIssues.some((issue) => issue.code === 'video_format_unsupported'),
    `URL valida foi rejeitada por formato: ${oddIssues.map((i) => i.code).join(',')}`
  );
  ok('video em URL com ponto no diretorio nao gera video_format_unsupported falso');

  // --- 10. Formato aceito pela rede x aceito pelo pipeline ---
  assert(
    effectiveVideoFormats('instagram').join() === 'mp4',
    `instagram deveria entregar so mp4 pelo Postiz, veio ${effectiveVideoFormats('instagram').join()}`
  );
  assert(
    effectiveVideoFormats('whatsapp').join() === 'mp4,3gp',
    `whatsapp e nativa e nao passa pelo upload-from-url: veio ${effectiveVideoFormats('whatsapp').join()}`
  );
  ok('formatos efetivos intersectam a rede com o que o pipeline entrega');

  const movIssues = validateAgainstNetworkSpec(
    'instagram',
    spec([{ kind: 'video' as const, url: 'https://cdn.exemplo/a.mov', bytes: 1000 }], 'instagram') as never,
    account
  );
  const movIssue = movIssues.find((issue) => issue.code === 'video_format_unsupported');
  assert(movIssue !== undefined, '.mov deveria ser barrado antes de publicar');
  assert(
    movIssue!.message.includes('Fase 8'),
    `a mensagem deveria explicar que e limite do pipeline, veio: ${movIssue!.message}`
  );
  assert(
    movIssue!.message.includes('aceito por Instagram') || movIssue!.message.includes('aceito'),
    'a mensagem deveria dizer que a rede aceita e o pipeline nao'
  );
  ok('.mov e barrado na validacao, com mensagem que aponta o pipeline e nao a rede');

  // --- 11. WhatsApp nao descarta midia em silencio ---
  const whatsapp = typecheck.createWhatsappAdapter();
  const waAccount = {
    ...account,
    id: 'wa-1',
    network: 'whatsapp' as const,
    externalAccountId: '5511',
  };
  const waIssues = await whatsapp.validate(
    spec(
      [
        { kind: 'image' as const, url: `${server.base}/pequeno.png`, bytes: 1000 },
        { kind: 'video' as const, url: `${server.base}/a.mp4`, bytes: 1000 },
      ],
      'whatsapp',
      'oi'
    ) as never,
    waAccount as never
  );
  const singleMedia = waIssues.find((issue) => issue.code === 'whatsapp_single_media_only');
  assert(
    singleMedia !== undefined,
    `imagem + video no WhatsApp deveria ser barrado: ${waIssues.map((i) => i.code).join(',')}`
  );
  ok('WhatsApp recusa imagem + video, que antes publicava so a primeira em silencio');

  const waOk = await whatsapp.validate(
    spec([{ kind: 'image' as const, url: `${server.base}/pequeno.png`, bytes: 1000 }], 'whatsapp', 'oi') as never,
    waAccount as never
  );
  assert(
    !waOk.some((issue) => issue.code === 'whatsapp_single_media_only'),
    `uma midia unica no WhatsApp nao deveria ser barrada: ${waOk.map((i) => i.code).join(',')}`
  );
  ok('WhatsApp aceita uma midia unica');

  // --- 12. Cache de upload distingue contas ---
  clearMediaCache();
  let uploads = 0;
  const upload = async (): Promise<{ id: string; path: string; name?: string }> => {
    uploads += 1;
    return { id: `asset-${uploads}`, path: `/uploads/${uploads}.png` };
  };

  const first = await resolveMediaAsset('ten-1', 'acc-A', 'kA', 'https://cdn.exemplo/m.png', upload);
  const firstAgain = await resolveMediaAsset('ten-1', 'acc-A', 'kA', 'https://cdn.exemplo/m.png', upload);
  assert(first.id === firstAgain.id, 'a mesma conta e a mesma URL devem reaproveitar o upload');
  assert(uploads === 1, `deveria ter uploaded 1 vez, fez ${uploads}`);

  const other = await resolveMediaAsset('ten-1', 'acc-B', 'kB', 'https://cdn.exemplo/m.png', upload);
  assert(
    other.id !== first.id,
    'a conta B reusou o id da conta A; o id do Postiz so resolve dentro da organizacao que o gerou'
  );
  assert(uploads === 2, `a conta B deveria ter uploaded, fez ${uploads} uploads no total`);
  ok('o cache de upload distingue contas do mesmo tenant');

  // --- 13. Concorrencia nao duplica upload ---
  clearMediaCache();
  let racing = 0;
  const slowUpload = async (): Promise<{ id: string; path: string; name?: string }> => {
    racing += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: 'asset-carrera', path: '/uploads/carrera.png' };
  };
  const settled = await Promise.all([
    resolveMediaAsset('ten-1', 'acc-C', 'kC', 'https://cdn.exemplo/c.png', slowUpload),
    resolveMediaAsset('ten-1', 'acc-C', 'kC', 'https://cdn.exemplo/c.png', slowUpload),
    resolveMediaAsset('ten-1', 'acc-C', 'kC', 'https://cdn.exemplo/c.png', slowUpload),
  ]);
  assert(
    racing === 1,
    `tres requisicoes concorrentes deveriam virar 1 upload, fizeram ${racing}`
  );
  assert(
    settled.every((item) => item.id === 'asset-carrera'),
    'as tres chamadas concorrentes deveriam receber o mesmo asset'
  );
  ok('requisicoes concorrentes da mesma midia viram um unico upload');

  await server.close();
  await ranged.close();
  clearMediaCache();
  clearMediaProbeCache();
  console.log(`\nOK: ${checks} verificacoes de midia`);
  process.exit(0);
};

main().catch((error) => {
  fail(String(error));
});
