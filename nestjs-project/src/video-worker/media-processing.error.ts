/** Failure of an ffprobe/ffmpeg run or of interpreting its output. */
export class MediaProcessingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaProcessingError';
  }
}

/** The file was read fine but is not a usable video — retrying cannot help. */
export class UnsupportedMediaError extends MediaProcessingError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}
