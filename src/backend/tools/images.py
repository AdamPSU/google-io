"""Image generator via Gemini Imagen. Pure function."""

from __future__ import annotations

import os

from google import genai
from google.genai import types

IMAGEN_MODEL = "imagen-4.0-generate-001"


def make_image(prompt: str, aspect_ratio: str = "1:1") -> bytes:
    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    response = client.models.generate_images(
        model=IMAGEN_MODEL,
        prompt=prompt,
        config=types.GenerateImagesConfig(
            number_of_images=1,
            aspect_ratio=aspect_ratio,
        ),
    )
    return response.generated_images[0].image.image_bytes
