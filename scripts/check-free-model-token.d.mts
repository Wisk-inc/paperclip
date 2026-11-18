/** Types for check-free-model-token.mjs, for the TypeScript that imports it (server/src/__tests__/secret-leak-guards.test.ts). */

/** A run of this many characters of the token's signature counts as the token. */
export const SIGNATURE_RUN: number;

/** What a file must not hold of `token`: the token, its payload and signature whole, every SIGNATURE_RUN-character run of the signature, and the token base64'd. */
export function tokenNeedles(token: string): Buffer[];

/** Every regular file under the given paths; symbolic links are not followed. */
export function filesUnder(roots: readonly string[]): string[];

/** The files under `roots` that hold any of `needles`, and how many files were read. */
export function findToken(roots: readonly string[], needles: readonly Buffer[]): { checked: number; hits: string[] };

/** The token a request carries when no operator token is set; `load` imports the free-model module (the TypeScript source through tsx by default). */
export function readFreeModelToken(
  load?: () => Promise<{ freeModelAllowance(): Promise<unknown>; resetFreeModelAllowance?(): void }>,
): Promise<string>;

/** The command: checks `roots`, prints only file paths and counts, and resolves to the exit code. */
export function main(
  roots: readonly string[],
  options?: {
    load?: () => Promise<{ freeModelAllowance(): Promise<unknown>; resetFreeModelAllowance?(): void }>;
    log?: (line: string) => void;
    error?: (line: string) => void;
  },
): Promise<number>;
