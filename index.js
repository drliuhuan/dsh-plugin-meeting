// dsh-plugin-live-meeting — Host half.
//
// Captures the Windows default render endpoint with WASAPI loopback, transcribes
// with DSH's local SenseVoice service, asks DSH's configured model to proofread
// (domain-aware) and translate each line, maintains a rolling meeting summary,
// and answers participant questions with optional web lookup through ctx.web.
//
// The loader row name must stay the bare package name: DSH's client-module
// scanner uses it to discover the package's `dsh.client` bundle (client.js).

import os from 'node:os';
import path from 'node:path';
import { MeetingService } from './lib/meeting.mjs';
import { createHandlers, routeRows } from './lib/routes.mjs';

export const name = 'meeting';
export const inject = ['webServer'];

export function apply(ctx) {
  const dataRoot = path.join(os.homedir(), '.dsh', 'meetings');
  const service = new MeetingService(ctx, { dataRoot, logger: ctx.logger });
  const handlers = createHandlers(service, { logger: ctx.logger });
  const rows = routeRows(handlers);

  ctx.inject(['webServer'], (scope) => {
    const disposers = rows.map((row) => scope.webServer.register(row));
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          // one route disposer failing must not abort teardown
        }
      }
    }, 'meeting: routes');
  });

  ctx.effect(() => () => service.dispose(), 'meeting: lifecycle');

  return service;
}

export { MeetingService };


