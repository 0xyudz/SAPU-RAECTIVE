"use client";

import type { ReactNode } from "react";
import { INPUT_CLASS } from "./primitives";
import { shortAddress } from "./short-value";
import {
  CUSTOM_TOKEN_VALUE,
  tokenChoiceLabel,
  tokenPickerMode,
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
  ready,
  onChange,
  hint,
  disabled,
}: {
  id: string;
  value: string;
  choices: readonly TokenChoice[];
  /**
   * Whether the options have been read yet.
   *
   * Required, not defaulted: a caller that forgets it would silently reintroduce the cold-load
   * bug where an empty list is reported as "the operator chose Other ERC-20".
   */
  ready: boolean;
  onChange: (value: string) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const mode = tokenPickerMode(value, choices, ready);
  const known = choices.find((choice) => choice.address.toLowerCase() === value.toLowerCase());

  return (
    <>
      <label className="label-caps mt-4 block" htmlFor={id}>
        Token
      </label>
      <select
        id={id}
        value={mode === "known" ? (known?.address ?? CUSTOM_TOKEN_VALUE) : CUSTOM_TOKEN_VALUE}
        disabled={disabled || mode === "pending"}
        onChange={(event) => {
          const next = event.target.value;
          // Clearing the value is what puts the field into custom mode. It costs nothing here:
          // the select only shows "Other" while the current value is *not* one of the options,
          // so there is no typed address to lose at this moment.
          onChange(next === CUSTOM_TOKEN_VALUE ? "" : next);
        }}
        className={INPUT_CLASS}
      >
        {mode === "pending" && (
          // Not a selectable option: there is no truthful token to offer yet, and an empty
          // dropdown would look like a deployment with no assets rather than one still reading.
          <option value={CUSTOM_TOKEN_VALUE}>reading tokens from the chain…</option>
        )}
        {choices.map((choice) => (
          <option key={choice.address} value={choice.address}>
            {tokenChoiceLabel(choice)} — {shortAddress(choice.address)}
            {choice.source === "configured" ? " (default)" : ""}
          </option>
        ))}
        {mode !== "pending" && (
          <option value={CUSTOM_TOKEN_VALUE}>Other ERC-20 — type the address…</option>
        )}
      </select>

      {mode === "custom" && (
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
