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

export class CloudApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly deploymentId: string,
  ) {}

  private async post(path: string, body: unknown): Promise<Response> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/api/v1/deployments/${encodeURIComponent(this.deploymentId)}/${path}`;
    const response = await fetch(url, {
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
    return (await (await this.post('start', { nonce })).json()) as StartResponse;
  }

  async logs(payload: LogsPayload): Promise<void> {
    await this.post('logs', payload);
  }

  async finish(payload: unknown): Promise<void> {
    await this.post('finish', payload);
  }
}
