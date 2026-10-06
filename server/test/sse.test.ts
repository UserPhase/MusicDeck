import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { SseEventWriter } from "../src/utils/sse.js";

class SlowResponse extends EventEmitter {
  readonly writes: string[] = [];
  destroyed = false;
  writableEnded = false;
  write = vi.fn((frame: string) => {
    this.writes.push(frame);
    return false;
  });
  end = vi.fn(() => { this.writableEnded = true; });
}

describe("SseEventWriter", () => {
  test("buffers events during backpressure and flushes on drain", () => {
    const response = new SlowResponse();
    const writer = new SseEventWriter(response as never, 4, 10_000);

    writer.push("connected", { connected: true });
    writer.push("acquisition.progress", { jobId: "job-1", percent: 10 });
    writer.push("acquisition.progress", { jobId: "job-1", percent: 20 });
    writer.push("acquisition.completed", { jobId: "job-1" });
    expect(response.writes).toHaveLength(1);

    response.write.mockImplementation((frame) => {
      response.writes.push(frame);
      return true;
    });
    response.emit("drain");

    expect(response.writes).toHaveLength(3);
    expect(response.writes[1]).toContain('"percent":20');
    expect(response.writes[2]).toContain("acquisition.completed");
    response.emit("close");
  });

  test("coalesces pending progress frames and closes when status events exceed the cap", () => {
    const response = new SlowResponse();
    const writer = new SseEventWriter(response as never, 100, 10_000);

    writer.push("connected", { connected: true });
    for (let index = 0; index < 100; index += 1) {
      writer.push("acquisition.completed", { jobId: `job-${index}` });
    }
    expect(response.end).not.toHaveBeenCalled();

    writer.push("acquisition.failed", { jobId: "overflow" });
    expect(response.end).toHaveBeenCalledOnce();
  });
});
