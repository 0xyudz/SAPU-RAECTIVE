"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import type { Address } from "@/domain/burner-route";
import {
  adoptBurner,
  createBurner,
  forgetBurner,
  getServerVaultSnapshot,
  getVaultSnapshot,
  purgeAll,
  revealSecret,
  subscribeVault,
  type BurnerHandle,
} from "@/infrastructure/ephemeral-key-vault";
import { deriveBurnerFromWallet } from "@/infrastructure/burner-derivation";

export interface BurnerVault {
  readonly mounted: boolean;
  readonly burners: readonly BurnerHandle[];
  readonly selected: Address | null;
  readonly select: (address: Address) => void;
  readonly create: () => Address;
  /**
   * Derives a burner from a wallet signature, so it can be rebuilt after a reload.
   * Rejects rather than returning null: a failed derivation is not an empty vault.
   */
  readonly derive: (index: number) => Promise<Address>;
  /** Restores a burner from a backup the user holds. */
  readonly adopt: (params: { privateKey: `0x${string}`; address?: Address }) => Address;
  readonly forget: (address: Address) => void;
  readonly purge: () => void;
  readonly keyFor: (address: Address) => `0x${string}` | null;
  readonly hasKeyFor: (address: Address) => boolean;
}

export function useBurnerVault(): BurnerVault {
  const mounted = useSyncExternalStore(
    subscribeVault,
    () => true,
    () => false,
  );
  const burners = useSyncExternalStore(subscribeVault, getVaultSnapshot, getServerVaultSnapshot);
  const [picked, setPicked] = useState<Address | null>(null);

  const selected =
    picked !== null && burners.some((burner) => burner.address === picked)
      ? picked
      : (burners[0]?.address ?? null);

  const keyFor = useCallback((address: Address): `0x${string}` | null => {
    try {
      return revealSecret(address).privateKey;
    } catch {
      return null;
    }
  }, []);

  const hasKeyFor = useCallback(
    (address: Address): boolean => burners.some((burner) => burner.address === address),
    [burners],
  );

  const create = useCallback((): Address => {
    const burner = createBurner();
    setPicked(burner.address);
    return burner.address;
  }, []);

  const derive = useCallback(async (index: number): Promise<Address> => {
    const derived = await deriveBurnerFromWallet(index);
    const handle = adoptBurner({
      privateKey: derived.privateKey,
      address: derived.address,
      label: `burner-derived-${String(index + 1).padStart(2, "0")}`,
    });
    setPicked(handle.address);
    return handle.address;
  }, []);

  const adopt = useCallback(
    (params: { privateKey: `0x${string}`; address?: Address }): Address => {
      const handle = adoptBurner(params);
      setPicked(handle.address);
      return handle.address;
    },
    [],
  );

  const forget = useCallback((address: Address) => {
    forgetBurner(address);
    setPicked((current) => (current === address ? null : current));
  }, []);

  const purge = useCallback(() => {
    purgeAll();
    setPicked(null);
  }, []);

  return {
    mounted,
    burners,
    selected,
    select: setPicked,
    create,
    derive,
    adopt,
    forget,
    purge,
    keyFor,
    hasKeyFor,
  };
}
