import type { PostizMediaFile } from './types';

const cache = new Map<string, PostizMediaFile>();
const inFlight = new Map<string, Promise<PostizMediaFile>>();

export const resolveMediaAsset = async (
  tenantId: string,
  apiKey: string,
  url: string,
  upload: (apiKey: string, url: string) => Promise<PostizMediaFile>
): Promise<PostizMediaFile> => {
  const key = `${tenantId}:${url}`;

  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending;
  }

  const promise = upload(apiKey, url)
    .then((file) => {
      cache.set(key, file);
      inFlight.delete(key);
      return file;
    })
    .catch((error) => {
      inFlight.delete(key);
      throw error;
    });

  inFlight.set(key, promise);
  return promise;
};

export const mediaCacheSize = (): number => cache.size;

export const clearMediaCache = (): void => {
  cache.clear();
  inFlight.clear();
};
