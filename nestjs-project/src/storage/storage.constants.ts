// Server-side calls and URLs consumed inside the Docker network (worker input)
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');

// Signs only the URLs returned to HTTP clients (phase-03-videos/TD-03)
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');

export const URL_AUDIENCE = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
} as const;

export type UrlAudience = (typeof URL_AUDIENCE)[keyof typeof URL_AUDIENCE];
