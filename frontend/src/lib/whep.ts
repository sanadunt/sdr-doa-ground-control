/**
 * A minimal WHEP player for the drone camera: one receive-only video
 * transceiver, the offer posted to the console's same-origin proxy
 * (POST /api/drone/video/whep, tools/drone_video.py) once ICE gathering is
 * done, so no trickle PATCH is needed. The media itself comes from the host
 * video service over UDP 8189.
 */

export const DRONE_WHEP_PATH = '/api/drone/video/whep';
const ICE_GATHER_MS = 2_000;
const OFFER_TIMEOUT_MS = 8_000;

export interface WhepSession {
  pc: RTCPeerConnection;
  close(): void;
}

/** A failed start, with the console's code when it answered one (DRONE_VIDEO_NO_STREAM, ...). */
export class WhepError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number | null) {
    super(message);
    this.name = 'WhepError';
  }
}

function waitForIce(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    // Host candidates are enough on the LAN; send what there is after the wait.
    const timer = window.setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = await response.json() as { code?: unknown };
    return typeof body.code === 'string' ? body.code.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/** Open a session that plays into ``onStream``; throws WhepError when the console or the service refuses. */
export async function startWhep(onStream: (stream: MediaStream) => void, signal?: AbortSignal): Promise<WhepSession> {
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
  let location: string | null = null;
  const close = () => {
    pc.close();
    if (location) {
      // The service ends the session sooner than its own timeout.
      void fetch(location, { method: 'DELETE', keepalive: true }).catch(() => undefined);
      location = null;
    }
  };
  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = (event) => onStream(event.streams[0] ?? new MediaStream([event.track]));
    await pc.setLocalDescription(await pc.createOffer());
    await waitForIce(pc, ICE_GATHER_MS);
    const offer = pc.localDescription?.sdp;
    if (!offer) throw new WhepError('no offer', null, null);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = window.setTimeout(abort, OFFER_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(DRONE_WHEP_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer,
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    if (!response.ok) throw new WhepError(`video refused (${response.status})`, await errorCode(response), response.status);
    const header = response.headers.get('Location');
    location = header && header.startsWith(`${DRONE_WHEP_PATH}/`) ? header : null;
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    return { pc, close };
  } catch (error) {
    close();
    if (error instanceof WhepError) throw error;
    throw new WhepError(error instanceof Error ? error.message : 'video failed', null, null);
  }
}
