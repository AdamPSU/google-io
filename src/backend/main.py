from fastapi import FastAPI

app = FastAPI(title="google-io backend")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, str]:
    return {"message": "hello from google-io backend"}
