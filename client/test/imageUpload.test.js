import { describe, it, expect, vi } from 'vitest';
import { uploadFileWithProgress } from '../src/utils/upload.js';

describe('Image Upload with XMLHttpRequest & Progress (Change #6)', () => {
  it('sends File as body, sets Content-Type, does NOT set Content-Length manually, and tracks progress', async () => {
    const mockFile = new File(['fake-image-bytes'], 'venue.jpg', { type: 'image/jpeg' });
    const uploadUrl = 'https://s3.local/bucket/pending/img-123.jpg';

    const setRequestHeaderMock = vi.fn();
    const openMock = vi.fn();
    const sendMock = vi.fn();
    let onloadCallback = null;
    let onprogressCallback = null;

    const mockXHR = {
      open: openMock,
      setRequestHeader: setRequestHeaderMock,
      send: sendMock,
      upload: {},
      status: 200,
      set onload(fn) {
        onloadCallback = fn;
      },
      get onload() {
        return onloadCallback;
      },
    };

    Object.defineProperty(mockXHR.upload, 'onprogress', {
      set: (fn) => {
        onprogressCallback = fn;
      },
      get: () => onprogressCallback,
    });

    vi.stubGlobal('XMLHttpRequest', vi.fn(() => mockXHR));

    const progressReports = [];
    const uploadPromise = uploadFileWithProgress({
      uploadUrl,
      file: mockFile,
      onProgress: (pct) => progressReports.push(pct),
    });

    expect(openMock).toHaveBeenCalledWith('PUT', uploadUrl);
    expect(setRequestHeaderMock).toHaveBeenCalledWith('Content-Type', 'image/jpeg');

    // Verify Content-Length was NOT set manually (Change #6)
    const headerCalls = setRequestHeaderMock.mock.calls.map((call) => call[0].toLowerCase());
    expect(headerCalls).not.toContain('content-length');

    // Simulate progress events
    if (onprogressCallback) {
      onprogressCallback({ lengthComputable: true, loaded: 50, total: 100 });
      onprogressCallback({ lengthComputable: true, loaded: 100, total: 100 });
    }

    // Simulate completion
    mockXHR.onload();
    await uploadPromise;

    expect(progressReports).toEqual([50, 100]);
    expect(sendMock).toHaveBeenCalledWith(mockFile);

    vi.unstubAllGlobals();
  });

  it('rejects with error when upload returns non-2xx status', async () => {
    const mockFile = new File(['content'], 'error.png', { type: 'image/png' });
    const mockXHR = {
      open: vi.fn(),
      setRequestHeader: vi.fn(),
      send: vi.fn(),
      upload: {},
      status: 403,
      set onload(fn) {
        this._onload = fn;
      },
      get onload() {
        return this._onload;
      },
    };

    vi.stubGlobal('XMLHttpRequest', vi.fn(() => mockXHR));

    const uploadPromise = uploadFileWithProgress({
      uploadUrl: 'https://s3.local/bucket/error.png',
      file: mockFile,
    });

    mockXHR.onload();
    await expect(uploadPromise).rejects.toThrow(/Upload failed with HTTP status 403/);

    vi.unstubAllGlobals();
  });
});
