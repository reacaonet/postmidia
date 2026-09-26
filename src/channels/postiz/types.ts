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
