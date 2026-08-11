import { describe, expect, it } from "vitest";
import { toPageCoordinates } from "./panel-geometry.js";

const frame = { width: 1280, height: 800 };

describe("toPageCoordinates", () => {
  it("maps a click at the origin to the page origin", () => {
    expect(
      toPageCoordinates({
        clientX: 100, clientY: 50,
        rect: { left: 100, top: 50, width: 640, height: 400 },
        frame,
      }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("scales a half-size panel by two", () => {
    expect(
      toPageCoordinates({
        clientX: 420, clientY: 250,
        rect: { left: 100, top: 50, width: 640, height: 400 },
        frame,
      }),
    ).toEqual({ x: 640, y: 400 });
  });

  it("clamps a click outside the panel to the page bounds", () => {
    expect(
      toPageCoordinates({
        clientX: 5000, clientY: 5000,
        rect: { left: 0, top: 0, width: 640, height: 400 },
        frame,
      }),
    ).toEqual({ x: 1280, y: 800 });
  });

  it("returns the origin rather than NaN for a zero-size panel", () => {
    expect(
      toPageCoordinates({
        clientX: 10, clientY: 10,
        rect: { left: 0, top: 0, width: 0, height: 0 },
        frame,
      }),
    ).toEqual({ x: 0, y: 0 });
  });

  // The three below are not in the brief. Each one is a way a live view goes
  // wrong by 30 pixels rather than visibly breaking, which is the failure
  // this module exists to make impossible.

  it("returns the origin rather than NaN for a frame with no size yet", () => {
    // naturalWidth/naturalHeight are 0 until the <img> has decoded its
    // first frame, and a click can land in that window.
    expect(
      toPageCoordinates({
        clientX: 200, clientY: 100,
        rect: { left: 0, top: 0, width: 640, height: 400 },
        frame: { width: 0, height: 0 },
      }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("clamps a click above and left of the panel to the page origin", () => {
    expect(
      toPageCoordinates({
        clientX: -40, clientY: -10,
        rect: { left: 0, top: 0, width: 640, height: 400 },
        frame,
      }),
    ).toEqual({ x: 0, y: 0 });
  });

  it("scales each axis independently when the panel's aspect differs from the page's", () => {
    // 640x800 panel against a 1280x800 page: x halves, y is 1:1. A single
    // shared scale factor would put this click 200px off vertically.
    expect(
      toPageCoordinates({
        clientX: 320, clientY: 200,
        rect: { left: 0, top: 0, width: 640, height: 800 },
        frame,
      }),
    ).toEqual({ x: 640, y: 200 });
  });
});
