import { env, listDurableObjectIds, runInDurableObject } from "cloudflare:test";

// Reads every row of every table in every Durable Object of the given
// namespaces. Only the invariant tests use this: their promises are about what
// is at rest, so what is at rest is what they must look at.

const ALL_NAMESPACES = [
  "IDENTITY_RECORDS",
  "CREDENTIAL_INDEX",
  "CHALLENGES",
  "MEMBER_NAMES",
  "CREDENTIAL_LABELS",
  "RATE_LIMITS",
  "CEREMONY_FAILURES",
  "OPERATOR_LOG",
] as const;

export type NamespaceName = (typeof ALL_NAMESPACES)[number];

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One text line per row, with every blob rendered as UTF-8, hex and base64url. */
export async function dumpDurableState(namespaces: readonly NamespaceName[] = ALL_NAMESPACES): Promise<string> {
  const lines: string[] = [];
  for (const name of namespaces) {
    const namespace = env[name] as DurableObjectNamespace;
    for (const id of await listDurableObjectIds(namespace)) {
      const rows = await runInDurableObject(namespace.get(id), (_instance, state) => {
        const out: string[] = [];
        const tables = state.storage.sql
          .exec<{ name: string; sql: string }>(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
          )
          .toArray();
        for (const table of tables) {
          out.push(`${name} schema ${table.sql}`);
          for (const row of state.storage.sql.exec(`SELECT * FROM "${table.name}"`)) {
            const cells = Object.entries(row).map(([column, value]) => {
              if (value instanceof ArrayBuffer) {
                const bytes = new Uint8Array(value);
                return `${column}=${new TextDecoder().decode(bytes)}|${hex(bytes)}|${base64url(bytes)}`;
              }
              return `${column}=${String(value)}`;
            });
            out.push(`${name} ${table.name} ${cells.join(" ")}`);
          }
        }
        return out;
      });
      lines.push(...rows);
    }
  }
  return lines.join("\n");
}
