import { parseEvent } from "@famashines/ai-systems-contracts";
import { createJwtVerifier } from "@famashines/ai-systems-kit/auth";
import { commonEnv, loadConfig } from "@famashines/ai-systems-kit/config";
import { createService } from "@famashines/ai-systems-kit/http";
import { connectNats, startConsumer } from "@famashines/ai-systems-kit/messaging";
import { connectMongo } from "@famashines/ai-systems-kit/mongo";
import { createLogger, startTelemetry } from "@famashines/ai-systems-kit/observability";
import { trace } from "@opentelemetry/api";
import { z } from "zod";
import { routes } from "./adapters/http.ts";
import { auditOf, checkAuditIndex, recorder } from "./application/audit.ts";

export const service = "audit-trace";

export const streams = {
  ORCHESTRATION: "orchestration.>",
  CONVERSATION: "conversation.>",
  BUDGET: "budget.>",
  AGENTS: "agents.>",
  PROMPTS: "prompts.>",
} as const;

const httpUrl = z.url({ protocol: /^https?$/ });

export const envSchema = commonEnv.omit({ SERVICE_NAME: true }).extend({
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).default("audit_trace"),
  NATS_SERVERS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(",")
        .map((server) => server.trim())
        .filter((server) => server !== ""),
    )
    .pipe(z.array(z.string()).min(1)),
  NATS_USER: z.string().min(1),
  NATS_PASSWORD: z.string().min(1),
  OIDC_ISSUER: httpUrl.default("https://auth.famashines.com/realms/ai-systems"),
  OIDC_JWKS_URL: httpUrl.optional(),
  OIDC_AUDIENCE: z.string().min(1).default("ai-systems-app"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.url().optional(),
});

export type Config = z.output<typeof envSchema>;

export async function start(config: Readonly<Config>, options: { drainDelayMs?: number } = {}) {
  const release = config.RELEASE;
  const telemetry = startTelemetry({ serviceName: service, release });
  const logger = createLogger({ service, release, level: config.LOG_LEVEL });
  logger.info("connecting to MongoDB");
  const mongo = await connectMongo({
    url: config.MONGODB_URI,
    database: config.MONGODB_DATABASE,
    clientOptions: { serverSelectionTimeoutMS: 5000 },
  });
  const audit = auditOf(mongo.db);
  await checkAuditIndex(audit);
  logger.info("connecting to NATS");
  const nats = await connectNats({
    servers: config.NATS_SERVERS,
    user: config.NATS_USER,
    pass: config.NATS_PASSWORD,
    service,
    logger,
  });
  const record = recorder(audit, trace.getTracer(service, release));
  const consumers = Object.entries(streams).map(([stream, filter]) => ({
    stream,
    consumer: startConsumer({
      nats,
      db: mongo.db,
      stream,
      filter,
      parse: parseEvent,
      handler: record,
    }),
  }));
  const verify = createJwtVerifier({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    requiredRole: "owner",
    ...(config.OIDC_JWKS_URL === undefined ? {} : { jwksUrl: config.OIDC_JWKS_URL }),
    logger,
  });
  const app = createService({
    logger,
    routes: routes({ audit, verify }),
    readiness: {
      mongo: mongo.ready,
      nats: nats.ready,
      ...Object.fromEntries(
        consumers.map(({ stream, consumer }) => [`consumer-${stream}`, consumer.ready]),
      ),
    },
    metrics: telemetry.metricsHandler,
    closeHooks: [
      telemetry.shutdown,
      mongo.close,
      nats.close,
      ...consumers.map(({ consumer }) => consumer.close),
    ],
    ...options,
  });
  const address = await app.listen(config.PORT);
  logger.info({ port: address.port }, "audit-trace started");
  return { app, address };
}

if (import.meta.main) {
  const exitEarly = (): never => process.exit(143);
  process.once("SIGTERM", exitEarly);
  process.once("SIGINT", exitEarly);
  const { app } = await start(loadConfig(envSchema));
  process.off("SIGTERM", exitEarly);
  process.off("SIGINT", exitEarly);
  app.handleSignals();
}
