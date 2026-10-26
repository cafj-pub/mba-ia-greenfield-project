import { request } from 'http';

export interface PresignedResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/**
 * Calls a presigned URL from inside the Docker network.
 *
 * URLs handed to clients are signed for S3_PUBLIC_ENDPOINT (localhost:9000 in
 * dev), which is unreachable from a container. SigV4 signs the `host` header,
 * so the request goes to S3_ENDPOINT (minio:9000) while keeping the signed Host.
 */
export function requestPresignedUrl(
  presignedUrl: string,
  options: {
    method?: string;
    body?: Buffer;
    headers?: Record<string, string>;
  } = {},
): Promise<PresignedResponse> {
  const signed = new URL(presignedUrl);
  const target = new URL(process.env.S3_ENDPOINT ?? 'http://minio:9000');

  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        method: options.method ?? 'GET',
        path: `${signed.pathname}${signed.search}`,
        headers: {
          ...options.headers,
          host: signed.host,
          ...(options.body && { 'content-length': options.body.length }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}
