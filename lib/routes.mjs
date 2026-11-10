// HTTP surface of the meeting plugin.
//
// The browser never uploads audio: the Host captures system audio natively.
// These routes only start/stop a meeting, read its projection, stream events,
// and ask questions.  Every POST is same-origin and JSON-only.

import { Buffer } from 'node:buffer';
import {
  readJsonBody,
  sameOrigin,
  sendError,
  sendJson
} from './util.mjs';

const ROUTES = Object.freeze({
  state: '/dsh-meeting/state',
  events: '/dsh-meeting/events',
  start: '/dsh-meeting/start',
  stop: '/dsh-meeting/stop',
  ask: '/dsh-meeting/ask',
  settings: '/dsh-meeting/settings',
  profile: '/dsh-meeting/profile',
  script: '/dsh-meeting/script',
  prepare: '/dsh-meeting/prepare',
  devices: '/dsh-meeting/devices',
  history: '/dsh-meeting/history',
  load: '/dsh-meeting/load',
  retryCorrection: '/dsh-meeting/retry-correction',
  summary: '/dsh-meeting/summary',
  refineNow: '/dsh-meeting/refine-now',
  speaker: '/dsh-meeting/speaker',
  agenda: '/dsh-meeting/agenda',
  agendaImage: '/dsh-meeting/agenda-image',
  agendaFile: '/dsh-meeting/agenda-file',
  agendaCurrent: '/dsh-meeting/agenda-current',
  turnSpeaker: '/dsh-meeting/turn-speaker',
  cue: '/dsh-meeting/cue',
  agendaEntries: '/dsh-meeting/agenda-entries',
  clientError: '/dsh-meeting/client-error',
  debug: '/dsh-meeting/debug'
});

function guardPost(req, res) {
  if (req.method !== 'POST') {
    sendError(req, res, 405, 'use POST');
    return false;
  }
  if (!sameOrigin(req)) {
    sendError(req, res, 403, 'cross-origin requests are not allowed');
    return false;
  }
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    sendError(req, res, 415, 'send application/json');
    return false;
  }
  return true;
}

function guardGet(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(req, res, 405, 'use GET');
    return false;
  }
  return true;
}

function failure(res, req, error, fallback) {
  const status = Number(error?.status) || (error?.code === 'MEETING_ACTIVE' ? 409 : 500);
  sendError(req, res, status, error?.message ?? fallback, error?.code);
}

/**
 * @param {import('./meeting.mjs').MeetingService} service
 * @param {{ logger?: { warn?: Function } }} [options]
 */
