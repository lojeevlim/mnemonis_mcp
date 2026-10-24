import { DomainError } from "../domain/index.js";
import { StoreError } from "../store/fileStore.js";

export interface ErrorInfo {
  code: string;
  message: string;
}

/** Structured, client-safe error. Unknown errors are masked (no stack traces, no file paths). */
export function toErrorInfo(e: unknown): ErrorInfo {
  if (e instanceof DomainError) return { code: e.code, message: e.message };
  if (e instanceof StoreError && e.code === "conflict") return { code: "conflict", message: e.message };
  if (e instanceof StoreError && e.code === "corrupt") return { code: "invalid_input", message: e.message };
  return { code: "internal", message: "Internal error" };
}
