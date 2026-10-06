/* Ported verbatim from Atelier (dashboard/src/ui/odylic/glassRim.worker.ts). */
/**
 * The rim worker: draws glass rims (glassRim.ts) off the main thread, so scrolling, dragging and clicking never wait
 * on them. It decodes the ground render once, then answers each job with one ImageBitmap per tile.
 */
import { drawRimTile, type RimJob, type Tile } from './glassRim'

type Job = { id: number; url: string; job: RimJob; tiles: Tile[] }
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

let art: { url: string; bitmap: Promise<ImageBitmap> } | null = null
function render(url: string): Promise<ImageBitmap> {
  if (!art || art.url !== url) {
    art = {
      url,
      bitmap: fetch(url).then(r => {
        if (!r.ok) throw new Error(`ground render: HTTP ${r.status}`)
        return r.blob()
      }).then(b => createImageBitmap(b)),
    }
  }
  return art.bitmap
}

const context = (w: number, h: number) =>
  new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true }) as unknown as CanvasRenderingContext2D | null

scope.onmessage = async e => {
  const { id, url, job, tiles } = e.data
  try {
    const img = await render(url)
    const out: Array<{ tile: Tile; bitmap: ImageBitmap }> = []
    for (const tile of tiles) {
      const data = drawRimTile(img, job, tile, context)
      const cv = new OffscreenCanvas(tile[2], tile[3])
      const ctx = cv.getContext('2d')
      if (!data || !ctx) throw new Error('no 2D context in the worker')
      ctx.putImageData(data, 0, 0)
      out.push({ tile, bitmap: cv.transferToImageBitmap() })
    }
    scope.postMessage({ id, out }, out.map(o => o.bitmap))
  } catch (err) {
    if (art && art.url === url) art = null // a failed fetch or decode is tried again by the next job
    scope.postMessage({ id, error: String(err) })
  }
}
