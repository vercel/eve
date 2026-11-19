"""Python tools exposed to the eve agent.

Each endpoint here is wrapped by a `defineTool` file in `agent/tools/`. Keep the
Pydantic models in sync with the zod schemas there.
"""

import math
import re
import statistics
from collections import Counter
from typing import Annotated

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

router = APIRouter(prefix="/tools", tags=["tools"])


class StatsRequest(BaseModel):
    numbers: list[Annotated[float, Field(allow_inf_nan=False)]] = Field(
        min_length=1, max_length=10_000
    )


class StatsResponse(BaseModel):
    count: int
    sum: float
    mean: float
    median: float
    modes: list[float]
    min: float
    max: float
    range: float
    stdev: float | None = Field(description="Sample standard deviation; null for one value.")
    variance: float | None = Field(description="Sample variance; null for one value.")
    quartiles: list[float] | None = Field(description="Q1, Q2, Q3; null for one value.")


@router.post("/stats", response_model=StatsResponse)
def compute_stats(body: StatsRequest) -> StatsResponse:
    numbers = body.numbers
    many = len(numbers) > 1
    try:
        result = StatsResponse(
            count=len(numbers),
            sum=sum(numbers),
            mean=statistics.fmean(numbers),
            median=statistics.median(numbers),
            modes=statistics.multimode(numbers),
            min=min(numbers),
            max=max(numbers),
            range=max(numbers) - min(numbers),
            stdev=statistics.stdev(numbers) if many else None,
            variance=statistics.variance(numbers) if many else None,
            quartiles=statistics.quantiles(numbers, n=4, method="inclusive") if many else None,
        )
    except OverflowError:
        result = None
    # Finite inputs can still overflow (e.g. summing values near 1e308); JSON can't
    # carry inf/NaN, so report it as a validation error instead of a 500 or null.
    if result is None or not _all_finite(result.model_dump()):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Statistics overflow the range of a float; use smaller numbers.",
        )
    return result


def _all_finite(value: object) -> bool:
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, dict):
        return all(_all_finite(v) for v in value.values())
    if isinstance(value, list):
        return all(_all_finite(v) for v in value)
    return True


class AnalyzeTextRequest(BaseModel):
    text: str = Field(min_length=1, max_length=100_000)
    top_n: int = Field(default=10, ge=1, le=50)


class WordCount(BaseModel):
    word: str
    count: int


class AnalyzeTextResponse(BaseModel):
    characters: int
    characters_no_spaces: int
    words: int
    unique_words: int
    sentences: int
    paragraphs: int
    average_word_length: float
    reading_time_minutes: float
    flesch_reading_ease: float
    top_words: list[WordCount]


WORD_RE = re.compile(r"[A-Za-z0-9']+")
SENTENCE_RE = re.compile(r"[^.!?]+[.!?]*")
VOWEL_GROUP_RE = re.compile(r"[aeiouy]+")
WORDS_PER_MINUTE = 238
_STOPWORDS_TEXT = (
    "a an and are as at be but by for from has have he her his i if in is it its of on or "
    "our she so that the their them they this to was we were what when which who will with "
    "you your"
)
STOPWORDS = frozenset(_STOPWORDS_TEXT.split())


def _syllables(word: str) -> int:
    word = word.lower()
    count = len(VOWEL_GROUP_RE.findall(word))
    if word.endswith("e") and count > 1:
        count -= 1
    return max(count, 1)


@router.post("/analyze-text", response_model=AnalyzeTextResponse)
def analyze_text(body: AnalyzeTextRequest) -> AnalyzeTextResponse:
    text = body.text
    words = WORD_RE.findall(text)
    lowered = [w.lower() for w in words]
    sentences = [s for s in SENTENCE_RE.findall(text) if WORD_RE.search(s)]
    paragraphs = [p for p in re.split(r"\n\s*\n", text) if p.strip()]

    word_count = len(words)
    sentence_count = max(len(sentences), 1)
    syllable_count = sum(_syllables(w) for w in words)
    flesch = (
        206.835 - 1.015 * (word_count / sentence_count) - 84.6 * (syllable_count / word_count)
        if word_count
        else 0.0
    )
    top = Counter(w for w in lowered if w not in STOPWORDS).most_common(body.top_n)

    return AnalyzeTextResponse(
        characters=len(text),
        characters_no_spaces=len(re.sub(r"\s", "", text)),
        words=word_count,
        unique_words=len(set(lowered)),
        sentences=len(sentences),
        paragraphs=len(paragraphs),
        average_word_length=round(sum(len(w) for w in words) / word_count, 2) if word_count else 0,
        reading_time_minutes=round(word_count / WORDS_PER_MINUTE, 2),
        flesch_reading_ease=round(flesch, 1),
        top_words=[WordCount(word=w, count=c) for w, c in top],
    )
