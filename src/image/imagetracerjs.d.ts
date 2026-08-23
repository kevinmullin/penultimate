/** Minimal ambient typing for imagetracerjs — no @types package exists upstream. */
declare module 'imagetracerjs' {
  export type ImageTracerOptions = {
    ltres?: number
    qtres?: number
    pathomit?: number
    rightangleenhance?: boolean
    colorsampling?: number
    numberofcolors?: number
    mincolorratio?: number
    colorquantcycles?: number
    layering?: number
    strokewidth?: number
    linefilter?: boolean
    scale?: number
    roundcoords?: number
    viewbox?: boolean
    desc?: boolean
    blurradius?: number
    blurdelta?: number
    pal?: Array<{ r: number; g: number; b: number; a: number }>
  }

  type ImageTracerStatic = {
    imagedataToSVG(imageData: ImageData, options?: ImageTracerOptions): string
  }

  const ImageTracer: ImageTracerStatic
  export default ImageTracer
}
