import express from "express";
import dotenv from "dotenv";
import ollama from "ollama"; // pas de class Ollama, on utilise le client directement
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
    if (result && result.data) {
      return Array.from(result.data);
    }
    return null;
  } catch (e) {
    console.error(`Error embedding query: "${text}"`, e);
    return null;
  }
}

// --- Fonction pour récupérer les documents ---
async function getTopKDocuments(question: string, k = 3) {
  const vector = await embedQuery(question);
  if (!vector) {
    return ""; // Return empty context if embedding fails
  }

  const searchResult = await qdrantClient.search(COLLECTION_NAME, {
    vector,
    limit: k,
  });

  return searchResult.map((r: any) => r.payload.text).join("\n\n");
}

// --- Endpoint /query ---
app.get("/query", async (req, res) => {
  try {
    const question = req.query.q as string;
    if (!question) return res.status(400).json({ error: "Missing query parameter 'q'" });

    // Récupérer les extraits depuis Qdrant
    const context = await getTopKDocuments(question);

    // Construire le prompt
    const prompt = `Voici des extraits pertinents :\n${context}\n\nQuestion : ${question}\nRéponse :`;

    // Appel LLM Ollama
    const response = await ollama.chat({
      model: process.env.OLLAMA_MODEL || "llama3",
      messages: [{ role: "user", content: prompt }],
    });

    res.json({ question, response: response.message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => {
  console.log(`RAG API running on http://localhost:${PORT}`);
});
