import time
import uuid
from dataclasses import dataclass, field

from app.prompts import SYSTEM_PROMPT

END_CALL_TOKEN = "<END_CALL>"
OPENER = "Hi, this is Anish calling from Nexbizio — do you have a quick minute?"

# Safety net: ignore the model's <END_CALL> until the caller has actually engaged
# this many turns. Prevents the agent from hanging up on the first user reply.
MIN_USER_TURNS_BEFORE_END = 4


@dataclass
class Session:
    id: str
    messages: list[dict] = field(default_factory=list)
    user_turns: int = 0
    ended: bool = False

    def history_for_llm(self) -> list[dict]:
        # Strip the ts key — provider APIs reject unknown message fields.
        return [
            {"role": "system", "content": SYSTEM_PROMPT},
            *({"role": m["role"], "content": m["content"]} for m in self.messages),
        ]

    def append_user(self, text: str) -> None:
        self.messages.append({"role": "user", "content": text, "ts": time.time()})
        self.user_turns += 1

    def append_assistant(self, text: str) -> None:
        self.messages.append({"role": "assistant", "content": text, "ts": time.time()})

    def can_end(self) -> bool:
        return self.user_turns >= MIN_USER_TURNS_BEFORE_END


_sessions: dict[str, Session] = {}


def new_session() -> Session:
    sid = uuid.uuid4().hex
    s = Session(id=sid)
    s.append_assistant(OPENER)
    _sessions[sid] = s
    return s


def get_session(sid: str) -> Session | None:
    return _sessions.get(sid)


def drop_session(sid: str) -> None:
    _sessions.pop(sid, None)


def strip_end_token(text: str) -> tuple[str, bool]:
    """Return (clean_text, ended)."""
    if END_CALL_TOKEN in text:
        return text.replace(END_CALL_TOKEN, "").strip(), True
    return text, False


_SENTENCE_TERMINATORS = ".!?\n"


def split_sentences(buffer: str) -> tuple[list[str], str]:
    """Split a streamed text buffer into complete sentences + a leftover tail.

    A 'sentence' here is a chunk ending in . ! ? or newline. Keeps the terminator.
    Used to flush text to TTS as soon as a sentence is ready, rather than waiting
    for the full LLM response.
    """
    sentences: list[str] = []
    start = 0
    for i, ch in enumerate(buffer):
        if ch in _SENTENCE_TERMINATORS:
            piece = buffer[start : i + 1].strip()
            if piece:
                sentences.append(piece)
            start = i + 1
    return sentences, buffer[start:]
