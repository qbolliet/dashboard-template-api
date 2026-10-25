// Importation des modules
import { tracingChannel } from 'node:diagnostics_channel';
import type { TracingChannelSubscribers } from 'node:diagnostics_channel';
import type { GraphQLChannelContextByName, GraphQLResolveContext } from 'graphql';

// ─── Interfaces ──────────────────────────────────────────────────────────────

/** Phases of the GraphQL.js pipeline measured through its tracing channels. */
type GraphQLPhase = 'parse' | 'validate' | 'execute';

/** Durations and error count of one phase. */
interface PhaseStats {
  count: number;
  errors: number;
  avgMs: number;
  p95Ms: number;
  samples: number;
}

/** Durations and error count of one resolver (`Type.field`). */
interface ResolverStats {
  field: string;
  count: number;
  errors: number;
  avgMs: number;
  maxMs: number;
}

/** Snapshot published by the /metrics endpoint. */
interface GraphQLTracingSnapshot {
  phases: Record<GraphQLPhase, PhaseStats>;
  /** Slowest custom resolvers by cumulated time; absent when not traced. */
  resolvers?: ResolverStats[];
}

/** Options of the GraphQL tracing. */
interface GraphQLTracingOptions {
  /**
   * Also traces resolvers. GraphQL.js then publishes an event for every field
   * of every response (default resolvers included): to be enabled for a
   * diagnosis rather than permanently on large responses.
   */
  resolvers?: boolean;
  /** Number of durations kept per phase for the percentiles. */
  maxSamples?: number;
  /** Number of resolvers listed in the snapshot. */
  topResolvers?: number;
}

/** Lifecycle fields set by GraphQL.js on a traced context. */
interface TracedContext {
  error?: unknown;
  result?: unknown;
}

/** Running measure of one phase. */
interface PhaseAccumulator {
  count: number;
  errors: number;
  durations: number[];
}

/** Running measure of one resolver. */
interface ResolverAccumulator {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
}

// ─── Mesure des canaux ───────────────────────────────────────────────────────

/**
 * Tells whether a phase ended on an error: thrown by GraphQL.js or returned in
 * its result (validation errors, execution errors).
 *
 * @param context - Context of the traced call, completed by GraphQL.js.
 * @returns True when the call failed.
 */
function hasFailed(context: TracedContext): boolean {
  if (context.error !== undefined) {
    return true;
  }
  const { result } = context;
  if (Array.isArray(result)) {
    return result.length > 0;
  }
  const errors = (result as { errors?: readonly unknown[] } | undefined)?.errors;
  return Array.isArray(errors) && errors.length > 0;
}

/**
 * Builds the subscribers timing one tracing channel.
 *
 * GraphQL.js publishes `start` then `end`; a call returning a promise ends at
 * `asyncEnd`, `end` being then published before any result or error is set
 * on the context.
 *
 * @param onDone - Receives the context and the duration of each finished call.
 * @returns Subscribers to attach to the tracing channel.
 */
function timingSubscribers<TContext extends object>(
  onDone: (context: TContext & TracedContext, durationMs: number) => void,
): TracingChannelSubscribers<TContext> {
  const startedAt = new WeakMap<object, number>();
  const finish = (context: TContext): void => {
    const start = startedAt.get(context);
    if (start === undefined) {
      return;
    }
    startedAt.delete(context);
    onDone(context as TContext & TracedContext, performance.now() - start);
  };

  return {
    start: (context) => {
      startedAt.set(context, performance.now());
    },
    end: (context) => {
      // Appel synchrone terminé : résultat ou erreur déjà posé sur le contexte
      if ('result' in context || 'error' in context) {
        finish(context);
      }
    },
    asyncStart: () => {},
    asyncEnd: finish,
    error: () => {},
  };
}

// ─── Statistiques ────────────────────────────────────────────────────────────

/**
 * Summarises the durations of a phase.
 *
 * @param accumulator - Running measure of the phase.
 * @returns Count, errors, mean and 95th percentile (ms, 2 decimals).
 */
function phaseStats({ count, errors, durations }: PhaseAccumulator): PhaseStats {
  const round = (ms: number): number => Math.round(ms * 100) / 100;
  const sorted = [...durations].sort((a, b) => a - b);
  const avg = sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0;
  const p95 = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.95)] ?? 0) : 0;
  return { count, errors, avgMs: round(avg), p95Ms: round(p95), samples: sorted.length };
}

// ─── Traceur ─────────────────────────────────────────────────────────────────

/**
 * Measures the GraphQL.js pipeline through its `node:diagnostics_channel`
 * tracing channels (graphql 17): durations of parse, validate and execute,
 * and optionally of the custom resolvers.
 *
 * The channels are published by GraphQL.js itself, whatever the server
 * calling it (Apollo Server here): no plugin is involved.
 */
