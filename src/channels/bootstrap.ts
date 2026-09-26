import { createPostizAdapter } from './postiz.adapter';
import { createTelegramAdapter } from './telegram.adapter';
import { createWhatsappAdapter } from './whatsapp.adapter';
import { registerAdapter } from './registry';
import { POSTIZ_BRIDGED_NETWORKS } from '../domain/networks';

export { POSTIZ_BRIDGED_NETWORKS };

let bootstrapped = false;

export const bootstrapAdapters = (): void => {
  if (bootstrapped) {
    return;
  }
  for (const network of POSTIZ_BRIDGED_NETWORKS) {
    registerAdapter(createPostizAdapter(network));
  }
  registerAdapter(createTelegramAdapter());
  registerAdapter(createWhatsappAdapter());
  bootstrapped = true;
};
