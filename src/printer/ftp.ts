import { Client } from "basic-ftp";
import * as path from "node:path";

export interface RemoteFile {
  name: string;
  size: number;
  date: string;
  type: "file" | "directory";
}

async function withFtp<T>(host: string, accessCode: string, port: number, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client(30_000);
  try {
    await client.access({
      host,
      port,
      user: "bblp",
      password: accessCode,
      secure: "implicit",
      secureOptions: { rejectUnauthorized: false },
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

export const listFiles = (host: string, code: string, dir = "/", port = 990) =>
  withFtp(host, code, port, async (c): Promise<RemoteFile[]> =>
    (await c.list(dir)).map((f) => ({
      name: f.name,
      size: f.size,
      date: f.modifiedAt?.toISOString() ?? f.rawModifiedAt ?? "",
      type: f.isDirectory ? "directory" : "file",
    })),
  );

export const uploadFile = (host: string, code: string, local: string, remote?: string, port = 990) =>
  withFtp(host, code, port, async (c) => {
    const dest = remote ?? `/cache/${path.basename(local)}`;
    await c.ensureDir(path.posix.dirname(dest));
    await c.cd("/");
    await c.uploadFrom(local, dest);
    return dest;
  });

export const deleteFile = (host: string, code: string, remote: string, port = 990) =>
  withFtp(host, code, port, (c) => c.remove(remote));
