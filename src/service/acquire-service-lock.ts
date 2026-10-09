import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { FFIType, dlopen, read } from "bun:ffi";
import { processStartIdOrThrow } from "../process/identify-process.js";

const LOCK_EX = 2;
const LOCK_NB = 4;

export interface ServiceLockMetadataV1 {
  readonly version: 1;
  readonly pid: number;
  readonly startIdentity: string;
  readonly bootId: string;
  readonly acquiredAt: string;
}

export interface ServiceLock {
  readonly metadata: ServiceLockMetadataV1;
  release(): void;
}

export class ServiceOwnershipConflict extends Error {
  readonly code = "service_owner_conflict";

  constructor(readonly lockPath: string) {
    super(`another Workshop service owns ${lockPath}`);
    this.name = "ServiceOwnershipConflict";
  }
}

export class ServiceOwnershipError extends Error {
  readonly code = "service_ownership_unavailable";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ServiceOwnershipError";
  }
}

/** Hold a kernel flock on a persistent inode; never unlink the lock path. */
export function acquireServiceLock(lockPath: string): ServiceLock {
  const flock = loadFlock(lockPath);
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new ServiceOwnershipError("this runtime cannot safely open the service lock with no-follow semantics");
  }

  let fd: number | undefined;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
    if (!fstatSync(fd).isFile()) {
      throw new ServiceOwnershipError(`service lock is not a regular file: ${lockPath}`);
    }
    if (flock.tryAcquire(fd) === false) {
      throw new ServiceOwnershipConflict(lockPath);
    }

    fchmodSync(fd, 0o600);
    const metadata: ServiceLockMetadataV1 = {
      version: 1,
      pid: process.pid,
      startIdentity: processStartIdOrThrow(process.pid),
      bootId: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${JSON.stringify(metadata)}\n`, "utf8");
    fsyncSync(fd);

    const heldFd = fd;
    fd = undefined;
    let released = false;
    return {
      metadata,
      release() {
        if (released) return;
        closeSync(heldFd);
        released = true;
      },
    };
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the ownership error; process exit also closes the descriptor.
      }
    }
    if (error instanceof ServiceOwnershipConflict || error instanceof ServiceOwnershipError) throw error;
    throw new ServiceOwnershipError(`cannot acquire service lock ${lockPath}`, { cause: error });
  }
}

function loadFlock(lockPath: string): { tryAcquire(fd: number): boolean } {
  try {
    return loadPlatformFlock(lockPath);
  } catch (error) {
    if (error instanceof ServiceOwnershipError) throw error;
    throw new ServiceOwnershipError(`kernel-held service ownership binding is unavailable on ${process.platform}`, { cause: error });
  }
}

function loadPlatformFlock(lockPath: string): { tryAcquire(fd: number): boolean } {
  if (process.platform === "darwin") {
    const { symbols } = dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    });
    return {
      tryAcquire(fd) {
        const result = symbols.flock(fd, LOCK_EX | LOCK_NB);
        if (result === 0) return true;
        const errno = symbols.__error();
        if (errno !== null && read.i32(errno) === 35) return false;
        throw new ServiceOwnershipError(`kernel flock failed for ${lockPath}`);
      },
    };
  }

  if (process.platform === "linux") {
    const { symbols } = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    return {
      tryAcquire(fd) {
        const result = symbols.flock(fd, LOCK_EX | LOCK_NB);
        if (result === 0) return true;
        const errno = symbols.__errno_location();
        if (errno !== null && read.i32(errno) === 11) return false;
        throw new ServiceOwnershipError(`kernel flock failed for ${lockPath}`);
      },
    };
  }

  throw new ServiceOwnershipError(`kernel-held service ownership is unsupported on ${process.platform}`);
}
