import express from "express";
import dotenv from "dotenv";
import ollama from "ollama"; // client direct
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline } from "@xenova/transformers";
import bodyParser from "body-parser";

dotenv.config();
const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

// --- Qdrant config ---
const QDRANT_URL = "http://localhost:6333";
const COLLECTION_NAME = "documents";

const qdrantClient = new QdrantClient({ url: QDRANT_URL });

// --- Embeddings ---
const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { quantized: true });

async function embedQuery(text: string): Promise<number[] | null> {
  try {
    const result = await embedder(text, { pooling: "mean", normalize: true });
    return result?.data ? Array.from(result.data) : null;
  } catch (e) {
    console.error("Error embedding query:", e);
    return null;
  }
}

// --- Cosine similarity ---
function cosineSimilarity(a: number[], b: number[]) {
  if (!a || !b || a.length !== b.length) return 0;
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, v) => sum + v*v, 0));
  const normB = Math.sqrt(b.reduce((sum, v) => sum + v*v, 0));
  return dot / (normA * normB);
}


// --- Reranking ---
async function rerankChunks(questionVector: number[], chunks: any[], topK = 5) {
  chunks.forEach(c => c.score = cosineSimilarity(questionVector, c.vector));
  chunks.sort((a, b) => b.score - a.score);
  return chunks.slice(0, topK);
}

// --- Condensation ---
async function condenseChunks(chunks: string[]): Promise<string> {
  if (chunks.length <= 5) return chunks.join("\n\n");

  const prompt = `
    Résume les extraits suivants en un texte concis et clair
    en gardant les informations importantes et en citant les sources :

    ${chunks.join("\n\n")}

    Résumé :
  `;

  const response = await ollama.chat({
    model: process.env.OLLAMA_MODEL || "llama2:7b",
    messages: [{ role: "user", content: prompt }],
  });

  return response.message.content;
}

// --- Récupération + reranking + condensation ---
async function getTopKDocuments(question: string, topK = 5) {
  const vector = await embedQuery(question);
  if (!vector) return [];

  // Recherche initiale
  const searchResult = await qdrantClient.search(COLLECTION_NAME, {
    vector,
    limit: 20, // récupère plus pour reranker
    with_vector: true
  });

  // Reranking
  const reranked = await rerankChunks(vector, searchResult, topK);

  // Condensation si nécessaire
  const texts = reranked.map(r => r.payload.text);
  const context = await condenseChunks(texts);

  return context;
}

// --- Endpoint /query ---
app.get("/query", async (req, res) => {
  const question = req.query.q as string;
  if (!question) return res.status(400).json({ error: "Missing query parameter 'q'" });

  try {
    const context = await getTopKDocuments(question);

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

    const stream = await ollama.chat({
      model: process.env.OLLAMA_MODEL || "llama2:7b",
      messages: [{ role: "user", content: prompt }],
      stream: true,
    });

    for await (const chunk of stream) {
      if (chunk.message?.content) {
        res.write(`data: ${chunk.message.content}\n\n`);
      }
    }

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
