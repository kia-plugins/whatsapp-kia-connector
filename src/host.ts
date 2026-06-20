import type { ConnectorHost } from '@alpha-cent/connector-sdk';

/** Minimal async DB surface the connector calls on ctx.db (cast from unknown). */
export type Db = {
  all(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
};

/** Minimal document-converter surface (subset of the app's Converter). */
export type Converter = {
  convert(
    input:
      | { kind: 'bytes'; bytes: Buffer; mimeType: string; filename?: string }
      | { kind: 'html'; html: string }
      | { kind: 'text'; text: string },
  ): Promise<{
    markdown: string | null;
    status: 'ok' | 'unsupported' | 'failed';
    error?: string;
    warnings?: string[];
  }>;
};

export type Host = ConnectorHost;
