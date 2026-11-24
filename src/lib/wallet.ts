/**
 * Injected-wallet (MetaMask / Rabby) connection via EIP-1193 + viem.
 * No private keys are ever handled here — signing happens in the user's wallet.
 */
import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, type Address, type WalletClient } from "viem";
import { CHAIN_ID, GIWA_SEPOLIA, EXPLORER_URL, getRpcUrls } from "./giwa";
import { describeWalletError, withWalletTimeout } from "./walletError";
import {
  connectWalletConnect as connectWC,
  disconnectWalletConnect,
  getWcProvider,
} from "./walletconnect";

export type WalletState = {
  address: Address | null;
  chainId: number | null;
  isConnected: boolean;
  isCorrectChain: boolean;
  hasProvider: boolean;
  connectionType: "injected" | "walletconnect" | null;
};

const initialState: WalletState = {
  address: null,
  chainId: null,
  isConnected: false,
  isCorrectChain: false,
  hasProvider: typeof window !== "undefined" && Boolean(window.ethereum),
  connectionType: null,
};

export function getWalletClient(address: Address): WalletClient {
  const wc = getWcProvider();
  if (wc) {
    return createWalletClient({
      account: address,
      chain: GIWA_SEPOLIA,
      transport: custom(wc as never),
    });
  }
  if (!window.ethereum) throw new Error("No injected wallet found");
  return createWalletClient({
    account: address,
    chain: GIWA_SEPOLIA,
    transport: custom(window.ethereum),
  });
}

export function useWallet() {
  const [state, setState] = useState<WalletState>(initialState);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (getWcProvider()) return; // WalletConnect session owns the state
    if (!window.ethereum) return;
    try {
      const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
      const chainHex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
      const chainId = Number.parseInt(chainHex, 16);
      const address = accounts.length > 0 ? (accounts[0] as Address) : null;
      setState({
        address,
        chainId,
        isConnected: address !== null,
        isCorrectChain: chainId === CHAIN_ID,
        hasProvider: true,
        connectionType: address !== null ? "injected" : null,
      });
    } catch {
      // Provider unreadable; keep previous state.
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!window.ethereum?.on) return;
    const onAccounts = (...args: unknown[]) => {
      if (getWcProvider()) return; // WalletConnect session owns the account
      const accounts = args[0] as string[];
      setState((s) => ({
        ...s,
        address: accounts.length > 0 ? (accounts[0] as Address) : null,
        isConnected: accounts.length > 0,
      }));
    };
    const onChain = (...args: unknown[]) => {
      if (getWcProvider()) return;
      const chainId = Number.parseInt(args[0] as string, 16);
      setState((s) => ({ ...s, chainId, isCorrectChain: chainId === CHAIN_ID }));
    };
    window.ethereum.on("accountsChanged", onAccounts);
    window.ethereum.on("chainChanged", onChain);
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", onAccounts);
      window.ethereum?.removeListener?.("chainChanged", onChain);
    };
  }, [refresh]);

  const switchChain = useCallback(async () => {
    if (!window.ethereum) throw new Error("No injected wallet found");
    const chainHex = `0x${CHAIN_ID.toString(16)}`;
    try {
      // The chain-switch prompt can hang like any wallet request (popup
      // never appears) — fail visibly instead of hanging forever.
      await withWalletTimeout(
        window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chainHex }],
        }),
      );
    } catch (e) {
      const err = e as { code?: number };
      if (err.code === 4902) {
        await withWalletTimeout(
          window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: chainHex,
                chainName: "GIWA Sepolia",
                nativeCurrency: { name: "GIWA Sepolia ETH", symbol: "ETH", decimals: 18 },
                rpcUrls: getRpcUrls(),
                blockExplorerUrls: [EXPLORER_URL],
              },
            ],
          }),
        );
      } else {
        throw e;
      }
    }
    await refresh();
  }, [refresh]);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError("No injected wallet found. Install MetaMask or Rabby and try again.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      await withWalletTimeout(window.ethereum.request({ method: "eth_requestAccounts" }));
      await refresh();
      await switchChain();
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setConnecting(false);
    }
  }, [refresh, switchChain]);

  const handleWcDisconnect = useCallback(() => {
    void disconnectWalletConnect();
    setState((s) => ({ ...s, address: null, isConnected: false, connectionType: null }));
  }, []);

  const connectWalletConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const address = await connectWC();
      setState((s) => ({
        ...s,
        address,
        chainId: CHAIN_ID,
        isConnected: true,
        isCorrectChain: true,
        connectionType: "walletconnect",
      }));
      getWcProvider()?.on("disconnect", handleWcDisconnect);
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setConnecting(false);
    }
  }, [handleWcDisconnect]);

  const disconnect = useCallback(() => {
    if (getWcProvider()) void disconnectWalletConnect();
    setState((s) => ({ ...s, address: null, isConnected: false, connectionType: null }));
  }, []);

  return { ...state, connecting, error, connect, connectWalletConnect, disconnect, switchChain, refresh };
}
