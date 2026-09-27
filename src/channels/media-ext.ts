/**
 * Extensao de arquivo a partir da URL da midia.
 *
 * **Por que este modulo existe.** Havia duas rotinas e elas discordavam. A do
 * `adapter.ts` cortava a query e pegava o ultimo ponto da string INTEIRA, entao
 * `https://cdn.exemplo/x.y/imagem` produzia a extensao `y/imagem` e caia num
 * `video_format_unsupported` falso -- a URL estava valendo, o classificador
 * estava errado. A do `client.ts` usava `new URL().pathname` e estava certa,
 * mas nao compartilhava o resultado.
 *
 * Duas URL que passam a dar a mesma resposta em qualquer lugar do codigo:
 *
 * | URL | extensao |
 * |---|---|
 * | `https://cdn.exemplo/x.y/imagem` | `''` (o ponto e de diretorio, nao de arquivo) |
 * | `https://cdn.exemplo/a/b.mp4?token=x` | `mp4` |
 * | `https://cdn.exemplo/a/b.MP4#t=10` | `mp4` |
 * | `/caminho/relativo/arquivo.png` | `png` |
 *
 * `lastDot <= 0` (e nao `=== -1`) trata arquivo sem nome: um path `/v1.2/` tem
 * o ponto na posicao 1 do segmento e nao tem extensao nenhuma.
 */
export const mediaExtension = (url: string): string => {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Nao parseavel como URL absoluta (path relativo, por exemplo).
    pathname = url.split('?')[0].split('#')[0];
  }
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const lastDot = lastSegment.lastIndexOf('.');
  return lastDot <= 0 ? '' : lastSegment.slice(lastDot + 1).toLowerCase();
};
