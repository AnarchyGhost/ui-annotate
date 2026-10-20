/**
 * Appends an SSE chunk with CRLF and CR line ends turned into LF. A trailing CR stays raw until the
 * next chunk shows whether an LF follows, so a CRLF split across chunks is not read as two line ends.
 */
export function appendNormalized(buffer: string, chunk: string): string {
  const joined = buffer + chunk;
  const keepCr = joined.endsWith("\r");
  const body = (keepCr ? joined.slice(0, -1) : joined).replace(/\r\n?/g, "\n");
  return keepCr ? `${body}\r` : body;
}
