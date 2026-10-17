/**
 * Unit tests of the shutdown sequence (src/shutdown.ts) with fake resources.
 */

import { describe, test, expect, jest, afterEach } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { createShutdown, drainBudgetMs } from '../../../src/shutdown.js';

/**
 * Builds the response double of the guard.
 *
 * @returns The response and what the guard wrote on it.
 */
const fakeResponse = (): {
  res: Response;
  state: { status?: number; body?: unknown; headers: Record<string, string> };
} => {
  const state: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  const res = {
    set: (headers: Record<string, string>) => {
      Object.assign(state.headers, headers);
      return res;
    },
    status: (code: number) => {
      state.status = code;
      return res;
    },
    json: (body: unknown) => {
      state.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, state };
};

describe('createShutdown', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('drains first, then closes the steps in order, then exits 0', async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit,
      beforeDrain: [() => order.push('stop-monitor')],
      drain: async () => {
        order.push('drain');
      },
      steps: [
        { name: 'pool', close: () => order.push('pool') },
        { name: 'redis', close: async () => order.push('redis') },
      ],
    });

    await shutdown.run('SIGTERM');

    expect(order).toEqual(['stop-monitor', 'drain', 'pool', 'redis']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('runs once: a second signal does not restart the sequence', async () => {
    const drain = jest.fn(async () => {});
    const exit = jest.fn();
    const shutdown = createShutdown({ timeoutMs: 1000, exit, drain, steps: [] });

    await Promise.all([shutdown.run('SIGTERM'), shutdown.run('SIGINT')]);

    expect(drain).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test('keeps closing after a failing step and exits 1', async () => {
    const closed: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit,
      drain: async () => {},
      steps: [
        {
          name: 'pool',
          close: () => {
            throw new Error('boom');
          },
        },
        { name: 'redis', close: () => closed.push('redis') },
      ],
    });

    await shutdown.run('SIGTERM');

    expect(closed).toEqual(['redis']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('closes the pool even when the drain fails, and exits 1', async () => {
    const closed: string[] = [];
    const exit = jest.fn();
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit,
      drain: async () => {
        throw new Error('drain failed');
      },
      steps: [{ name: 'pool', close: () => closed.push('pool') }],
    });

    await shutdown.run('SIGTERM');

    expect(closed).toEqual(['pool']);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('forces exit 1 at the deadline when the drain never ends', async () => {
    jest.useFakeTimers();
    const exit = jest.fn();
    const shutdown = createShutdown({
      timeoutMs: 5000,
      exit,
      drain: () => new Promise<void>(() => {}),
      steps: [],
    });

    void shutdown.run('SIGTERM');
    await jest.advanceTimersByTimeAsync(4999);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test('guard lets everything through before the signal', () => {
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit: jest.fn(),
      drain: async () => {},
      steps: [],
    });
    const next = jest.fn() as unknown as NextFunction;
    const { res, state } = fakeResponse();

    shutdown.guard({ path: '/graphql' } as Request, res, next);

    expect(next).toHaveBeenCalled();
    expect(state.status).toBeUndefined();
    expect(shutdown.isShuttingDown()).toBe(false);
  });

  test('guard refuses with a 503 once shutting down, except the probes', async () => {
    let release: () => void = () => {};
    const shutdown = createShutdown({
      timeoutMs: 1000,
      exit: jest.fn(),
      drain: () => new Promise<void>((resolve) => (release = resolve)),
      steps: [],
    });
    const running = shutdown.run('SIGTERM');
    expect(shutdown.isShuttingDown()).toBe(true);

    const refused = fakeResponse();
    const refusedNext = jest.fn() as unknown as NextFunction;
    shutdown.guard({ path: '/api/export' } as Request, refused.res, refusedNext);
    expect(refusedNext).not.toHaveBeenCalled();
    expect(refused.state.status).toBe(503);
    expect(refused.state.headers['Connection']).toBe('close');
    expect(refused.state.headers['Retry-After']).toBeDefined();

    for (const path of ['/health', '/ready']) {
      const next = jest.fn() as unknown as NextFunction;
      shutdown.guard({ path } as Request, fakeResponse().res, next);
      expect(next).toHaveBeenCalled();
    }

    release();
    await running;
  });
});

describe('drainBudgetMs', () => {
  test('leaves part of the budget to close the resources', () => {
    expect(drainBudgetMs(25_000)).toBeLessThan(25_000);
    expect(drainBudgetMs(25_000)).toBeGreaterThan(0);
  });
});
