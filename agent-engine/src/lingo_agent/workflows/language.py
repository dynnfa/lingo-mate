"""Shared display names for explicit prompt language instructions."""


def language_name(language: str) -> str:
    name = {"zh-CN": "Simplified Chinese", "en": "English"}.get(language, language)
    return f"{name} ({language})"
