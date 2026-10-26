import { UnsupportedMediaError } from './media-processing.error';
import { FfprobeOutput, parseProbeOutput } from './probe-parser';

const videoStream = {
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  avg_frame_rate: '30000/1001',
};
const audioStream = { codec_type: 'audio', codec_name: 'aac' };
const format = {
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: '63.483000',
  bit_rate: '2500123',
  size: '19840000',
};

describe('parseProbeOutput', () => {
  it('should map duration, format and stream data', () => {
    const output: FfprobeOutput = {
      streams: [videoStream, audioStream],
      format,
    };

    expect(parseProbeOutput(output)).toEqual({
      durationSeconds: 63.483,
      metadata: {
        format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        bit_rate: 2500123,
        size: 19840000,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        frame_rate: 29.97,
      },
    });
  });

  it('should report a null audio codec for a silent video', () => {
    const result = parseProbeOutput({ streams: [videoStream], format });

    expect(result.metadata.audio_codec).toBeNull();
  });

  it('should return nulls for unknown duration, bitrate and frame rate', () => {
    const result = parseProbeOutput({
      streams: [{ ...videoStream, avg_frame_rate: '0/0' }],
      format: { format_name: 'matroska,webm', duration: 'N/A' },
    });

    expect(result.durationSeconds).toBeNull();
    expect(result.metadata.bit_rate).toBeNull();
    expect(result.metadata.size).toBeNull();
    expect(result.metadata.frame_rate).toBeNull();
  });

  it.each<[string, FfprobeOutput]>([
    ['an audio-only file', { streams: [audioStream], format }],
    ['empty output', {}],
  ])('should throw UnsupportedMediaError for %s', (_label, output) => {
    expect(() => parseProbeOutput(output)).toThrow(UnsupportedMediaError);
    expect(() => parseProbeOutput(output)).toThrow('No video stream found');
  });
});
