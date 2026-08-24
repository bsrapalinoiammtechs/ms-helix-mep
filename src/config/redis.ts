import IORedis from "ioredis";

/**
 * Conexión Redis compartida para BullMQ dentro de ESTA instancia de
 * ms-helix-mep (una organización). No se comparte entre organizaciones ni
 * con la infraestructura de Epistech -- cada organización sigue siendo un
 * stack docker-compose independiente, ahora con su propio contenedor Redis
 * al lado (ver docker-compose.yml, servicio `redis-helix-mep`).
 *
 * `maxRetriesPerRequest: null` es requerido por BullMQ para las conexiones
 * que hacen comandos bloqueantes (Worker/QueueEvents).
 */
export const redisConnection = new IORedis(
  process.env.REDIS_URL || "redis://redis-helix-mep:6379",
  { maxRetriesPerRequest: null },
);
