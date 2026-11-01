import { bearerHook, type JwtVerifier } from "@famashines/ai-systems-kit/auth";
import { UnavailableError, validate, type Route } from "@famashines/ai-systems-kit/http";
import { isInfrastructure } from "@famashines/ai-systems-kit/messaging";
import type { Collection } from "mongodb";
import { z } from "zod";
import { readPage } from "../application/audit.ts";
import type { AuditEntry } from "../domain/audit.ts";

const AuditQuery = z.object({
  limit: z.string().regex(/^\d+$/).default("50").transform(Number).pipe(z.int().min(1).max(100)),
  before: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
});

export function toHttpError(error: unknown): unknown {
  if (isInfrastructure(error)) return new UnavailableError("The database is not available");
  return error;
}

export interface HttpDeps {
  audit: Collection<AuditEntry>;
  verify: JwtVerifier;
}

export function routes({ audit, verify }: HttpDeps): Route[] {
  const owner = bearerHook(verify);
  return [
    {
      method: "GET",
      path: "/internal/audit",
      handler: async (request) => {
        await owner(request);
        const { query } = await validate(request, { query: AuditQuery });
        try {
          return { body: await readPage(audit, query) };
        } catch (error) {
          throw toHttpError(error);
        }
      },
    },
  ];
}
