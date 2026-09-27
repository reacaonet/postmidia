export interface PostizMediaFile {
  id: string;
  name: string;
  path: string;
}

export interface PostizContentBlock {
  content: string;
  image: { id: string; path: string }[];
}

export interface PostizPostEntry {
  integration: { id: string };
  value: PostizContentBlock[];
  settings: Record<string, unknown>;
}

export interface PostizCreatePayload {
  type: 'now' | 'schedule';
  date: string;
  shortLink: boolean;
  tags: string[];
  posts: PostizPostEntry[];
}

export interface PostizCreateResponse {
  id?: string;
  posts?: { id: string; releaseId?: string | null }[];
}

export interface PostizIntegrationSettings {
  rules: string;
  maxLength: number | null;
  settings: unknown;
  tools: { methodName: string; description?: string }[];
}

export interface PostizIntegrationSummary {
  id: string;
  name: string;
  provider: string;
  identifier: string | null;
}

/**
 * Conteudo recuperado de um post cujo id o provedor ainda nao tinha devolvido.
 * `id` e o id do post NA REDE, e `url` o permalink -- e o que a reconciliacao
 * grava no job. A lista vem vazia enquanto o provedor nao processou.
 */
export interface PostizMissingContent {
  id: string;
  url: string;
}
