import os
import json
from hashlib import md5
from qdrant_client import QdrantClient
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_qdrant import Qdrant
from langchain_community.document_loaders import TextLoader
from langchain_classic.embeddings import CacheBackedEmbeddings
from langchain_classic.storage import LocalFileStore
from qdrant_client.models import VectorParams, Distance

# --- CONFIG ---
DATA_DIR = "./data"             # dossier contenant tes fichiers à ingérer
HASH_DB_PATH = "./hashes.json"  # fichier local pour stocker les hashes
EMB_CACHE_DIR = "./emb_cache"   # dossier pour le cache des embeddings
QDRANT_URL = "http://qdrant:6333"
COLLECTION_NAME = "documents"

# --- Charger le hash DB existant ---
if os.path.exists(HASH_DB_PATH):
    with open(HASH_DB_PATH, "r") as f:
        hash_db = json.load(f)
else:
    hash_db = {}

# --- Initialiser Qdrant ---
qdrant_client = QdrantClient(url=QDRANT_URL)

# Créer la collection si elle n'existe pas
collections = [c.name for c in qdrant_client.get_collections().collections]
if COLLECTION_NAME not in collections:
    qdrant_client.recreate_collection(
        collection_name=COLLECTION_NAME,
        vectors_config=VectorParams(size=384, distance=Distance.COSINE)
    )

# --- Initialiser les embeddings + cache ---
base_embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")
cache_store = LocalFileStore(EMB_CACHE_DIR)
cached_embeddings = CacheBackedEmbeddings.from_bytes_store(
    base_embeddings,
    cache_store,
    namespace="embeddings_cache"
)

# --- Initialiser le vectorstore ---
vectorstore = Qdrant(
    client=qdrant_client,
    collection_name=COLLECTION_NAME,
    embeddings=cached_embeddings
)

# --- Parcourir les fichiers et créer les documents ---
all_docs = []
for filename in os.listdir(DATA_DIR):
    path = os.path.join(DATA_DIR, filename)
    if not os.path.isfile(path):
        continue

    loader = TextLoader(path)
    docs = loader.load()

    # Ajouter metadata
    for d in docs:
        d.metadata["source"] = filename

    # Split long documents
    splitter = RecursiveCharacterTextSplitter(chunk_size=500, chunk_overlap=50)
    chunks = splitter.split_documents(docs)

    # Vérifier hash pour ingestion incrémentale
    new_chunks = []
    for c in chunks:
        chunk_hash = md5(c.page_content.encode("utf-8")).hexdigest()
        if chunk_hash not in hash_db:
            hash_db[chunk_hash] = filename
            new_chunks.append(c)

    all_docs.extend(new_chunks)

# --- Ajouter les nouveaux chunks à Qdrant ---
if all_docs:
    vectorstore.add_documents(all_docs)
    print(f"✅ Ingested {len(all_docs)} new chunks into Qdrant.")
else:
    print("ℹ️ No new chunks to ingest.")

# --- Sauvegarder la hash DB ---
with open(HASH_DB_PATH, "w") as f:
    json.dump(hash_db, f, indent=2)

print("🚀 Ingestion terminée avec succès !")
