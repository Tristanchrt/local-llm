import express from "express";
import dotenv from "dotenv";
import ollama from "ollama"; // client direct
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline } from "@xenova/transformers";
import bodyParser from "body-parser";
import crypto from "crypto";

dotenv.config();
const app = express();
app.use(bodyParser.json());

// Middleware pour ajouter un ID de requête unique
app.use((req, res, next) => {
  (req as any).id = crypto.randomUUID();
  next();
});

// Middleware pour logger les requêtes
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = (req as any).id;
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] [${requestId}] ${req.method} ${
        req.originalUrl
      } ${res.statusCode} - ${duration}ms`
    );
  });
  next();
});

const PORT = process.env.PORT || 3000;

// --- Qdrant config ---
const QDRANT_URL = "http://localhost:6333";
const COLLECTION_NAME = "documents";
const qdrantClient = new QdrantClient({ url: QDRANT_URL });

// --- Embeddings ---
const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });

// --- Cosine similarity ---
function cosineSimilarity(a: number[], b: number[]) {
  if (!a || !b || a.length !== b.length) return 0;
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v*v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v*v, 0));
  return dot / (normA * normB);
}

// --- Embed query ---
async function embedQuery(text: string): Promise<number[] | null> {
  try {
    const result = await embedder(text, { pooling: "mean", normalize: true });
    return result?.data ? Array.from(result.data) : null;
  } catch (e) {
    console.error("Error embedding query:", e);
    return null;
  }
}

// --- Reranking ---
function rerankChunks(questionVector: number[], chunks: any[], topK = 5) {
  const validChunks = chunks.filter(c => c.vector && c.vector.length === questionVector.length)
    .map(c => ({
      ...c,
      score: cosineSimilarity(questionVector, c.vector),
    }));
  validChunks.sort((a, b) => b.score - a.score);
  return validChunks.slice(0, topK);
}

// --- Condensation si trop de chunks ---
async function condenseChunks(chunks: { text: string, source?: string }[]): Promise<string> {
  if (chunks.length <= 5) {
    return chunks.map(c => `Source ${c.source}:\n${c.text}`).join("\n\n");
  }

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

  return response.message.content;
}

// --- Récupération des documents ---
async function getTopKDocuments(requestId: string, question: string, topK = 5) {
  console.time(`[${requestId}] getTopKDocuments`);
  console.time(`[${requestId}] embedQuery`);
  const vector = await embedQuery(question);
  console.timeEnd(`[${requestId}] embedQuery`);
  if (!vector) {
    console.timeEnd(`[${requestId}] getTopKDocuments`);
    return [];
  }

  // Recherche initiale
  console.time(`[${requestId}] Qdrant search`);
  const searchResult = await qdrantClient.search(COLLECTION_NAME, {
    vector,
    limit: 20,
    with_vector: true,
  });
  console.timeEnd(`[${requestId}] Qdrant search`);

  // Reranking
  console.time(`[${requestId}] Reranking`);
  const reranked = rerankChunks(vector, searchResult, topK);
  console.timeEnd(`[${requestId}] Reranking`);

  // Condensation
  console.time(`[${requestId}] Condensation`);
  const context = await condenseChunks(
    reranked.map((r) => ({ text: r.payload.text, source: r.payload.source }))
  );
  console.timeEnd(`[${requestId}] Condensation`);
  console.timeEnd(`[${requestId}] getTopKDocuments`);

  return context;
}

// --- Endpoint /query ---
app.get("/query", async (req, res) => {
  const question = req.query.q as string;
  const requestId = (req as any).id;
  if (!question)
    return res.status(400).json({ error: "Missing query parameter 'q'" });

  try {
    const context = await getTopKDocuments(requestId, question);

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

    console.time(`[${requestId}] ollama.chat stream`);
    const stream = await ollama.chat({
      model: process.env.OLLAMA_MODEL || "llama2:7b",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });
    console.timeEnd(`[${requestId}] ollama.chat stream`);

    for await (const chunk of stream) {
      if (chunk.message?.content) {
        res.write(`data: ${chunk.message.content}\n\n`);
      }
    }
    console.timeEnd(`[${requestId}] ollama.chat stream`);

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