export function createHandlers(service, options = {}) {
  const logger = options.logger;

  function state(req, res) {
    if (!guardGet(req, res)) return;
    try {
      sendJson(req, res, 200, service.snapshot());
    } catch (error) {
      logger?.warn?.(`meeting: state failed: ${String(error?.message ?? error)}`);
      sendError(req, res, 500, 'could not read meeting state');
    }
  }

  function events(req, res) {
    if (!guardGet(req, res)) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-content-type-options': 'nosniff'
    });
    res.write('retry: 2500\n\n');

    const send = (event) => {
      try {
        const data = JSON.stringify(event.payload ?? null);
        res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`);
      } catch {
        // the browser went away; the unsubscribe below handles cleanup
      }
    };
    send({ seq: service.seq, type: 'state', payload: service.snapshot() });
    const unsubscribe = service.subscribe(send);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: heartbeat ${Date.now()}\n\n`);
      } catch {
        // ignore
      }
    }, 15000);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      try {
        res.end();
      } catch {
        // already closed
      }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  async function start(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.start(body);
      sendJson(req, res, 202, { ok: true, state: snapshot });
    } catch (error) {
      failure(res, req, error, 'could not start the meeting');
    }
  }

  async function stop(req, res) {
    if (!guardPost(req, res)) return;
    try {
      await readJsonBody(req).catch(() => ({}));
      const snapshot = await service.stop();
      sendJson(req, res, 200, { ok: true, state: snapshot });
    } catch (error) {
      failure(res, req, error, 'could not stop the meeting');
    }
  }

  async function ask(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const result = await service.ask(body);
      sendJson(req, res, 202, result);
    } catch (error) {
      failure(res, req, error, 'could not ask the meeting question');
    }
  }

  async function settings(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.updateSettings(body);
      sendJson(req, res, 200, { ok: true, state: snapshot });
    } catch (error) {
      failure(res, req, error, 'could not update meeting settings');
    }
  }

  async function profile(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.updateProfile(body);
      sendJson(req, res, 200, { ok: true, state: snapshot, profile: snapshot.profile });
    } catch (error) {
      failure(res, req, error, 'could not save the user profile');
    }
  }

  async function script(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const draft = service.startScriptWrite(body);
      sendJson(req, res, 202, { ok: true, state: service.snapshot(), script: draft });
    } catch (error) {
      failure(res, req, error, 'could not generate the speech draft');
    }
  }

  async function prepare(req, res) {
    if (!guardPost(req, res)) return;
    try {
      await readJsonBody(req).catch(() => ({}));
      void service.prepare().catch((error) => {
        service.emit('error', { message: String(error?.message ?? error), code: error?.code ?? 'PREPARE_FAILED' });
      });
      sendJson(req, res, 202, { ok: true });
    } catch (error) {
      failure(res, req, error, 'could not prepare the local speech model');
    }
  }

  async function devices(req, res) {
    if (!guardGet(req, res)) return;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const source = url.searchParams.get('source') === 'mic' ? 'mic' : 'loopback';
      const devices = await service.devices(source);
      sendJson(req, res, 200, { ok: true, source, devices });
    } catch (error) {
      failure(res, req, error, 'could not list audio devices');
    }
  }

  async function history(req, res) {
    if (!guardGet(req, res)) return;
    try {
      const result = await service.history();
      sendJson(req, res, 200, result);
    } catch (error) {
      failure(res, req, error, 'could not read meeting history');
    }
  }

  async function load(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.load(body.id);
      sendJson(req, res, 200, { ok: true, state: snapshot });
    } catch (error) {
      failure(res, req, error, 'could not load the meeting');
    }
  }

  async function retryCorrection(req, res) {
    if (!guardPost(req, res)) return;
    try {
      await readJsonBody(req).catch(() => ({}));
      const result = await service.retryCorrection();
      sendJson(req, res, 200, { ok: true, ...result });
    } catch (error) {
      failure(res, req, error, 'could not retry correction');
    }
  }

  async function summary(req, res) {
    if (!guardPost(req, res)) return;
    try {
      await readJsonBody(req).catch(() => ({}));
      void service.regenerateSummary();
      sendJson(req, res, 202, { ok: true });
    } catch (error) {
      failure(res, req, error, 'could not regenerate the summary');
    }
  }

  async function refineNow(req, res) {
    if (!guardPost(req, res)) return;
    try {
      await readJsonBody(req).catch(() => ({}));
      const snapshot = await service.refineNow();
      sendJson(req, res, 200, { ok: true, state: snapshot, refine: snapshot.active?.refineState ?? null });
    } catch (error) {
      failure(res, req, error, 'could not refine the conversation');
    }
  }

  async function speaker(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.renameSpeaker(body.id, body.name, body.org);
      sendJson(req, res, 200, { ok: true, state: snapshot });
    } catch (error) {
      failure(res, req, error, 'could not rename the speaker');
    }
  }

  async function agenda(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.setAgenda(body.text, body.filename, {
        requireLlm: body.requireLlm === true,
        source: body.source
      });
      sendJson(req, res, 200, { ok: true, state: snapshot, agenda: snapshot.agenda });
    } catch (error) {
      failure(res, req, error, 'could not update the meeting agenda');
    }
  }

  function debug(req, res) {
    if (!guardGet(req, res)) return;
    try {
      sendJson(req, res, 200, service.debug());
    } catch (error) {
      failure(res, req, error, 'could not read diagnostics');
    }
  }

  async function agendaImage(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req, 12 * 1024 * 1024);
      const extracted = await service.setAgendaImage(body.imageBase64 || body.image, body.filename);
      sendJson(req, res, 200, { ok: true, ...extracted });
    } catch (error) {
      failure(res, req, error, 'could not OCR the agenda image');
    }
  }

  async function agendaFile(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req, 30 * 1024 * 1024);
      // Extract the text only.  The panel keeps it as a draft; the model does
      // the structuring when the user clicks 应用日程.
      const extracted = await service.setAgendaFile(
        body.fileBase64 || body.imageBase64 || body.image,
        body.filename,
        body.mime || ''
      );
      sendJson(req, res, 200, { ok: true, ...extracted });
    } catch (error) {
      failure(res, req, error, 'could not read the agenda file');
    }
  }

  async function clientError(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      service.reportClientError(body);
      sendJson(req, res, 200, { ok: true });
    } catch (error) {
      failure(res, req, error, 'could not record the client error');
    }
  }

  async function agendaEntries(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.setAgendaEntries(body);
      sendJson(req, res, 200, { ok: true, state: snapshot, agenda: snapshot.agenda });
    } catch (error) {
      failure(res, req, error, 'could not save the agenda entries');
    }
  }

  async function cue(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.requestCue(body.index);
      sendJson(req, res, 200, { ok: true, state: snapshot });
    } catch (error) {
      failure(res, req, error, 'could not write the cue card');
    }
  }

  async function agendaCurrent(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.setAgendaPin(body.index);
      sendJson(req, res, 200, { ok: true, state: snapshot, agendaNow: snapshot.agendaNow });
    } catch (error) {
      failure(res, req, error, 'could not change the current agenda item');
    }
  }

  async function turnSpeaker(req, res) {
    if (!guardPost(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const snapshot = await service.setTurnSpeaker(body.turnId, body.speakerId);
      sendJson(req, res, 200, { ok: true, state: snapshot });
    } catch (error) {
      failure(res, req, error, 'could not reassign the speaker');
    }
  }

  return { state, events, start, stop, ask, settings, profile, script, prepare, devices, history, load, retryCorrection, summary, refineNow, speaker, agenda, agendaImage, agendaFile, agendaCurrent, turnSpeaker, cue, agendaEntries, clientError, debug };
}

