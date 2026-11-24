/** Local persistence: my launches/configs + cached launch discovery. No secrets stored. */
import type { LaunchRecord } from "./ammora";

export type MyLaunch = {
  token: string;
  curve: string;
  configId: string;
  name: string;
  symbol: string;
  txHash: string;
  blockNumber: string;
  createdAt: number;
  creator: string;
};

export type MyConfig = {
  configId: string;
  configHash: string;
  templateId: string;
  txHash: string;
  blockNumber: string;
  createdAt: number;
  owner: string;
};

export type LaunchCache = {
  launches: LaunchRecord[];
  scannedTo: string;
  factory: string;
  savedAt: number;
};

const KEYS = {
  launches: "kongpad:my-launches",
  configs: "kongpad:my-configs",
  discovery: "kongpad:discovery-v1",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable — the app still works without persistence.
  }
}

export const loadMyLaunches = (): MyLaunch[] => read<MyLaunch[]>(KEYS.launches, []);
export const loadMyConfigs = (): MyConfig[] => read<MyConfig[]>(KEYS.configs, []);

export function saveMyLaunch(launch: MyLaunch): MyLaunch[] {
  const list = loadMyLaunches().filter((l) => l.curve.toLowerCase() !== launch.curve.toLowerCase());
  list.unshift(launch);
  write(KEYS.launches, list);
  return list;
}

export function saveMyConfig(config: MyConfig): MyConfig[] {
  const list = loadMyConfigs().filter((c) => c.configId !== config.configId);
  list.unshift(config);
  write(KEYS.configs, list);
  return list;
}

export function loadLaunchCache(factory: string): LaunchCache | null {
  const cache = read<LaunchCache | null>(KEYS.discovery, null);
  if (!cache || cache.factory.toLowerCase() !== factory.toLowerCase()) return null;
  return {
    ...cache,
    launches: cache.launches.map((l) => ({
      ...l,
      configId: BigInt(l.configId as unknown as string),
      blockNumber: BigInt(l.blockNumber as unknown as string),
    })),
  };
}

export function saveLaunchCache(cache: LaunchCache): void {
  write(KEYS.discovery, {
    ...cache,
    launches: cache.launches.map((l) => ({
      ...l,
      configId: l.configId.toString(),
      blockNumber: l.blockNumber.toString(),
    })),
  });
}

export function clearLaunchCache(): void {
  try {
    localStorage.removeItem(KEYS.discovery);
  } catch {
    // ignore
  }
}
