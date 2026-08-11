// Panel pixels to page pixels.
//
// This is where a live view goes silently wrong: a click that lands 30px off
// is far harder to diagnose later than one that does nothing at all, so the
// mapping lives here as a pure function with its own tests rather than inline
// in a React handler where nothing can exercise it.
//
// `rect` must be the rect of the drawn image, not of its container — the
// panel therefore renders the <img> at its natural aspect ratio (width-fit,
// height auto) rather than letterboxing it with object-contain, so the two
// are the same box. `frame` is the page's own coordinate space: the CSS
// viewport reported by the screencast when one is running, and the decoded
// frame size otherwise.
//
// A zero-size rect or frame happens during the first layout pass and before
// the first frame decodes; returning the origin beats emitting NaN into CDP,
// which Chrome answers with an error rather than a no-op.
export interface ToPageCoordinatesArgs {
  clientX: number;
  clientY: number;
  rect: { left: number; top: number; width: number; height: number };
  frame: { width: number; height: number };
}

export function toPageCoordinates(args: ToPageCoordinatesArgs): { x: number; y: number } {
  if (args.rect.width <= 0 || args.rect.height <= 0) return { x: 0, y: 0 };
  if (args.frame.width <= 0 || args.frame.height <= 0) return { x: 0, y: 0 };

  // Per axis, not one shared factor: the panel's aspect ratio and the page's
  // are independent, and a single factor is off by the difference.
  const scaleX = args.frame.width / args.rect.width;
  const scaleY = args.frame.height / args.rect.height;
  const x = (args.clientX - args.rect.left) * scaleX;
  const y = (args.clientY - args.rect.top) * scaleY;

  // Clamped, because a drag can leave the image while the button is still
  // down and a coordinate outside the viewport means nothing to the page.
  return {
    x: Math.round(Math.min(Math.max(x, 0), args.frame.width)),
    y: Math.round(Math.min(Math.max(y, 0), args.frame.height)),
  };
}
