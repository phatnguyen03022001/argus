import { spawnSync } from "node:child_process";
import type { CredentialReference } from "./credentials";

export type CredentialAvailability = "AVAILABLE" | "UNAVAILABLE";

export interface CredentialOperationContext {
  operation: string;
}

export interface CredentialResolutionResult {
  credentialReferenceId: string;
  operation: string;
  availability: CredentialAvailability;
}

export interface CredentialSecretAdapter {
  consume(
    reference: Pick<CredentialReference, "id" | "keychainService" | "keychainAccount">,
    consumer: (secret: Uint8Array) => void,
  ): CredentialAvailability;
}

export class CredentialResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

class ConsumerFailure extends Error {}

function requireOperation(value: string): string {
  const operation = value.trim();
  if (!operation || operation.length > 160 || /[\u0000-\u001f\u007f]/u.test(operation)) {
    throw new CredentialResolutionError("Credential operation context is invalid.");
  }
  return operation;
}

function validLocatorPart(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0
    && normalized.length <= 255
    && !/[\u0000-\u001f\u007f]/u.test(normalized);
}

export class MacOSKeychainAdapter implements CredentialSecretAdapter {
  constructor(private readonly options: { keychainPath?: string } = {}) {}

  consume(
    reference: Pick<CredentialReference, "id" | "keychainService" | "keychainAccount">,
    consumer: (secret: Uint8Array) => void,
  ): CredentialAvailability {
    if (process.platform !== "darwin") return "UNAVAILABLE";
    if (!validLocatorPart(reference.keychainService) || !validLocatorPart(reference.keychainAccount)) {
      return "UNAVAILABLE";
    }

    const args = [
      "find-generic-password",
      "-a",
      reference.keychainAccount,
      "-s",
      reference.keychainService,
      "-w",
    ];
    if (this.options.keychainPath) args.push(this.options.keychainPath);

    const result = spawnSync("/usr/bin/security", args, {
      encoding: null,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
      if (Buffer.isBuffer(result.stdout)) result.stdout.fill(0);
      if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
      return "UNAVAILABLE";
    }

    const stdout = result.stdout;
    const length = stdout.length > 0 && stdout[stdout.length - 1] === 0x0a ? stdout.length - 1 : stdout.length;
    const secret = Buffer.from(stdout.subarray(0, length));
    try {
      consumer(secret);
    } finally {
      secret.fill(0);
      stdout.fill(0);
      if (Buffer.isBuffer(result.stderr)) result.stderr.fill(0);
    }
    return "AVAILABLE";
  }
}

export function withCredentialSecret(
  reference: CredentialReference,
  context: CredentialOperationContext,
  consumer: (secret: Uint8Array) => void,
  adapter: CredentialSecretAdapter = new MacOSKeychainAdapter(),
): CredentialResolutionResult {
  const operation = requireOperation(context.operation);
  let availability: CredentialAvailability;
  try {
    availability = adapter.consume(reference, (secret) => {
      try {
        consumer(secret);
      } catch {
        throw new ConsumerFailure();
      }
    });
  } catch (error) {
    if (error instanceof ConsumerFailure) {
      throw new CredentialResolutionError("Credential consumer failed.");
    }
    return {
      credentialReferenceId: reference.id,
      operation,
      availability: "UNAVAILABLE",
    };
  }

  return {
    credentialReferenceId: reference.id,
    operation,
    availability,
  };
}

export function checkCredentialAvailability(
  reference: CredentialReference,
  context: CredentialOperationContext,
  adapter: CredentialSecretAdapter = new MacOSKeychainAdapter(),
): CredentialResolutionResult {
  return withCredentialSecret(reference, context, () => undefined, adapter);
}
