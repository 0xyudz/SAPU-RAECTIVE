"use client";

import type { ReactNode } from "react";
import { INPUT_CLASS } from "./primitives";
import { shortAddress } from "./short-value";
import {
  CUSTOM_TOKEN_VALUE,
  tokenChoiceLabel,
  type TokenChoice,
} from "@/domain/token-choices";

/**
 * The token field: a select of known assets plus an explicit "other" option.
 *
 * ## Why a picker instead of a raw address box
 *
 * The contract accepts any ERC-20, so the field has to accept an arbitrary address — but asking
 * an operator to paste a 42-character hex string is how a route gets armed against the wrong
 * asset, or against an address that is not a token at all. The picker makes the common case a
 * single click and labels each option with the `symbol()`/`decimals()` read from that contract.
 *
 * ## Why it is not a closed dropdown
 *
 * A new asset is precisely one that has never been routed, so it cannot be in a list built from
 * on-chain history. `CUSTOM_TOKEN_VALUE` keeps the free-text path reachable.
 *
 * ## Why the mode is derived and not stored
 *
 * Which control is shown follows from the value alone: a value that matches an option renders
 * the select, anything else renders the address input. Choosing "Other" therefore clears the
 * value, which is what makes the input appear — and because nothing is cached in component
 * state, a value that arrives later from the registry (the configured token resolving, or the
 * first poll landing) switches to the select on its own instead of being pinned to the mode it
 * happened to be in at mount.
 */
export function TokenPicker({
  id,
  value,
  choices,
  onChange,
  hint,
  disabled,
}: {
  id: string;
  value: string;
  choices: readonly TokenChoice[];
  onChange: (value: string) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const known = choices.find((choice) => choice.address.toLowerCase() === value.toLowerCase());
  const isCustom = known === undefined;

  return (
    <>
      <label className="label-caps mt-4 block" htmlFor={id}>
        Token
      </label>
      <select
        id={id}
        value={isCustom ? CUSTOM_TOKEN_VALUE : known.address}
        disabled={disabled}
        onChange={(event) => {
          const next = event.target.value;
          // Clearing the value is what puts the field into custom mode. It costs nothing here:
          // the select only shows "Other" while the current value is *not* one of the options,
          // so there is no typed address to lose at this moment.
          onChange(next === CUSTOM_TOKEN_VALUE ? "" : next);
        }}
        className={INPUT_CLASS}
      >
        {choices.map((choice) => (
          <option key={choice.address} value={choice.address}>
            {tokenChoiceLabel(choice)} — {shortAddress(choice.address)}
            {choice.source === "configured" ? " (default)" : ""}
          </option>
        ))}
        <option value={CUSTOM_TOKEN_VALUE}>Other ERC-20 — type the address…</option>
      </select>

      {isCustom && (
        <input
          id={`${id}-custom`}
          aria-label="Token contract address"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0x…"
          spellCheck={false}
          className={INPUT_CLASS}
        />
      )}

      {hint && <p className="mt-1 font-mono text-[10px] text-slate-600">{hint}</p>}
    </>
  );
}
