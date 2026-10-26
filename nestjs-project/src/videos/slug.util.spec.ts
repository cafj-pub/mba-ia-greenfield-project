import { VIDEO_SLUG_LENGTH } from './videos.constants';
import { generateVideoSlug } from './slug.util';

describe('generateVideoSlug', () => {
  it('should produce an 11-char slug from the base64url alphabet', () => {
    const slug = generateVideoSlug();

    expect(slug).toHaveLength(VIDEO_SLUG_LENGTH);
    expect(slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should produce distinct slugs across calls', () => {
    const slugs = new Set(
      Array.from({ length: 1000 }, () => generateVideoSlug()),
    );

    expect(slugs.size).toBe(1000);
  });
});
