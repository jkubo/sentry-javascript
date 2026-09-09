import type ApplicationInstance from '@ember/application/instance';
import { instrumentAppInstancePerformance } from '@sentry/ember';

export function initialize(appInstance: ApplicationInstance): void {
  instrumentAppInstancePerformance(appInstance, {
    minimumRunloopQueueDuration: 0,
    minimumComponentRenderDuration: 0,
    // Opt in so the E2E suite covers the `ui.resolve` spans, which are off by default.
    enableComponentDefinitions: true,
  });
}

export default {
  initialize,
};
