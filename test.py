from langchain.llms import Ollama
import os

llm = Ollama(
    model=os.getenv("OLLAMA_MODEL", "llama3")
)

response = llm("Écris un haïku sur le café")
print(response)
