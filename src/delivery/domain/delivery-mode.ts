/**
 * How much of its protection AIR can lean on the hosting platform for
 * (ADR-0016). Standard needs branch rules; lite runs where the platform
 * offers none, for example a private repository on GitHub Free.
 */
export const DeliveryMode = {
  Standard: "standard",
  Lite: "lite",
} as const;
export type DeliveryMode = (typeof DeliveryMode)[keyof typeof DeliveryMode];

const modes: readonly string[] = Object.values(DeliveryMode);

export class DeliveryModes {
  /** Standard when unset; anything else that is not a mode is an error. */
  static parse(raw: string | undefined): DeliveryMode {
    const value = (raw ?? "").trim();
    if (value === "") return DeliveryMode.Standard;
    if (!modes.includes(value))
      throw new Error(`Invalid AIR_MODE: ${value}; use ${modes.join(" or ")}`);
    return value as DeliveryMode;
  }
}
