/**
 * Direct presigned S3/MinIO upload helper using XMLHttpRequest for progress tracking (Change #6).
 * Sends the File as the body directly and does not set Content-Length manually.
 *
 * @param {Object} options
 * @param {string} options.uploadUrl - Presigned PUT URL
 * @param {File} options.file - Browser File object
 * @param {(percent: number) => void} [options.onProgress] - Callback with percentage 0-100
 * @returns {Promise<void>}
 */
export function uploadFileWithProgress({ uploadUrl, file, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);

    // Set Content-Type only; browser sets Content-Length automatically for File/Blob bodies
    xhr.setRequestHeader('Content-Type', file.type);

    if (xhr.upload && onProgress) {
      xhr.upload.onprogress = (evt) => {
        if (evt.lengthComputable) {
          const percent = Math.round((evt.loaded / evt.total) * 100);
          onProgress(percent);
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with HTTP status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Network error during image upload'));
    xhr.onabort = () => reject(new Error('Image upload aborted'));

    xhr.send(file);
  });
}
