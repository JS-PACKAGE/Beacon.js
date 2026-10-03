import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function apiEndpoint(base: string, path: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}${path}`;
  url.search = '';
  return url.href;
}

// One connection per request avoids idle pooled-socket reuse; the deadline covers the complete body.
export async function requestJson(url: string, timeoutMs: number, maxBytes: number, token?: string): Promise<unknown> {
  try {
    const endpoint = new URL(url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('External API request failed');
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | undefined;
      let timer: NodeJS.Timeout | undefined;
      const transport = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = transport(endpoint, {
        agent: false,
        method: token === undefined ? 'GET' : 'POST',
        headers: token === undefined ? { accept: 'application/json' } : { accept: 'application/json', authorization: `Bearer ${token}` },
      });
      const fail = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        response?.destroy();
        request.destroy();
        reject(new Error('External API request failed'));
      };
      request.on('error', fail);
      request.on('response', incoming => {
        response = incoming;
        if (settled) { incoming.destroy(); return; }
        incoming.on('error', fail);
        incoming.on('aborted', fail);
        const length = incoming.headers['content-length'];
        // No redirects are followed, so bearer credentials never reach another endpoint.
        if (incoming.statusCode !== 200 || (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes))) {
          fail(); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        incoming.on('data', (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > maxBytes) { fail(); return; }
          chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (settled) return;
          if (!incoming.complete) { fail(); return; }
          try {
            const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          } catch { fail(); }
        });
        incoming.on('close', () => { if (!settled) fail(); });
      });
      timer = setTimeout(fail, timeoutMs);
      request.end();
    });
  } catch { throw new Error('External API request failed'); }
}
