from fastapi import FastAPI, Query
from langchain_community.llms import Ollama
from langchain_community.vectorstores import Qdrant
from langchain_community.embeddings import SentenceTransformerEmbeddings
from qdrant_client import QdrantClient
from langchain_core.prompts import PromptTemplate
from langchain_core.runnables import RunnableParallel, RunnablePassthrough
import os

app = FastAPI(title="RAG API with Ollama & Qdrant")

# --- Qdrant config ---
QDRANT_URL = "http://qdrant:6333"
COLLECTION_NAME = "documents"

qdrant_client = QdrantClient(url=QDRANT_URL)
embeddings = SentenceTransformerEmbeddings(model_name="all-MiniLM-L6-v2")
vectorstore = Qdrant(
    client=qdrant_client,
    collection_name=COLLECTION_NAME,
    embeddings=embeddings
)
retriever = vectorstore.as_retriever(search_type="similarity", search_kwargs={"k": 3})

# --- Ollama LLM ---
llm = Ollama(
    model=os.getenv("OLLAMA_MODEL", "llama3")
)
# --- Prompt template ---
prompt = PromptTemplate.from_template(
    "Voici des extraits pertinents :\n{context}\n\nQuestion : {question}\nRéponse :"
)

# --- RAG chain moderne ---
rag_chain = (
    RunnableParallel({"context": retriever, "question": RunnablePassthrough()})
    | prompt
    | llm
)

# --- Endpoint /query ---
@app.get("/query")
def query_api(q: str = Query(..., description="Votre question")):
    response = rag_chain.invoke(q, max_tokens=200)
    return {"question": q, "response": response}