class GraphQLTracing {
  private readonly options: Required<GraphQLTracingOptions>;
  private readonly phases: Record<GraphQLPhase, PhaseAccumulator>;
  private readonly resolvers = new Map<string, ResolverAccumulator>();
  private readonly unsubscribers: Array<() => void> = [];

  /**
   * @param options - Resolver tracing and size of the kept samples.
   */
  constructor(options: GraphQLTracingOptions = {}) {
    this.options = {
      resolvers: options.resolvers ?? false,
      maxSamples: options.maxSamples ?? 1000,
      topResolvers: options.topResolvers ?? 10,
    };
    const empty = (): PhaseAccumulator => ({ count: 0, errors: 0, durations: [] });
    this.phases = { parse: empty(), validate: empty(), execute: empty() };
  }

  /** Tells whether the tracer is subscribed to the channels. */
  get enabled(): boolean {
    return this.unsubscribers.length > 0;
  }

  /**
   * Subscribes to the tracing channels of GraphQL.js. Idempotent.
   */
  enable(): void {
    if (this.enabled) {
      return;
    }
    for (const phase of ['parse', 'validate', 'execute'] as const) {
      this.subscribe(
        `graphql:${phase}`,
        timingSubscribers<GraphQLChannelContextByName[`graphql:${GraphQLPhase}`]>((context, ms) =>
          this.recordPhase(phase, context, ms),
        ),
      );
    }
    if (this.options.resolvers) {
      this.subscribe(
        'graphql:resolve',
        timingSubscribers<GraphQLResolveContext>((context, ms) => this.recordResolver(context, ms)),
      );
    }
  }

  /**
   * Unsubscribes from every channel; the collected measures are kept.
   */
  disable(): void {
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  }

  /**
   * Returns the current measures.
   *
   * @returns Per-phase statistics and, when traced, the slowest resolvers.
   */
  snapshot(): GraphQLTracingSnapshot {
    const phases = {
      parse: phaseStats(this.phases.parse),
      validate: phaseStats(this.phases.validate),
      execute: phaseStats(this.phases.execute),
    };
    if (!this.options.resolvers) {
      return { phases };
    }
    const round = (ms: number): number => Math.round(ms * 100) / 100;
    const resolvers = [...this.resolvers.entries()]
      .sort(([, a], [, b]) => b.totalMs - a.totalMs)
      .slice(0, this.options.topResolvers)
      .map(([field, { count, errors, totalMs, maxMs }]) => ({
        field,
        count,
        errors,
        avgMs: round(totalMs / count),
        maxMs: round(maxMs),
      }));
    return { phases, resolvers };
  }

  /**
   * Attaches subscribers to a tracing channel, remembering how to detach them.
   *
   * @param name - Name of the GraphQL.js tracing channel.
   * @param subscribers - Subscribers to attach.
   */
  private subscribe<TContext extends object>(
    name: string,
    subscribers: TracingChannelSubscribers<TContext>,
  ): void {
    const channel = tracingChannel<TContext>(name);
    channel.subscribe(subscribers);
    this.unsubscribers.push(() => channel.unsubscribe(subscribers));
  }

  /**
   * Records a finished phase.
   *
   * @param phase - Measured phase.
   * @param context - Context completed by GraphQL.js.
   * @param durationMs - Duration of the call.
   */
  private recordPhase(phase: GraphQLPhase, context: TracedContext, durationMs: number): void {
    const accumulator = this.phases[phase];
    accumulator.count++;
    if (hasFailed(context)) {
      accumulator.errors++;
    }
    accumulator.durations.push(durationMs);
    if (accumulator.durations.length > this.options.maxSamples) {
      accumulator.durations.shift();
    }
  }

  /**
   * Records a finished resolver; default (property-reading) resolvers are
   * ignored.
   *
   * @param context - Context completed by GraphQL.js.
   * @param durationMs - Duration of the resolver.
   */
  private recordResolver(context: GraphQLResolveContext, durationMs: number): void {
    if (context.isDefaultResolver) {
      return;
    }
    const key = `${context.parentType}.${context.fieldName}`;
    const accumulator = this.resolvers.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    accumulator.count++;
    if (context.error !== undefined) {
      accumulator.errors++;
    }
    accumulator.totalMs += durationMs;
    accumulator.maxMs = Math.max(accumulator.maxMs, durationMs);
    this.resolvers.set(key, accumulator);
  }
}

export { GraphQLTracing };
export type { GraphQLTracingOptions, GraphQLTracingSnapshot, PhaseStats, ResolverStats };
