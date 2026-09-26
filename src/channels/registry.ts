import type { ChannelAdapter } from './adapter';
import { NETWORK_SPECS, type Network } from '../domain/networks';

const registry = new Map<Network, ChannelAdapter>();

export const registerAdapter = (adapter: ChannelAdapter): void => {
  if (registry.has(adapter.network)) {
    throw new Error(`Adapter ja registrado para ${adapter.network}`);
  }
  registry.set(adapter.network, adapter);
};

export const resolveAdapter = (network: Network): ChannelAdapter => {
  const adapter = registry.get(network);
  if (!adapter) {
    const available = [...registry.keys()].join(', ') || 'nenhum';
    throw new Error(`Nenhum adapter registrado para ${network}. Disponiveis: ${available}`);
  }
  return adapter;
};

export const hasAdapter = (network: Network): boolean => registry.has(network);

export const listRegisteredNetworks = (): Network[] => [...registry.keys()];

export const describeCapabilities = () =>
  listRegisteredNetworks().map((network) => ({
    network,
    label: NETWORK_SPECS[network].label,
    capabilities: resolveAdapter(network).capabilities,
  }));
