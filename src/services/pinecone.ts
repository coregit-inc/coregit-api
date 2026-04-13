/**
 * Pinecone REST API client for vector operations.
 * Pure fetch() — no SDK dependency.
 *
 * TODO: Replace Pinecone with Turbopuffer at scale (100K+ repos).
 * Pinecone Serverless limits 100K namespaces/index — one namespace per repo
 * hits this wall at 100K repos. Turbopuffer has no namespace limit (Notion
 * runs 10B+ vectors on it), S3-native storage ($0.02/GB vs $0.33/GB).
 * See turbopuffer.com — API is similar, migration is straightforward.
 */

const UPSERT_BATCH_SIZE = 100;

export interface VectorMetadata {
  file_path: string;
  blob_sha: string;
  start_line: number;
  end_line: number;
  language: string;
  chunk_index: number;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: VectorMetadata;
}

export interface QueryMatch {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

function pineconeUrl(host: string, path: string): string {
  return `https://${host}${path}`;
}

function pineconeHeaders(apiKey: string): Record<string, string> {
  return {
    "Api-Key": apiKey,
    "Content-Type": "application/json",
  };
}

/**
 * Upsert vectors into a Pinecone namespace.
 * Auto-batches into groups of 100.
 */
export async function upsertVectors(
  host: string,
  apiKey: string,
  namespace: string,
  vectors: VectorRecord[]
): Promise<void> {
  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    const batch = vectors.slice(i, i + UPSERT_BATCH_SIZE);
    const res = await fetch(pineconeUrl(host, "/vectors/upsert"), {
      method: "POST",
      headers: pineconeHeaders(apiKey),
      body: JSON.stringify({
        vectors: batch,
        namespace,
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Pinecone upsert failed (${res.status}): ${errorBody}`);
    }
  }
}

/**
 * Query vectors by similarity.
 */
export async function queryVectors(
  host: string,
  apiKey: string,
  namespace: string,
  vector: number[],
  topK: number,
  filter?: Record<string, unknown>
): Promise<QueryMatch[]> {
  const body: Record<string, unknown> = {
    vector,
    topK,
    namespace,
    includeMetadata: true,
  };
  if (filter) body.filter = filter;

  const res = await fetch(pineconeUrl(host, "/query"), {
    method: "POST",
    headers: pineconeHeaders(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Pinecone query failed (${res.status}): ${errorBody}`);
  }

  const data = (await res.json()) as {
    matches: Array<{
      id: string;
      score: number;
      metadata: VectorMetadata;
    }>;
  };

  return data.matches || [];
}

/**
 * Delete all vectors with a given ID prefix in a namespace.
 * Uses pagination loop (Pinecone list returns max 100 IDs per page).
 */
export async function deleteByPrefix(
  host: string,
  apiKey: string,
  namespace: string,
  prefix: string
): Promise<void> {
  const allIds: string[] = [];
  let paginationToken: string | undefined;

  // Collect all IDs matching prefix
  do {
    const params = new URLSearchParams({
      prefix,
      namespace,
      limit: "100",
    });
    if (paginationToken) params.set("paginationToken", paginationToken);

    const res = await fetch(
      pineconeUrl(host, `/vectors/list?${params.toString()}`),
      {
        method: "GET",
        headers: pineconeHeaders(apiKey),
      }
    );

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(
        `Pinecone list failed (${res.status}): ${errorBody}`
      );
    }

    const data = (await res.json()) as {
      vectors?: Array<{ id: string }>;
      pagination?: { next: string };
    };

    if (data.vectors) {
      for (const v of data.vectors) allIds.push(v.id);
    }

    paginationToken = data.pagination?.next;
  } while (paginationToken);

  // Delete in batches of 1000
  for (let i = 0; i < allIds.length; i += 1000) {
    const batch = allIds.slice(i, i + 1000);
    const res = await fetch(pineconeUrl(host, "/vectors/delete"), {
      method: "POST",
      headers: pineconeHeaders(apiKey),
      body: JSON.stringify({ ids: batch, namespace }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(
        `Pinecone delete failed (${res.status}): ${errorBody}`
      );
    }
  }
}

/**
 * Check which vector IDs exist in a namespace.
 * Pinecone fetch limit: 100 IDs per request → batched automatically.
 */
export async function vectorsExist(
  host: string,
  apiKey: string,
  namespace: string,
  ids: string[]
): Promise<Set<string>> {
  const existing = new Set<string>();
  const FETCH_BATCH = 100;

  for (let i = 0; i < ids.length; i += FETCH_BATCH) {
    const batch = ids.slice(i, i + FETCH_BATCH);
    const params = new URLSearchParams();
    for (const id of batch) params.append("ids", id);
    params.set("namespace", namespace);

    const res = await fetch(
      pineconeUrl(host, `/vectors/fetch?${params.toString()}`),
      { method: "GET", headers: pineconeHeaders(apiKey) }
    );

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Pinecone fetch failed (${res.status}): ${errorBody}`);
    }

    const data = (await res.json()) as {
      vectors: Record<string, unknown>;
    };

    if (data.vectors) {
      for (const id of Object.keys(data.vectors)) {
        existing.add(id);
      }
    }
  }

  return existing;
}

/**
 * Delete an entire namespace (all vectors).
 */
export async function deleteNamespace(
  host: string,
  apiKey: string,
  namespace: string
): Promise<void> {
  const res = await fetch(pineconeUrl(host, "/vectors/delete"), {
    method: "POST",
    headers: pineconeHeaders(apiKey),
    body: JSON.stringify({ deleteAll: true, namespace }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(
      `Pinecone deleteNamespace failed (${res.status}): ${errorBody}`
    );
  }
}
