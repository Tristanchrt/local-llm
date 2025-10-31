import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline, FeatureExtractionPipeline } from "@xenova/transformers";
import pLimit from "p-limit";

dotenv.config();

// --- CONFIG ---
const DATA_DIR = "./data";
const HASH_DB_PATH = "./hashes.json";
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "documents";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = parseInt(process.env.QDRANT_BATCH_SIZE || "64", 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || "4", 10);

// --- HELPER: Charger le hash DB existant ---
async function loadHashDb(): Promise<Record<string, string>> {
  try {
    const data = await fs.readFile(HASH_DB_PATH, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    // Si le fichier n'existe pas ou est vide
    return {};
  }
}

// --- HELPER: Initialiser Qdrant ---
async function initializeQdrant(client: QdrantClient) {
  const collections = (await client.getCollections()).collections.map(c => c.name);
  if (!collections.includes(COLLECTION_NAME)) {
    await client.recreateCollection(COLLECTION_NAME, {
      vectors: { size: 384, distance: "Cosine" },
    });
    console.log(`✅ Collection ${COLLECTION_NAME} created.`);
  }
}

// --- HELPER: Embed text, now more robust ---
async function embedText(
  text: string,
  embedder: FeatureExtractionPipeline,
): Promise<number[] | null> {
  try {
    // The output type can be complex, so we cast it carefully.
    const result = await embedder(text, { pooling: "mean", normalize: true });
    // result.data is a Float32Array, not a standard Array, so Array.isArray() was failing.
    if (result && result.data) {
      return Array.from(result.data);
    }
    return null;
  } catch (e) {
    console.error(`Error embedding text: "${text.substring(0, 40)}..."`, e);
    return null;
  }
}

// --- HELPER: Split text into chunks ---
function splitText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = [];
  if (!text) return chunks;

  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end);
    chunks.push(chunk);
    start += chunkSize - overlap;
  }
  return chunks;
}


// --- Main function ---
async function main() {
  console.log(`Using model: "${EMBEDDING_MODEL}".`);

  const [hashDb, qdrantClient] = await Promise.all([
    loadHashDb(),
    new QdrantClient({ url: QDRANT_URL }),
  ]);
  
  await initializeQdrant(qdrantClient);

  // Initialize embedder
  const embedder = await pipeline("feature-extraction", EMBEDDING_MODEL, { quantized: true });

  const allDocs: { id: string; vector: number[]; payload: any }[] = [];
  const limit = pLimit(CONCURRENCY);

  const files = await fs.readdir(DATA_DIR);

  for (const filename of files) {
    const filePath = path.join(DATA_DIR, filename);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) continue;
    
    console.log(`📄 Processing ${filename}...`);
    
    const text = await fs.readFile(filePath, "utf-8");
    const chunks = splitText(text);

    const chunkPromises = chunks.map(chunk => limit(async () => {
      if (!chunk.trim()) return; // Skip empty chunks

      const hash = crypto.createHash("md5").update(chunk).digest("hex");
      if (hashDb[hash]) return;

      const vector = await embedText(chunk, embedder);
      if (!vector || vector.length !== 384) {
        console.warn(`⚠️ Skipping chunk from ${filename}, vector is invalid.`);
        return;
      }

      allDocs.push({
        id: hash,
        vector,
        payload: { text: chunk, source: filename },
      });

      hashDb[hash] = filename;
    }));

    await Promise.all(chunkPromises);
  }

  if (allDocs.length > 0) {
    console.log(`Ingesting ${allDocs.length} new chunks into Qdrant...`);
    for (let i = 0; i < allDocs.length; i += BATCH_SIZE) {
      const batch = allDocs.slice(i, i + BATCH_SIZE);
      await qdrantClient.upsert(COLLECTION_NAME, { points: batch });
      console.log(`✅ Upserted ${Math.min(i + BATCH_SIZE, allDocs.length)}/${allDocs.length}`);
    }
  } else {
    console.log("ℹ️ No new chunks to ingest.");
  }

  await fs.writeFile(HASH_DB_PATH, JSON.stringify(hashDb, null, 2), "utf-8");
  console.log("✅ Hash DB saved.");
  console.log("🚀 Ingestion completed!");
}

main().catch(err => {
  console.error("❌ Critical Error:", err);
  process.exit(1);
});
