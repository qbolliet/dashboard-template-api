// ─── Limitation des exports simultanés ───────────────────────────────────────

/**
 * Concurrency gate of the export endpoint.
 *
 * An export holds a pool connection for its whole duration — up to the export
 * timeout — so the rate limiter, which counts requests, does not bound the
 * load: two exports per client and a global ceiling do. The client key is the
 * IP alone (not IP + User-Agent as for the rate limiter): changing the
 * User-Agent must not open more slots.
 */

/** Why a slot was refused. */
type GateRejection = 'client' | 'total';

/** Outcome of a slot request: a releasable slot, or the reason of the refusal. */
type GateDecision = { ok: true; release: () => void } | { ok: false; reason: GateRejection };

/** Counts in-flight exports per client and overall, against two ceilings. */
class ExportConcurrencyGate {
  private readonly perClient = new Map<string, number>();
  private total = 0;

  /**
   * Creates a gate with the given ceilings.
   *
   * @param maxPerClient - Concurrent exports allowed per client key.
   * @param maxTotal - Concurrent exports allowed across all clients.
   */
  constructor(
    private readonly maxPerClient: number,
    private readonly maxTotal: number,
  ) {}

  /**
   * Takes a slot for the client when both ceilings allow it.
   *
   * The returned `release` is idempotent, so it can be called from every exit
   * path (finally, close event) without ever freeing two slots.
   *
   * @param clientKey - Identifier of the client (its IP).
   * @returns The slot, or the ceiling that refused it.
   */
  tryAcquire(clientKey: string): GateDecision {
    const current = this.perClient.get(clientKey) ?? 0;
    if (current >= this.maxPerClient) return { ok: false, reason: 'client' };
    if (this.total >= this.maxTotal) return { ok: false, reason: 'total' };

    this.perClient.set(clientKey, current + 1);
    this.total++;

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.total--;
      const remaining = (this.perClient.get(clientKey) ?? 1) - 1;
      // Suppression de l'entrée vide : la carte ne grossit pas avec les IPs vues
      if (remaining <= 0) this.perClient.delete(clientKey);
      else this.perClient.set(clientKey, remaining);
    };
    return { ok: true, release };
  }

  /**
   * Returns the number of in-flight exports, for one client or overall.
   *
   * @param clientKey - Client to count; omitted for the global count.
   * @returns The in-flight count.
   */
  activeCount(clientKey?: string): number {
    return clientKey === undefined ? this.total : (this.perClient.get(clientKey) ?? 0);
  }
}

export { ExportConcurrencyGate };
export type { GateDecision, GateRejection };
