import { open, lstat } from "node:fs/promises";

/**
 * Untrusted bundle admission guard. This is a size/header preflight only:
 * it does NOT verify pack objects, commits, signatures, or authorizations.
 * The trusted broker must import into a quarantined repository and perform
 * independent Git verification before publishing any objects.
 */
export class GitBundleIngressGuard {
  private static readonly Header = Buffer.from("# v2 git bundle\n");
  private static readonly HeaderV3 = Buffer.from("# v3 git bundle\n");
  private static readonly MaxBytes = 32 * 1024 * 1024;

  async inspect(path: string): Promise<boolean> {
    const info = await lstat(path);
    if (!info.isFile()) return false;
    if (info.nlink !== 1) return false;
    if (info.size <= GitBundleIngressGuard.Header.length) return false;
    if (info.size > GitBundleIngressGuard.MaxBytes) return false;
    const file = await open(path, "r");
    try {
      const infoAtOpen = await file.stat();
      if (!infoAtOpen.isFile()) return false;
      if (infoAtOpen.ino !== info.ino || infoAtOpen.dev !== info.dev) {
        return false;
      }
      if (infoAtOpen.size !== info.size) return false;
      const bytes = Buffer.alloc(GitBundleIngressGuard.Header.length);
      const result = await file.read(bytes, 0, bytes.length, 0);
      if (result.bytesRead !== bytes.length) return false;
      return (
        bytes.equals(GitBundleIngressGuard.Header) ||
        bytes.equals(GitBundleIngressGuard.HeaderV3)
      );
    } finally {
      await file.close();
    }
  }
}
