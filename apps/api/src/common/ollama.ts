/**
 * How long Ollama keeps a model resident after a request.
 *
 * An import is a burst of calls seconds apart, so unloading between chunks
 * would mean reloading gigabytes from disk each time. Holding the model past
 * the burst costs real memory though: on the 8GB server a 7B model resident
 * takes available RAM from 6.2GB down to 1.3GB and pushes several gigabytes
 * into swap, on a machine that also runs Postgres.
 *
 * Two minutes is long enough that no import ever reloads mid-run, and short
 * enough that the box is back to normal shortly after one finishes.
 */
export const OLLAMA_KEEP_ALIVE = '2m';
