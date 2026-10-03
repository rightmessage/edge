export const SOURCE_CAP = 1024 * 1024;
export const OUTPUT_CAP = 2 * SOURCE_CAP;

export async function boundedBytes(response: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new Error("Personalization buffer limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    // A tee's cancel promise waits for the other branch, which belongs to origin.
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
