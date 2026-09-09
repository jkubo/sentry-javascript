import { expect, test } from '@playwright/test';
import type { SerializedStreamedSpan } from '@sentry-internal/test-utils';
import { collectStreamedSpansUntilSegment, getSpanOp, waitForStreamedSpan } from '@sentry-internal/test-utils';

// `ember-strict-resolver` covers the same routes on the static lifecycle.

// The SDK stamps these onto every streamed span, whatever produced it. Stripping them lets the
// instrumentation's own attributes be asserted exactly, the way the static suites assert `span.data`.
const SDK_ATTRIBUTES = [
  'sentry.trace_lifecycle',
  'sentry.segment.name',
  'sentry.segment.id',
  'sentry.sdk.name',
  'sentry.sdk.version',
  'sentry.sdk.integrations',
  'sentry.environment',
  'sentry.release',
  'sentry.sample_rate',
  'user.id',
  'user.email',
  'user.ip_address',
  'user.username',
  // `httpContextIntegration` sets this on every span; replay is enabled in this app, so it tags
  // every span too.
  'user_agent.original',
  'sentry.replay_id',
  'sentry._internal.replay_is_buffering',
];

function instrumentationAttributes(span: SerializedStreamedSpan): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(span.attributes)
      .filter(([key]) => !SDK_ATTRIBUTES.includes(key))
      .map(([key, attribute]) => [key, attribute.value]),
  );
}

function expectChildSpan(
  span: SerializedStreamedSpan | undefined,
  segmentSpan: SerializedStreamedSpan,
  expected: { name: string; attributes: Record<string, unknown> },
): void {
  expect(span).toMatchObject({
    name: expected.name,
    is_segment: false,
    status: 'ok',
    parent_span_id: segmentSpan.span_id,
    span_id: expect.stringMatching(/^[a-f0-9]{16}$/),
    trace_id: segmentSpan.trace_id,
    start_timestamp: expect.any(Number),
    end_timestamp: expect.any(Number),
  });
  expect(instrumentationAttributes(span!)).toEqual(expected.attributes);
}

test('sends a pageload span with a parameterized URL', async ({ page }) => {
  const pageloadSpanPromise = waitForStreamedSpan('ember-classic', span => {
    return span.is_segment && getSpanOp(span) === 'pageload';
  });

  await page.goto(`/`);

  const pageloadSpan = await pageloadSpanPromise;

  expect(pageloadSpan).toMatchObject({
    name: 'route:index',
    is_segment: true,
    attributes: {
      'sentry.op': { type: 'string', value: 'pageload' },
      'sentry.origin': { type: 'string', value: 'auto.pageload.ember' },
      'sentry.segment.name.source': { type: 'string', value: 'route' },
      'url.template': { type: 'string', value: '/' },
      'url.path': { type: 'string', value: '/' },
      'url.full': { type: 'string', value: expect.stringMatching(/^https?:\/\/localhost:\d+\/$/) },
    },
  });
});

test('sends a navigation span with a parameterized URL', async ({ page }) => {
  const pageloadSpanPromise = waitForStreamedSpan('ember-classic', span => {
    return span.is_segment && getSpanOp(span) === 'pageload';
  });

  const navigationSpanPromise = waitForStreamedSpan('ember-classic', span => {
    return span.is_segment && getSpanOp(span) === 'navigation';
  });

  await page.goto(`/`);
  await pageloadSpanPromise;

  const [_, navigationSpan] = await Promise.all([page.getByText('Tracing').click(), navigationSpanPromise]);

  expect(navigationSpan).toMatchObject({
    name: 'route:tracing',
    is_segment: true,
    attributes: {
      'sentry.op': { type: 'string', value: 'navigation' },
      'sentry.origin': { type: 'string', value: 'auto.navigation.ember' },
      'sentry.segment.name.source': { type: 'string', value: 'route' },
      'url.template': { type: 'string', value: '/tracing' },
      'url.path': { type: 'string', value: '/tracing' },
      'url.full': { type: 'string', value: expect.stringMatching(/^https?:\/\/localhost:\d+\/tracing$/) },
    },
  });
});

test('sends a navigation span even if the pageload span is still active', async ({ page }) => {
  const pageloadSpanPromise = waitForStreamedSpan('ember-classic', span => {
    return span.is_segment && getSpanOp(span) === 'pageload';
  });

  const navigationSpanPromise = waitForStreamedSpan('ember-classic', span => {
    return span.is_segment && getSpanOp(span) === 'navigation';
  });

  await page.goto(`/`);

  // immediately navigate to a different route
  const [_, pageloadSpan, navigationSpan] = await Promise.all([
    page.getByText('Tracing').click(),
    pageloadSpanPromise,
    navigationSpanPromise,
  ]);

  expect(pageloadSpan).toMatchObject({
    name: 'route:index',
    is_segment: true,
    attributes: {
      'sentry.op': { type: 'string', value: 'pageload' },
      'sentry.origin': { type: 'string', value: 'auto.pageload.ember' },
      'sentry.segment.name.source': { type: 'string', value: 'route' },
      'url.template': { type: 'string', value: '/' },
      'url.path': { type: 'string', value: '/' },
      'url.full': { type: 'string', value: expect.stringMatching(/^https?:\/\/localhost:\d+\/$/) },
    },
  });

  expect(navigationSpan).toMatchObject({
    name: 'route:tracing',
    is_segment: true,
    attributes: {
      'sentry.op': { type: 'string', value: 'navigation' },
      'sentry.origin': { type: 'string', value: 'auto.navigation.ember' },
      'sentry.segment.name.source': { type: 'string', value: 'route' },
      'url.template': { type: 'string', value: '/tracing' },
      'url.path': { type: 'string', value: '/tracing' },
      'url.full': { type: 'string', value: expect.stringMatching(/^https?:\/\/localhost:\d+\/tracing$/) },
    },
  });
});

