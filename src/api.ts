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
}

export interface LogsPayload {
  seq: number;
  lines: string[];
  events: unknown[];
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
    if (!response.ok) throw new Error(`Arco Cloud ${path} failed with HTTP ${response.status}`);
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
