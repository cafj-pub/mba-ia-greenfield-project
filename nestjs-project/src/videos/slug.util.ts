import { randomBytes } from 'crypto';

// 8 random bytes → 11 base64url chars [A-Za-z0-9_-], 64 bits of entropy
// (phase-03-videos/TD-05). Uniqueness is enforced by the DB unique index.
export function generateVideoSlug(): string {
  return randomBytes(8).toString('base64url');
}
