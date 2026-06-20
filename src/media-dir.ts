import path from 'node:path';

/** WhatsApp media cache dir under the host-provided shared data root. The
 *  connector namespaces under its own id so connectors never collide. */
export function mediaDir(dataRoot: string): string {
  return path.join(dataRoot, 'whatsapp', 'media');
}
