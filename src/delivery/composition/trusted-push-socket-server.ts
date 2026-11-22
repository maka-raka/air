import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { TrustedPushBroker } from "../adapters/github/trusted-push-broker.js";
import { TrustedPushHttpHandler } from "./trusted-push-http-handler.js";

/**
 * Privileged broker transport. The socket directory must be owned by the
 * broker operator and inaccessible to untrusted agent containers.
 * Never publish this socket via a TCP proxy or mount it into an agent.
 */
const FileError = { NotFound: "ENOENT" } as const;

export class TrustedPushSocketServer {
  private server: Server | null = null;

  constructor(
    private readonly broker: TrustedPushBroker,
    private readonly socketPath: string,
  ) {}

  async start(): Promise<void> {
    if (this.server !== null) {
      throw new Error("broker listener already started");
    }
    const handler = new TrustedPushHttpHandler(this.broker);
    const server = createServer((request, response) => {
      void handler.handle(request, response);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      await chmod(this.socketPath, 0o600);
      this.server = server;
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    try {
      const info = await lstat(this.socketPath);
      if (info.isSocket()) await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== FileError.NotFound) {
        throw error;
      }
    }
  }
}
