import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { JwtVerifier } from "@famashines/ai-systems-kit/auth";
import { createService, ForbiddenError, UnauthorizedError } from "@famashines/ai-systems-kit/http";
import { createLogger } from "@famashines/ai-systems-kit/observability";
import { MongoNetworkError, type Collection } from "mongodb";
import { routes } from "../../src/adapters/http.ts";
import type { AuditEntry } from "../../src/domain/audit.ts";

const tokens: Record<string, JwtVerifier> = {
  owner: () => Promise.resolve({ sub: "owner-1", roles: ["owner"], exp: 0 }),
  guest: () => Promise.reject(new ForbiddenError("The role is missing")),
};
const verify: JwtVerifier = (token) =>
  (tokens[token] ?? (() => Promise.reject(new UnauthorizedError())))(token);
let reads = 0;
const audit = {
  find: () => {
    reads += 1;
    throw new MongoNetworkError("down");
  },
} as unknown as Collection<AuditEntry>;
const app = createService({
  logger: createLogger({ service: "audit-trace", release: "test", level: "silent" }),
  routes: routes({ audit, verify }),
  drainDelayMs: 0,
});
let base: string;

before(async () => {
  const { port } = await app.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${String(port)}`;
});

after(async () => {
  await app.close();
});

const get = (query: string, authorization: string | null = "Bearer owner") =>
  fetch(`${base}/internal/audit${query}`, {
    headers: authorization === null ? {} : { authorization },
  });

test("the audit read needs an owner token before it reads the query or the database", async () => {
  assert.equal((await get("?limit=0", null)).status, 401);
  assert.equal((await get("?limit=0", "Bearer guest")).status, 403);
  assert.equal(reads, 0);
});

test("the audit read refuses a query that is not valid", async () => {
  for (const query of ["?limit=0", "?limit=101", "?limit=x", "?before=zz"]) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.equal(reads, 0);
});

test("the audit read gives 503 when MongoDB does not answer", async () => {
  const response = await get("");
  assert.equal(response.status, 503);
  assert.equal(((await response.json()) as { code: string }).code, "unavailable");
});
