import { thumbnailTimestamp } from './thumbnail-time';

describe('thumbnailTimestamp', () => {
  it('should pick the frame at 10% of the duration', () => {
    expect(thumbnailTimestamp(120)).toBe(12);
    expect(thumbnailTimestamp(2.5)).toBeCloseTo(0.25);
  });

  it.each([null, 0, -1])(
    'should fall back to 0s when the duration is %p',
    (duration) => {
      expect(thumbnailTimestamp(duration)).toBe(0);
    },
  );
});