export function routeRows(handlers) {
  return [
    { kind: 'exact', path: ROUTES.state, handler: handlers.state },
    { kind: 'exact', path: ROUTES.events, handler: handlers.events },
    { kind: 'exact', path: ROUTES.start, handler: handlers.start },
    { kind: 'exact', path: ROUTES.stop, handler: handlers.stop },
    { kind: 'exact', path: ROUTES.ask, handler: handlers.ask },
    { kind: 'exact', path: ROUTES.settings, handler: handlers.settings },
    { kind: 'exact', path: ROUTES.profile, handler: handlers.profile },
    { kind: 'exact', path: ROUTES.script, handler: handlers.script },
    { kind: 'exact', path: ROUTES.prepare, handler: handlers.prepare },
    { kind: 'exact', path: ROUTES.devices, handler: handlers.devices },
    { kind: 'exact', path: ROUTES.history, handler: handlers.history },
    { kind: 'exact', path: ROUTES.load, handler: handlers.load },
    { kind: 'exact', path: ROUTES.retryCorrection, handler: handlers.retryCorrection },
    { kind: 'exact', path: ROUTES.summary, handler: handlers.summary },
    { kind: 'exact', path: ROUTES.refineNow, handler: handlers.refineNow },
    { kind: 'exact', path: ROUTES.speaker, handler: handlers.speaker },
    { kind: 'exact', path: ROUTES.agenda, handler: handlers.agenda },
    { kind: 'exact', path: ROUTES.agendaImage, handler: handlers.agendaImage },
    { kind: 'exact', path: ROUTES.agendaFile, handler: handlers.agendaFile },
    { kind: 'exact', path: ROUTES.agendaCurrent, handler: handlers.agendaCurrent },
    { kind: 'exact', path: ROUTES.turnSpeaker, handler: handlers.turnSpeaker },
    { kind: 'exact', path: ROUTES.cue, handler: handlers.cue },
    { kind: 'exact', path: ROUTES.agendaEntries, handler: handlers.agendaEntries },
    { kind: 'exact', path: ROUTES.clientError, handler: handlers.clientError },
    { kind: 'exact', path: ROUTES.debug, handler: handlers.debug }
  ];
}

export { ROUTES };
