/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional build-time Reown project ID for WalletConnect. */
  readonly VITE_WC_PROJECT_ID?: string;
}

interface Window {
  ethereum?: {
    request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
    on?: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
    isMetaMask?: boolean;
  };
}
