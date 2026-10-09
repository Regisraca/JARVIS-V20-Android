/** Phones and tablets: no always-on wake word, lighter 3D, tap to talk. */
export const IS_MOBILE =
  typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches))
