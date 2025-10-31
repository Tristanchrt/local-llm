import express from "express";
import dotenv from "dotenv";
import ollama from "ollama";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline } from "@xenova/transformers";
import bodyParser from "body-parser";
import crypto from "crypto";
import pLimit from "p-limit";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// --- Middleware pour ID de requête ---
app.use((req, res, next) => {
  (req as any).id = crypto.randomUUID();
  next();
});

// --- Middleware logs ---
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = (req as any).id;
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] [${requestId}] ${req.method} ${req.originalUrl} ${res.statusCode} - ${duration}ms`);
  });
  next();
});

const createLogger = (requestId?: string) => (message: string) => {
  const base = `[${new Date().toISOString()}]`;
  const reqIdPart = requestId ? ` [${requestId}]` : "";
  console.log(`${base}${reqIdPart} ${message}`);
};

const PORT = process.env.PORT || 3000;
const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const COLLECTION_NAME = "documents";
const qdrantClient = new QdrantClient({ url: QDRANT_URL });
const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });

// --- Limiter pour les appels Ollama ---
const ollamaLimit = pLimit(5);

// --- Cosine similarity ---
function cosineSimilarity(a: number[], b: number[]) {
  if (!a || !b || a.length !== b.length) return 0;
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v*v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v*v, 0));
  return dot / (normA * normB);
}

// --- Embed query ---
async function embedQuery(text: string, log: (message: string) => void = console.log): Promise<number[] | null> {
  try {
    const start = Date.now();
    const result = await embedder(text, { pooling: "mean", normalize: true });
    log(`Embedding took ${Date.now() - start}ms`);
    return result?.data ? Array.from(result.data) : null;
  } catch (e) {
    console.error("Error embedding query:", e);
    return null;
  }
}

// --- Reranking ---
function rerankChunks(questionVector: number[], chunks: any[], topK = 5, log: (message: string) => void = console.log) {
  const start = Date.now();
  const validChunks = chunks
    .filter(c => c.vector && c.vector.length === questionVector.length)
    .map(c => ({ ...c, score: cosineSimilarity(questionVector, c.vector) }));
  validChunks.sort((a, b) => b.score - a.score);
  const result = validChunks.slice(0, topK);
  log(`Reranking took ${Date.now() - start}ms`);
  return result;
}

// --- Condensation ---
async function condenseChunks(chunks: { text: string, source?: string }[], log: (message: string) => void): Promise<string> {
  if (chunks.length <= 5) {
    log(`Condensation skipped for ${chunks.length} chunks`);
    return chunks.map(c => `Source ${c.source}:\n${c.text}`).join("\n\n");
  }
  return ollamaLimit(async () => {
    const start = Date.now();
    const prompt = `
      Résume les extraits suivants en un texte concis et clair,
      en gardant les informations importantes et en citant les sources.

      ${chunks.map(c => `Source ${c.source}:\n${c.text}`).join("\n\n")}

      Résumé :
    `;
    const response = await ollama.chat({
      model: process.env.OLLAMA_MODEL || "llama2:7b",
      messages: [{ role: "user", content: prompt }],
    });
    log(`Condensation with LLM took ${Date.now() - start}ms`);
    return response.message.content;
  });
}

// --- TopK documents ---
async function getTopKDocuments(question: string, topK = 5, log: (message: string) => void = console.log) {
  const vector = await embedQuery(question, log);
  if (!vector) return "";

  const start = Date.now();
  const searchResult = await qdrantClient.search(COLLECTION_NAME, {
    vector,
    limit: 20,
    with_vector: true,
  });
  log(`Qdrant search took ${Date.now() - start}ms`);

  const reranked = rerankChunks(vector, searchResult, topK, log);
  const context = await condenseChunks(
    reranked.map(r => ({ text: r.payload.text, source: r.payload.source })),
    log
  );
  return context;
}

// --- Endpoint /query ---
app.get("/query", async (req, res) => {
  const question = req.query.q as string;
  const requestId = (req as any).id;
  const log = createLogger(requestId);

  if (!question) return res.status(400).json({ error: "Missing query parameter 'q'" });

  try {
    const startContext = Date.now();
    const context = await getTopKDocuments(question, 5, log);
    log(`Context retrieval took ${Date.now() - startContext}ms`);

    const prompt = `
      Tu es un assistant expert.
      Réponds uniquement à partir des extraits fournis.
      Ne fabrique jamais d'informations.
      Présente la réponse de manière claire et structurée.
      Cite la source de chaque information si possible.

      Extraits pertinents :
      ${context}

      Question : ${question}

      Réponse :
    `;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();

    // --- Streaming concurrent direct ---
    const startOllama = Date.now();
    const stream = await ollamaLimit(() => ollama.chat({
      model: process.env.OLLAMA_MODEL || "llama2:7b",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }));

    let firstChunk = true;
    for await (const chunk of stream) {
      if (firstChunk) {
        log(`Time to first chunk from LLM: ${Date.now() - startOllama}ms`);
        firstChunk = false;
      }
      if (chunk.message?.content) {
        res.write(`data: ${chunk.message.content}\n\n`);
        await new Promise(resolve => setImmediate(resolve)); 
      }
    }
    log(`Full LLM response stream took ${Date.now() - startOllama}ms`);

    res.write("event: end\ndata: \n\n");
    res.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`RAG API running on http://localhost:${PORT}`);
});
