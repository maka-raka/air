import type {
  DeliveryPolicy,
  DeliveryPolicyPort,
} from "../../application/protected-changes.js";

/** A policy fixed when the in-memory stack is composed. */
export class MemoryDeliveryPolicy implements DeliveryPolicyPort {
  constructor(private readonly policy: DeliveryPolicy | null) {}

  async load(): Promise<DeliveryPolicy | null> {
    return this.policy;
  }
}
