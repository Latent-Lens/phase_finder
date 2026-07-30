export const FILE_DIGEST_ALGORITHM = 'SHA-256-CHUNKED-1M-v1';
export const FILE_DIGEST_CHUNK_BYTES = 1024 * 1024;

function abort_error() {
  return new DOMException('File verification was cancelled.', 'AbortError');
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// A bounded-memory content identity: SHA-256 each fixed 1 MiB chunk, then
// SHA-256 the ordered chunk hashes. Fixed chunking makes the result independent
// of browser stream boundaries while retaining only 32 bytes per chunk.
export async function digest_file_chunks(file, options = {}) {
  const { signal, on_progress, consume_chunk } = options;
  const chunk_hashes = [];
  const total = file.size;
  for (let offset = 0; offset < total || (total === 0 && offset === 0); offset += FILE_DIGEST_CHUNK_BYTES) {
    if (signal?.aborted) throw abort_error();
    const end = Math.min(total, offset + FILE_DIGEST_CHUNK_BYTES);
    const buffer = await file.slice(offset, end).arrayBuffer();
    if (signal?.aborted) throw abort_error();
    chunk_hashes.push(await crypto.subtle.digest('SHA-256', buffer));
    if (consume_chunk) await consume_chunk(buffer, offset);
    on_progress?.({ bytes_done: end, bytes_total: total });
    if (total === 0) break;
  }
  const tree = new Uint8Array(chunk_hashes.length * 32);
  chunk_hashes.forEach((hash, index) => tree.set(new Uint8Array(hash), index * 32));
  return {
    digest_algorithm: FILE_DIGEST_ALGORITHM,
    digest: hex(await crypto.subtle.digest('SHA-256', tree)),
  };
}

export function digest_file(file, options = {}) {
  return digest_file_chunks(file, options);
}
