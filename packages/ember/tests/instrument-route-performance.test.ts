import type Route from '@ember/routing/route';
import { startSpan } from '@sentry/browser';
import { hasSpanStreamingEnabled } from '@sentry/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/browser', () => ({
  startSpan: vi.fn((_options: unknown, callback: () => unknown) => callback()),
}));
vi.mock('@sentry/core', () => ({
  SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN: 'sentry.origin',
  getClient: vi.fn(() => ({})),
  hasSpanStreamingEnabled: vi.fn(() => false),
}));

class DummyRoute {
  public fullRouteName = 'dummy';

  public beforeModel(..._args: unknown[]): void {}

  public model(..._args: unknown[]): void {}

  public afterModel(..._args: unknown[]): void {}

  public setupController(..._args: unknown[]): void {}
}

async function createInstrumentedRoute(): Promise<Route> {
  const { instrumentRoutePerformance } = await import('../src/utils/instrumentRoutePerformance.ts');
  const InstrumentedDummyRoute = instrumentRoutePerformance(DummyRoute as unknown as new (...args: unknown[]) => Route);
  return new InstrumentedDummyRoute();
}

describe('instrumentRoutePerformance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hasSpanStreamingEnabled).mockReturnValue(false);
  });

  it('wrapped Route hooks maintain the current context', async () => {
    const beforeModel = vi.spyOn(DummyRoute.prototype, 'beforeModel');
    const model = vi.spyOn(DummyRoute.prototype, 'model');
    const afterModel = vi.spyOn(DummyRoute.prototype, 'afterModel');
    const setupController = vi.spyOn(DummyRoute.prototype, 'setupController');

    const route = await createInstrumentedRoute();

    await route.beforeModel('foo');
    expect(beforeModel).toHaveBeenCalledWith('foo');
    expect(beforeModel.mock.contexts[0]).toBe(route);

    await route.model('bar');
    expect(model).toHaveBeenCalledWith('bar');
    expect(model.mock.contexts[0]).toBe(route);

    await route.afterModel('bax');
    expect(afterModel).toHaveBeenCalledWith('bax');
    expect(afterModel.mock.contexts[0]).toBe(route);

    await route.setupController('baz');
    expect(setupController).toHaveBeenCalledWith('baz');
    expect(setupController.mock.contexts[0]).toBe(route);

    expect(startSpan).toHaveBeenCalledTimes(4);
  });

  it('names the span after the route and leaves it undescribed when span streaming is disabled', async () => {
    const route = await createInstrumentedRoute();

    await route.model();

    // The name already carries the route here, so a description would only duplicate it.
    expect(startSpan).toHaveBeenCalledWith(
      {
        attributes: {
          'sentry.origin': 'auto.ui.ember',
          'sentry.op': 'function',
          'code.function.name': 'model',
        },
        name: 'dummy',
        onlyIfParent: true,
      },
      expect.any(Function),
    );
  });

  it('names the span after the hook when span streaming is enabled, keeping the route as the description', async () => {
    vi.mocked(hasSpanStreamingEnabled).mockReturnValue(true);

    const route = await createInstrumentedRoute();

    await route.model();

    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'model',
        attributes: expect.objectContaining({
          'code.function.name': 'model',
          'sentry.description': 'dummy',
        }),
      }),
      expect.any(Function),
    );
  });

  it.each(['beforeModel', 'model', 'afterModel', 'setupController'] as const)(
    'sets `code.function.name` to the %s hook name',
    async hookName => {
      const route = await createInstrumentedRoute();

      await (route[hookName] as () => Promise<unknown>)();

      expect(startSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ 'code.function.name': hookName }),
        }),
        expect.any(Function),
      );
    },
  );
});
