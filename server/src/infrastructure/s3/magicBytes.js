/**
 * Validates the binary file signature ("magic bytes") against the declared MIME type.
 * Only the first 12-16 bytes of the file are required.
 *
 * @param {Buffer} buffer - Buffer containing at least the first 16 bytes of the file.
 * @param {string} contentType - Declared MIME type ('image/jpeg', 'image/png', 'image/webp').
 * @returns {boolean} true if magic bytes match, false otherwise.
 */
export function verifyMagicBytes(buffer, contentType) {
  if (!buffer || buffer.length < 12) {
    return false;
  }

  switch (contentType) {
    case 'image/jpeg':
      // JPEG starts with FF D8 FF
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

    case 'image/png':
      // PNG starts with 89 50 4E 47 0D 0A 1A 0A
      return (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );

    case 'image/webp':
      // WebP has 'RIFF' at 0..3 and 'WEBP' at 8..11
      return (
        buffer.length >= 12 &&
        buffer[0] === 0x52 && // 'R'
        buffer[1] === 0x49 && // 'I'
        buffer[2] === 0x46 && // 'F'
        buffer[3] === 0x46 && // 'F'
        buffer[8] === 0x57 && // 'W'
        buffer[9] === 0x45 && // 'E'
        buffer[10] === 0x42 && // 'B'
        buffer[11] === 0x50 // 'P'
      );

    default:
      return false;
  }
}
