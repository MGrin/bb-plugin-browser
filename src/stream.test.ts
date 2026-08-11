import { describe, expect, it } from "vitest";
import { mjpegResponse } from "./stream.js";

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");

describe("mjpegResponse", () => {
  it("declares a multipart replace stream", () => {
    const response = mjpegResponse(async () => () => {});
    expect(response.headers.get("content-type")).toContain("multipart/x-mixed-replace");
    expect(response.headers.get("content-type")).toContain("boundary=");
  });

  it("writes each frame as its own part", async () => {
    let push: (frame: string) => void = () => {};
    const response = mjpegResponse(async (onFrame) => { push = onFrame; return () => {}; });
    const reader = response.body!.getReader();
    push(jpeg);
    const chunk = await reader.read();
    const text = Buffer.from(chunk.value!).toString("binary");
    expect(text).toContain("Content-Type: image/jpeg");
    expect(text).toContain("Content-Length: 4");
    await reader.cancel();
  });

  it("unsubscribes when the client goes away", async () => {
    let unsubscribed = false;
    const response = mjpegResponse(async () => () => { unsubscribed = true; });
    const reader = response.body!.getReader();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unsubscribed).toBe(true);
  });

  it("drops frames instead of queueing them for a slow client", async () => {
    let push: (frame: string) => void = () => {};
    const response = mjpegResponse(async (onFrame) => { push = onFrame; return () => {}; });
    const reader = response.body!.getReader();
    for (let index = 0; index < 50; index++) push(jpeg);
    const chunk = await reader.read();
    expect(chunk.value).toBeDefined();
    await reader.cancel();
  });

  it("unsubscribes if the client cancels while a frame is in flight", async () => {
    let unsubscribed = false;
    let push: (frame: string) => void = () => {};
    const response = mjpegResponse(async (onFrame) => {
      push = onFrame;
      return () => { unsubscribed = true; };
    });
    const reader = response.body!.getReader();
    await reader.cancel();
    push(jpeg); // a frame that arrives after cancel must not throw or re-subscribe
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unsubscribed).toBe(true);
  });
});
