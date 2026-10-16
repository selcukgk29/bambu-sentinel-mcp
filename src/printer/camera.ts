import * as tls from "node:tls";
import { spawn } from "node:child_process";

/** Models that expose the JPEG-over-TLS stream on port 6000. Others use RTSP. */
const JPEG_MODELS = new Set(["A1", "A1 MINI", "P1P", "P1S"]);

/** Grab one JPEG frame from an A1/P1 camera (TLS port 6000). */
function grabJpegTls(host: string, accessCode: string, timeoutMs: number, port: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.alloc(80);
    auth.writeUInt32LE(0x40, 0);
    auth.writeUInt32LE(0x3000, 4);
    auth.write("bblp", 16, "ascii");
    auth.write(accessCode, 48, "ascii");

    const socket = tls.connect({ host, port, rejectUnauthorized: false });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, frame?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(frame!);
    };
    const timer = setTimeout(() => finish(new Error("camera timeout")), timeoutMs);

    socket.on("secureConnect", () => socket.write(auth));
    socket.on("error", (e) => finish(e));
    socket.on("close", () => finish(new Error("camera closed before a frame arrived")));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Frame = 16-byte header (uint32 LE payload size first) + JPEG payload.
      while (buf.length >= 16) {
        const size = buf.readUInt32LE(0);
        if (size > 8_000_000) return finish(new Error("bad camera frame header"));
        if (buf.length < 16 + size) return;
        const payload = buf.subarray(16, 16 + size);
        buf = buf.subarray(16 + size);
        if (payload[0] === 0xff && payload[1] === 0xd8 && payload.at(-2) === 0xff && payload.at(-1) === 0xd9)
          return finish(null, Buffer.from(payload));
      }
    });
  });
}

/** X1/H2 cameras: one frame over RTSP through ffmpeg (must be installed). */
function grabJpegRtsp(host: string, accessCode: string, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-loglevel", "error", "-rtsp_transport", "tcp", "-i", `rtsps://bblp:${accessCode}@${host}:322/streaming/live/1`, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => ff.kill(), timeoutMs);
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("error", () => reject(new Error("ffmpeg not found; install it for RTSP cameras")));
    ff.on("close", () => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      out.length ? resolve(out) : reject(new Error("no frame from RTSP stream"));
    });
  });
}

export function grabSnapshot(host: string, accessCode: string, model: string, timeoutMs = 10_000, port = 6000): Promise<Buffer> {
  return JPEG_MODELS.has(model.toUpperCase().trim())
    ? grabJpegTls(host, accessCode, timeoutMs, port)
    : grabJpegRtsp(host, accessCode, timeoutMs);
}