test('captures correct spans for navigation', async ({ page }) => {
  const pageloadSpanPromise = waitForStreamedSpan('ember-classic', span => {
    return span.is_segment && getSpanOp(span) === 'pageload';
  });

  await page.goto(`/tracing`);
  await pageloadSpanPromise;

  const spansPromise = collectStreamedSpansUntilSegment('ember-classic', 'route:slow-loading-route.index');
  await page.getByText('Measure Things!').click();
  const spans = await spansPromise;

  const navigationSpan = spans.find(span => span.is_segment)!;

  expect(navigationSpan.trace_id).toEqual(expect.stringMatching(/^[a-f0-9]{32}$/));
  expect(navigationSpan.span_id).toEqual(expect.stringMatching(/^[a-f0-9]{16}$/));

  expect(navigationSpan).toMatchObject({
    name: 'route:slow-loading-route.index',
    is_segment: true,
    status: 'ok',
    attributes: {
      'sentry.op': { type: 'string', value: 'navigation' },
      'sentry.origin': { type: 'string', value: 'auto.navigation.ember' },
      'sentry.segment.name.source': { type: 'string', value: 'route' },
      'url.template': { type: 'string', value: '/slow-loading-route' },
      'url.path': { type: 'string', value: '/slow-loading-route' },
      'url.full': { type: 'string', value: expect.stringMatching(/^https?:\/\/localhost:\d+\/slow-loading-route$/) },
    },
  });

  const childrenOf = (op: string, functionName?: string): SerializedStreamedSpan[] =>
    spans.filter(
      span =>
        !span.is_segment &&
        span.parent_span_id === navigationSpan.span_id &&
        getSpanOp(span) === op &&
        (functionName === undefined || span.attributes['code.function.name']?.value === functionName),
    );

  const transitionSpans = childrenOf('router');
  const beforeModelSpans = childrenOf('function', 'beforeModel');
  const modelSpans = childrenOf('function', 'model');
  const afterModelSpans = childrenOf('function', 'afterModel');
  const renderSpans = childrenOf('ui.task').filter(span => span.attributes['ember.runloop.queue']?.value === 'render');

  expect(transitionSpans).toHaveLength(1);

  // We have two spans each there - one for `slow-loading-route` and one for `slow-load-route.index`
  expect(beforeModelSpans).toHaveLength(2);
  expect(modelSpans).toHaveLength(2);
  expect(afterModelSpans).toHaveLength(2);

  // There may be many render spans...
  expect(renderSpans.length).toBeGreaterThan(1);

  // Ember has no route template for the transition itself, so a streamed router span takes the
  // static fallback rather than the `route:a -> route:b` pair it uses on the static lifecycle.
  expectChildSpan(transitionSpans[0], navigationSpan, {
    name: 'Router',
    attributes: {
      'sentry.op': 'router',
      'sentry.origin': 'auto.ui.ember',
    },
  });

  // Route hook spans are named after the hook (matching `code.function.name`), which is the
  // `function` op's name template. The route stays on the span as its description.
  for (const [hookName, hookSpans] of [
    ['beforeModel', beforeModelSpans],
    ['model', modelSpans],
    ['afterModel', afterModelSpans],
  ] as const) {
    expectChildSpan(hookSpans[0], navigationSpan, {
      name: hookName,
      attributes: {
        'code.function.name': hookName,
        'sentry.description': 'slow-loading-route',
        'sentry.op': 'function',
        'sentry.origin': 'auto.ui.ember',
      },
    });

    expectChildSpan(hookSpans[1], navigationSpan, {
      name: hookName,
      attributes: {
        'code.function.name': hookName,
        'sentry.description': 'slow-loading-route.index',
        'sentry.op': 'function',
        'sentry.origin': 'auto.ui.ember',
      },
    });
  }

  expectChildSpan(renderSpans[0], navigationSpan, {
    name: 'runloop',
    attributes: {
      'ember.runloop.queue': 'render',
      'sentry.op': 'ui.task',
      'sentry.origin': 'auto.ui.ember',
    },
  });
});

test('captures a `ui.resolve` span alongside the `ui.render` span for a component', async ({ page }) => {
  const spansPromise = collectStreamedSpansUntilSegment('ember-classic', 'route:tracing');

  await page.goto(`/tracing`);

  const spans = await spansPromise;

  const pageloadSpan = spans.find(span => span.is_segment)!;
  const resolveSpans = spans.filter(span => getSpanOp(span) === 'ui.resolve');
  const renderSpans = spans.filter(span => getSpanOp(span) === 'ui.render');

  expect(resolveSpans.length).toBeGreaterThan(0);
  expect(renderSpans.length).toBeGreaterThan(0);

  // Resolving a component definition and rendering it are separate steps, so they must not share
  // an op even though they carry the same component name.
  const resolveSpan = resolveSpans[0]!;
  expectChildSpan(resolveSpan, pageloadSpan, {
    name: resolveSpan.name,
    attributes: {
      'sentry.op': 'ui.resolve',
      'sentry.origin': 'auto.ui.ember',
      'ui.component_name': resolveSpan.name,
    },
  });

  const renderSpan = renderSpans[0]!;
  expectChildSpan(renderSpan, pageloadSpan, {
    name: renderSpan.name,
    attributes: {
      'sentry.op': 'ui.render',
      'sentry.origin': 'auto.ui.ember',
      'ui.component_name': renderSpan.name,
    },
  });
});
