/**
 * Fullscreen for the TV or projector view and the host screen (audit QOL-4).
 * The button stays hidden where the API is missing (iPhone Safari).
 */

export function fullscreenSupported(doc: Document = document): boolean {
  return typeof doc.documentElement.requestFullscreen === 'function' && doc.fullscreenEnabled !== false;
}

export function toggleFullscreen(doc: Document = document): Promise<void> {
  return doc.fullscreenElement ? doc.exitFullscreen() : doc.documentElement.requestFullscreen();
}
