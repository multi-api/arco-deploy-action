import type { ExternalDns } from './dns.js';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: string;
}

export interface StartResponse {
  credentials: Credentials;
  region: string;
  environment: string;
  mode: string;
  /** IAM permissions boundary ARN for v2 connect accounts; null/absent for v1 accounts and older Cloud. */
  permissionsBoundary?: string | null;
  /** Route 53 credentials for a DNS zone in another AWS account; null/absent when not needed and from older Cloud. */
  dns?: ExternalDns | null;
  /** Cloudflare API token for Cloudflare-managed domains; null/absent when not needed and from older Cloud. */
  cloudflareToken?: string | null;
}

export interface LogsPayload {
  seq: number;
  lines: string[];
  events: unknown[];
}

/** Non-2xx answer from Arco Cloud; `code` is the `error` field of a JSON body, when present. */
export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'CloudApiError';
  }
}

/** Cloud told us this run no longer belongs to us (lease lost, already finished, or another runner). */
export function isRunLost(e: unknown): e is CloudApiError {
  return (
    e instanceof CloudApiError &&
    ((e.status === 409 && (e.code === 'lease_lost' || e.code === 'finished')) || (e.status === 403 && e.code === 'not_runner'))
  );
}

export interface CloudApiOptions {
  /** Per-request timeout (connect, headers and body). A timeout is a plain Error, retried like a network error. Default 30000. */
  timeoutMs?: number;
}

export class CloudApi {
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly deploymentId: string,
    options: CloudApiOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  /** POSTs `body`; resolves to the parsed JSON answer when `readJson`, else undefined. The timeout covers the body read too. */
  private async post(path: string, body: unknown, readJson = false): Promise<unknown> {
    try {
      const response = await this.request(path, body);
      return readJson ? await response.json() : undefined;
    } catch (e) {
      if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        throw new Error(`Arco Cloud ${path} timed out after ${this.timeoutMs} ms`);
      }
      throw e;
    }
  }

  private async request(path: string, body: unknown): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/v1/deployments/${encodeURIComponent(this.deploymentId)}/${path}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-Arco-Cloud-Api': '1',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let code: string | null = null;
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body?.error === 'string') code = body.error;
      } catch {
        // body is not JSON: no error code
      }
      throw new CloudApiError(`Arco Cloud ${path} failed with HTTP ${response.status}`, response.status, code);
    }
    return response;
  }

  async start(nonce: string): Promise<StartResponse> {
    // `capabilities` tells Cloud this client can apply external DNS; without it Cloud refuses runs that need it.
    return (await this.post('start', { nonce, capabilities: ['external_dns'] }, true)) as StartResponse;
  }

  async logs(payload: LogsPayload): Promise<void> {
    await this.post('logs', payload);
  }

  async finish(payload: unknown): Promise<void> {
    await this.post('finish', payload);
  }
}
